#!/usr/bin/env python3
"""llama.cpp oracle for Email Chatter 2.0 AI engine verification.

Starts LM Studio's bundled ``llama-server.exe`` as a *background child process*
(Python subprocess, terminated on exit — never relies on the calling shell
staying alive) and exposes the reference implementations of:

* tokenization  — ``POST /tokenize``   (GPT-2 byte-level BPE, same as GGUF)
* greedy text   — ``POST /completion`` with ``temperature=0,
  cache_prompt=false`` (no sampling, same prompt -> reference token sequence)
* chat template — ``POST /apply-template`` (for building the §6.3 title prompt)

It is meant to be used two ways:

1. As a library by other verification scripts::

       from ref_llama import LlamaOracle
       with LlamaOracle() as oracle:
           ids = oracle.tokenize("你好，world!\n")
           out = oracle.generate(prompt, n_predict=8)

2. As a CLI oracle that other members (cpp-ai / node-ai) can diff against::

       python tools/ref_llama.py tokenize --text "你好，world!"
       python tools/ref_llama.py generate --prompt-file prompt.txt --n-predict 8
       python tools/ref_llama.py suite --out tests/tmp/oracle_suite.json
       python tools/ref_llama.py compare --candidate tests/tmp/cpp_tokens.json

All human-readable logs go to stderr; stdout carries exactly one JSON object so
callers can parse it.  The server is always stopped in a ``finally`` / atexit
handler, so no stray llama-server process is left behind.

Spec: FEATURE-SPEC.md §8 "AI 引擎验证资产".
"""
import argparse
import atexit
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

# Windows consoles/PowerShell may default to cp1252/cp936; force UTF-8 so the
# JSON we print (Chinese text) is always portable.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# ---------------------------------------------------------------- constants --
LLAMA_SERVER = (r'C:\Users\splay\.lmstudio\extensions\backends'
                r'\llama.cpp-win-x86_64-avx2-2.23.1\llama-server.exe')
MODEL_Q8 = (r'C:\Users\splay\.lmstudio\models\lmstudio-community'
            r'\Qwen2.5-1.5B-Instruct-GGUF\Qwen2.5-1.5B-Instruct-Q8_0.gguf')
# Q4_K_M reference: different architecture (Qwen3.5-4B), so it can only be used
# to sanity-check GGUF parsing / Q4_K dequantization, not for generation diff.
MODEL_Q4K = (r'C:\Users\splay\.lmstudio\models\lmstudio-community'
             r'\Qwen3.5-4B-GGUF\Qwen3.5-4B-Q4_K_M.gguf')
DEFAULT_PORT = 25390
DEFAULT_CTX = 2048
DEFAULT_THREADS = 4

# Title prompt from FEATURE-SPEC.md §6.3 (must match both engines byte-for-byte).
TITLE_SYSTEM = ('你是一个邮件主题生成助手。根据用户消息生成一个简洁、准确、不夸张的中文邮件主题，'
                '不超过20个字；只输出主题本身，不要引号、不要"标题："前缀、不要解释、不要句号。')
TITLE_SUFFIX = '<|im_end|>\n<|im_start|>assistant\n'


def title_prompt(text, limit=600):
    """Build the §6.3 raw prompt (UTF-8 truncate to 600 chars)."""
    text = text[:limit]
    return ('<|im_start|>system\n' + TITLE_SYSTEM + '<|im_end|>\n'
            '<|im_start|>user\n' + text + TITLE_SUFFIX)


# ------------------------------------------------------------- HTTP helpers --
def _http_json(url, body=None, timeout=180):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method='POST' if data is not None else 'GET',
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def _http_status(url, timeout=3):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        try:
            payload = e.read().decode('utf-8', 'replace')
        except Exception:
            payload = ''
        return e.code, payload
    except Exception as e:  # connection refused etc.
        return None, str(e)


def free_port(preferred=0):
    """Return a free TCP port on 127.0.0.1 (preferred if it is free)."""
    if preferred:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(('127.0.0.1', preferred))
            s.close()
            return preferred
        except OSError:
            pass
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class LlamaOracle:
    """llama-server child process wrapper (tokenize / greedy generate / template)."""

    def __init__(self, model=None, port=0, ctx=DEFAULT_CTX, threads=DEFAULT_THREADS,
                 startup_timeout=300, server_exe=None, log_path=None, verbose=False):
        self.model = os.path.abspath(model or MODEL_Q8)
        self.server_exe = os.path.abspath(server_exe or LLAMA_SERVER)
        self.requested_port = port or DEFAULT_PORT
        self.ctx = ctx
        self.threads = threads
        self.startup_timeout = startup_timeout
        self.verbose = verbose
        self.proc = None
        self.port = None
        self._log_path = log_path
        self._log = None
        self._started_at = 0.0
        atexit.register(self.stop)

    # ----- lifecycle -------------------------------------------------------
    def log(self, msg):
        if self.verbose:
            print(f'[ref_llama] {msg}', file=sys.stderr, flush=True)

    def start(self):
        if self.proc is not None and self.proc.poll() is None:
            return self
        for path, what in ((self.server_exe, 'llama-server.exe'), (self.model, 'model gguf')):
            if not os.path.isfile(path):
                raise FileNotFoundError(f'{what} not found: {path}')
        self.port = free_port(self.requested_port)
        if not self._log_path:
            self._log_path = os.path.join(tempfile.gettempdir(), f'ref_llama_{self.port}.log')
        self._log = open(self._log_path, 'wb')
        cmd = [self.server_exe, '-m', self.model, '--host', '127.0.0.1',
               '--port', str(self.port), '-c', str(self.ctx), '-t', str(self.threads)]
        self.log('starting: ' + ' '.join(cmd))
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        self._started_at = time.time()
        self.proc = subprocess.Popen(cmd, stdout=self._log, stderr=self._log,
                                     stdin=subprocess.DEVNULL, creationflags=flags,
                                     cwd=os.path.dirname(self.server_exe))
        self._wait_ready()
        self.log(f'llama-server ready on 127.0.0.1:{self.port} '
                 f'(load {time.time() - self._started_at:.1f}s)')
        return self

    def _wait_ready(self):
        url = f'http://127.0.0.1:{self.port}/health'
        deadline = time.time() + self.startup_timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError('llama-server exited during startup '
                                   f'(code {self.proc.returncode}):\n{self.log_tail()}')
            st, body = _http_status(url)
            if st == 200 and '"ok"' in body:
                return
            time.sleep(0.5)
        raise TimeoutError(f'llama-server not ready within {self.startup_timeout}s; log:\n{self.log_tail()}')

    def stop(self):
        proc, self.proc = self.proc, None
        if proc is not None and proc.poll() is None:
            self.log('stopping llama-server')
            try:
                proc.terminate()
                proc.wait(timeout=10)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        if self._log is not None:
            try:
                self._log.close()
            except Exception:
                pass
            self._log = None

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()
        return False

    def log_tail(self, n=30):
        if not os.path.isfile(self._log_path or ''):
            return '(no log)'
        try:
            with open(self._log_path, 'r', errors='replace') as f:
                lines = f.readlines()
            return ''.join(lines[-n:])
        except Exception:
            return '(log unreadable)'

    def _post(self, path, body, timeout=180):
        self.start()
        return _http_json(f'http://127.0.0.1:{self.port}{path}', body, timeout=timeout)

    # ----- reference operations -------------------------------------------
    def tokenize(self, text, add_special=False):
        """Reference token ids for ``text`` (GPT-2 byte-level BPE)."""
        r = self._post('/tokenize', {'content': text, 'add_special': bool(add_special)})
        return list(r.get('tokens') or [])

    def detokenize(self, ids):
        r = self._post('/detokenize', {'tokens': list(ids)})
        return r.get('content', '')

    def generate(self, prompt, n_predict=8, stop=None, timeout=180):
        """Greedy completion (temperature=0, cache_prompt=false).

        Returns dict with keys: content, tokens (generated ids), stop (bool),
        stop_type, model, n_prompt (if reported), timings (if reported).
        """
        body = {
            'prompt': prompt,
            'n_predict': int(n_predict),
            'temperature': 0.0,
            'top_k': 1,
            'top_p': 1.0,
            'min_p': 0.0,
            'repeat_penalty': 1.0,
            'cache_prompt': False,
            'stream': False,
            'return_tokens': True,  # llama-server includes generated token ids
        }
        if stop:
            body['stop'] = list(stop)
        r = self._post('/completion', body, timeout=timeout)
        out = {
            'content': r.get('content', ''),
            'tokens': list(r.get('tokens') or []),
            'stop': r.get('stop'),
            'stop_type': r.get('stop_type'),
            'n_prompt': (r.get('timings') or {}).get('prompt_n'),
            'n_decoded': (r.get('timings') or {}).get('predicted_n'),
        }
        if out['n_decoded'] is None:
            out['n_decoded'] = len(out['tokens'])
        return out

    def apply_template(self, messages, add_generation_prompt=True):
        r = self._post('/apply-template',
                       {'messages': messages, 'add_generation_prompt': bool(add_generation_prompt)})
        return r.get('prompt', '')

    def model_info(self):
        st, body = _http_status(f'http://127.0.0.1:{self.port}/props')
        if st == 200:
            try:
                return json.loads(body)
            except Exception:
                return {'raw': body}
        return {'raw': body}


# ------------------------------------------------------------- comparison --
def compare_token_lists(candidate, reference, name='tokens'):
    """Compare two token id lists; returns a JSON-able dict with first mismatch."""
    c = [int(x) for x in candidate]
    r = [int(x) for x in reference]
    n = min(len(c), len(r))
    first = next((i for i in range(n) if c[i] != r[i]), None)
    return {
        'name': name,
        'match': c == r,
        'length_match': len(c) == len(r),
        'candidate_len': len(c),
        'reference_len': len(r),
        'first_mismatch_index': first,
        'common_prefix': first if first is not None else n,
        'candidate': c,
        'reference': r,
    }


def suite(oracle, texts, prompts, n_predict):
    data = {'model': oracle.model, 'texts': [], 'generations': [], 'title_prompts': []}
    for t in texts:
        ids = oracle.tokenize(t)
        data['texts'].append({'text': t, 'tokens': ids,
                              'detokenized': oracle.detokenize(ids)})
    for p in prompts:
        g = oracle.generate(p, n_predict=n_predict)
        data['generations'].append({'prompt': p, **g})
    for t in texts:
        data['title_prompts'].append({'text': t, 'prompt': title_prompt(t)})
    return data


# ---------------------------------------------------------------- CLI -----
DEFAULT_TEXT_PROBES = [
    '你好，世界！',
    'Hello, world!',
    '中英文 mixed 标点，测试。',
    '第一行\n第二行',
    '  缩进和\t制表符  ',
    '😀 emoji 与数字 123',
    'email-chatter 消息',
    '这是一段比较长的中文文本，用来验证 GPT-2 byte-level BPE 分词是否与 llama.cpp 完全一致。',
]


def _pick_model(args):
    if args.model:
        return args.model
    return MODEL_Q4K if args.q4k else MODEL_Q8


def _add_common_options(p, suppress_defaults=False):
    """Add oracle options. Subparsers use SUPPRESS so they don't clobber values
    parsed before the subcommand (allows both `ref_llama.py -v selftest` and
    `ref_llama.py selftest -v`)."""
    d = (lambda v: argparse.SUPPRESS) if suppress_defaults else (lambda v: v)
    p.add_argument('--model', default=d(None), help='gguf path (default: Qwen2.5-1.5B Q8_0)')
    p.add_argument('--q4k', action='store_true', default=d(False),
                   help='use the local Q4_K_M reference gguf')
    p.add_argument('--port', type=int, default=d(0), help='preferred port (0 = any free port)')
    p.add_argument('--ctx', type=int, default=d(DEFAULT_CTX))
    p.add_argument('--threads', type=int, default=d(DEFAULT_THREADS))
    p.add_argument('--startup-timeout', type=float, default=d(300))
    p.add_argument('--n-predict', type=int, default=d(8))
    p.add_argument('--log-path', default=d(None))
    p.add_argument('-v', '--verbose', action='store_true', default=d(False))


def main(argv=None):
    ap = argparse.ArgumentParser(description='llama.cpp oracle (llama-server child process)')
    _add_common_options(ap)
    common = argparse.ArgumentParser(add_help=False)
    _add_common_options(common, suppress_defaults=True)

    sub = ap.add_subparsers(dest='cmd')

    p_tok = sub.add_parser('tokenize', parents=[common], help='reference token ids for a text')
    p_tok.add_argument('--text', default=None)
    p_tok.add_argument('--text-file', default=None, help='UTF-8 file (whole content)')
    p_tok.add_argument('--add-special', action='store_true')

    p_detok = sub.add_parser('detokenize', parents=[common], help='detokenize ids from JSON array')
    p_detok.add_argument('--tokens', required=True, help='JSON array of token ids')

    p_gen = sub.add_parser('generate', parents=[common], help='greedy completion for a raw prompt')
    p_gen.add_argument('--prompt', default=None)
    p_gen.add_argument('--prompt-file', default=None)
    p_gen.add_argument('--stop', action='append', default=None, help='stop sequence (repeatable)')

    p_apply = sub.add_parser('apply-template', parents=[common], help='apply the model chat template')
    p_apply.add_argument('--system', default=None)
    p_apply.add_argument('--user', required=True)

    p_suite = sub.add_parser('suite', parents=[common], help='run the standard tokenize/generate probe suite')
    p_suite.add_argument('--out', default=None)
    p_suite.add_argument('--texts-file', default=None, help='JSON array of texts (default probes)')
    p_suite.add_argument('--prompts-file', default=None, help='JSON array of raw prompts')

    p_cmp = sub.add_parser('compare', parents=[common], help='compare candidate tokens to the oracle')
    p_cmp.add_argument('--candidate', required=True,
                       help='JSON: array of token ids, or {"tokens": [...]}, or {"cases":[{"name","tokens"}]}')
    p_cmp.add_argument('--text', default=None, help='single text to tokenize when candidate is a bare array')

    p_check = sub.add_parser('selftest', parents=[common], help='sanity-check the oracle itself')

    args = ap.parse_args(argv)
    if not args.cmd:
        ap.print_help()
        return 2
    if not os.path.isfile(_pick_model(args)):
        print(json.dumps({'ok': False, 'error': f'model not found: {_pick_model(args)}'}, ensure_ascii=False))
        return 2

    oracle = LlamaOracle(model=_pick_model(args), port=args.port, ctx=args.ctx,
                         threads=args.threads, startup_timeout=args.startup_timeout,
                         log_path=args.log_path, verbose=args.verbose)
    try:
        oracle.start()
        if args.cmd == 'tokenize':
            if args.text_file:
                with open(args.text_file, 'r', encoding='utf-8', newline='') as f:
                    text = f.read()
            else:
                text = args.text if args.text is not None else ''
            ids = oracle.tokenize(text, add_special=args.add_special)
            print(json.dumps({'ok': True, 'text': text, 'tokens': ids,
                              'detokenized': oracle.detokenize(ids)},
                             ensure_ascii=False))
        elif args.cmd == 'detokenize':
            ids = json.loads(args.tokens)
            print(json.dumps({'ok': True, 'content': oracle.detokenize(ids)}, ensure_ascii=False))
        elif args.cmd == 'generate':
            if args.prompt_file:
                with open(args.prompt_file, 'r', encoding='utf-8', newline='') as f:
                    prompt = f.read()
            else:
                prompt = args.prompt if args.prompt is not None else ''
            g = oracle.generate(prompt, n_predict=args.n_predict, stop=args.stop)
            print(json.dumps({'ok': True, 'prompt': prompt, **g}, ensure_ascii=False))
        elif args.cmd == 'apply-template':
            msgs = []
            if args.system:
                msgs.append({'role': 'system', 'content': args.system})
            msgs.append({'role': 'user', 'content': args.user})
            print(json.dumps({'ok': True, 'prompt': oracle.apply_template(msgs)}, ensure_ascii=False))
        elif args.cmd == 'suite':
            texts = DEFAULT_TEXT_PROBES
            if args.texts_file:
                with open(args.texts_file, 'r', encoding='utf-8') as f:
                    texts = json.load(f)
            prompts = [title_prompt(t) for t in texts]
            if args.prompts_file:
                with open(args.prompts_file, 'r', encoding='utf-8') as f:
                    prompts = json.load(f)
            data = suite(oracle, texts, prompts, args.n_predict)
            payload = {'ok': True, 'server': {'port': oracle.port, 'model': oracle.model},
                       **data}
            if args.out:
                os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
                with open(args.out, 'w', encoding='utf-8') as f:
                    json.dump(payload, f, ensure_ascii=False, indent=1)
                payload['out'] = os.path.abspath(args.out)
            print(json.dumps(payload, ensure_ascii=False))
        elif args.cmd == 'compare':
            with open(args.candidate, 'r', encoding='utf-8') as f:
                cand = json.load(f)
            results = []
            if isinstance(cand, list):
                if args.text is None:
                    raise SystemExit('bare token array requires --text')
                ref = oracle.tokenize(args.text)
                results.append(compare_token_lists(cand, ref, name=args.text[:32]))
            elif isinstance(cand, dict) and 'cases' in cand:
                for case in cand['cases']:
                    if 'text' in case:
                        ref = oracle.tokenize(case['text'])
                    else:
                        ref = list(case.get('reference') or [])
                    results.append(compare_token_lists(case.get('tokens') or [], ref,
                                                       name=case.get('name', 'case')))
            else:
                toks = cand.get('tokens') if isinstance(cand, dict) else cand
                if args.text is None:
                    raise SystemExit('--text required when candidate has no text')
                ref = oracle.tokenize(args.text)
                results.append(compare_token_lists(toks, ref, name=args.text[:32]))
            ok = all(r['match'] for r in results)
            print(json.dumps({'ok': ok, 'results': results}, ensure_ascii=False, indent=1))
            return 0 if ok else 1
        elif args.cmd == 'selftest':
            t0 = time.time()
            tok = oracle.tokenize('你好，world!')
            detok = oracle.detokenize(tok)
            gen = oracle.generate(title_prompt('周六早上八点香山门口集合，别迟到！'), n_predict=8)
            ok = bool(tok) and detok == '你好，world!' and isinstance(gen['tokens'], list)
            print(json.dumps({'ok': ok, 'tokens': tok, 'detokenized': detok,
                              'generated': gen, 'elapsed_s': round(time.time() - t0, 2)},
                             ensure_ascii=False))
            return 0 if ok else 1
    finally:
        oracle.stop()
    return 0


if __name__ == '__main__':
    sys.exit(main())
