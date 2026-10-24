#!/usr/bin/env python3
"""Independent AI-engine comparison harness: candidate engine vs llama.cpp oracle.

Compares the C++/Node GGUF+Qwen2 engines against the reference llama.cpp
implementation (``tools/ref_llama.py`` starts LM Studio's llama-server as a
background child process):

* tokenizer: candidate token ids must equal llama.cpp ``/tokenize`` ids for a
  probe suite (Chinese/English/punctuation/newline/tab/emoji/long text);
* greedy generation: candidate token sequence vs llama.cpp ``/completion``
  (temperature=0, cache_prompt=false) for the §6.3 title prompt — the first
  8 tokens should match (llama.cpp float details may diverge later).

The harness never touches the network and never downloads models; it only
uses the local GGUF files from FEATURE-SPEC.md §8.

Usage::

    # Node engine (node-ai provides tools/node-ai-selftest.js)
    C:\\Users\\splay\\anaconda3\\python.exe tools\\ai_compare.py --engine node --suite all

    # C++ engine (cpp-ai provides an ai-selftest executable; --cpp-exe to point at it)
    python tools/ai_compare.py --engine cpp --cpp-exe build-ai/Release/ai-selftest.exe --suite all

    # custom candidate command templates (JSON argv arrays with {model}/{text}/{prompt}/{n})
    python tools/ai_compare.py --engine cmd \
        --tokenize-cmd '["my-tokenizer","{model}","{text}"]' \
        --generate-cmd '["my-gen","{model}","{prompt}","{n}"]' --suite all

Exit code: 0 if all comparisons pass, 1 on mismatches, 2 on harness errors.
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from ref_llama import (  # noqa: E402
    LlamaOracle, MODEL_Q8, DEFAULT_TEXT_PROBES, title_prompt,
)

NODE_EXE = os.environ.get('EC_NODE') or r'C:\Users\splay\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
NODE_SELFTEST = os.path.join(HERE, 'node-ai-selftest.js')
CPP_SELFTEST_CANDIDATES = [
    os.path.join(SRC, 'build-ai', 'Release', 'ai-selftest.exe'),
    os.path.join(SRC, 'build-ai', 'ai-selftest.exe'),
    os.path.join(SRC, 'build', 'Release', 'ai-selftest.exe'),
    os.path.join(SRC, 'build', 'ai-selftest.exe'),
]

EXTRA_TEXTS = [
    '换行\n在第一行中间',
    '第一行\n第二行\n第三行',
    '\t制表符\t开头',
    '句号。问号？感叹号！',
    "don't stop believing",
    '1234567890 数字串',
    '  hello   world  ',
    '中文English混合 mixed_content-123',
]

TOKENIZE_CASES = DEFAULT_TEXT_PROBES + EXTRA_TEXTS


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def parse_json_stdout(stdout):
    """Best-effort: parse the last JSON object line printed on stdout."""
    lines = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
    for ln in reversed(lines):
        if ln.startswith('{') or ln.startswith('['):
            try:
                return json.loads(ln)
            except Exception:
                continue
    raise ValueError('no JSON in stdout: ' + stdout[-500:])


class Candidate:
    """Adapter around a candidate engine selftest CLI."""

    def __init__(self, engine, model, cpp_exe=None, tokenize_cmd=None,
                 generate_cmd=None, timeout=900):
        self.engine = engine
        self.model = model
        self.timeout = timeout
        self.generate_uses_ids = False
        if engine == 'node':
            self.tokenize_argv = [NODE_EXE, NODE_SELFTEST, 'tokenize', '{model}', '{text}']
            self.generate_argv = [NODE_EXE, NODE_SELFTEST, 'generate', '{model}', '{prompt}', '{n}']
        elif engine == 'cpp':
            exe = cpp_exe
            if not exe:
                exe = next((p for p in CPP_SELFTEST_CANDIDATES if os.path.isfile(p)), None)
            if not exe or not os.path.isfile(exe):
                raise FileNotFoundError(
                    'C++ ai-selftest 未找到；用 --cpp-exe 指定（候选：' +
                    ', '.join(CPP_SELFTEST_CANDIDATES) + '）')
            self.tokenize_argv = [exe, 'tokenize', '{model}', '{text}']
            # 用 oracle 的 prompt token ids 走 --ids 分支：隔离「tokenizer」与
            # 「推理」两项对比（ai-selftest generate 的 raw-text 入口曾有一段时间
            # 未按 special=true 解析 §6.3 的 <|im_start|>，--ids 分支不受影响）。
            # 对照 llama-server（不按换行提前停），需显式关闭换行停止。
            self.generate_argv = [exe, 'generate', '{model}', '--ids', '{ids}', '{n}',
                                  '--no-newline-stop']
            self.generate_uses_ids = True
        elif engine == 'cmd':
            if not tokenize_cmd:
                raise SystemExit('--engine cmd 需要 --tokenize-cmd')
            self.tokenize_argv = json.loads(tokenize_cmd)
            self.generate_argv = json.loads(generate_cmd) if generate_cmd else None
        else:
            raise SystemExit('未知 --engine: ' + engine)

    def _run(self, argv_template, repl):
        argv = []
        for a in argv_template:
            for k, v in repl.items():
                a = a.replace('{' + k + '}', v)
            argv.append(a)
        t0 = time.time()
        proc = subprocess.run(argv, capture_output=True, timeout=self.timeout)
        dt = time.time() - t0
        if proc.returncode != 0:
            err = proc.stderr.decode('utf-8', 'replace')[-800:]
            raise RuntimeError(f'candidate CLI 失败 ({argv[0]} {argv[1] if len(argv) > 1 else ""} '
                               f'exit={proc.returncode}):\n{err}')
        return parse_json_stdout(proc.stdout.decode('utf-8', 'replace')), dt

    def tokenize(self, text):
        r, dt = self._run(self.tokenize_argv, {'model': self.model, 'text': text})
        tokens = r.get('tokens') if isinstance(r, dict) else r
        return [int(x) for x in tokens], dt

    def generate(self, prompt, n, prompt_ids=None):
        if not self.generate_argv:
            raise RuntimeError('该 candidate 未提供 generate 命令')
        ids = ','.join(str(int(x)) for x in (prompt_ids or []))
        r, dt = self._run(self.generate_argv,
                          {'model': self.model, 'prompt': prompt, 'n': str(n), 'ids': ids})
        tokens = r.get('tokens') if isinstance(r, dict) else r
        return {'tokens': [int(x) for x in tokens],
                'text': (r.get('text') if isinstance(r, dict) else '') or '',
                'elapsed_s': dt}


def cmp_tokens(cand, ref):
    n = min(len(cand), len(ref))
    first = next((i for i in range(n) if cand[i] != ref[i]), None)
    return {
        'match': cand == ref,
        'common_prefix': first if first is not None else n,
        'candidate_len': len(cand),
        'reference_len': len(ref),
        'first_mismatch_index': first,
        'candidate': cand,
        'reference': ref,
    }


QWEN_EOS = 151645  # <|im_end|>


def trim_trailing_eos(tokens):
    """llama-server includes the EOS token in the returned tokens, some engines
    stop before emitting it. Trim trailing EOS ids for an apples-to-apples diff."""
    out = list(tokens)
    while out and out[-1] == QWEN_EOS:
        out.pop()
    return out


def run_suite(args, oracle, cand):
    report = {'engine': args.engine, 'model': cand.model, 'ok': True,
              'tokenize': [], 'generate': [], 'started': time.strftime('%Y-%m-%d %H:%M:%S')}
    if args.suite in ('all', 'tokens'):
        log(f'== tokenizer 对照：{len(TOKENIZE_CASES)} 个文本 ==')
        for text in TOKENIZE_CASES:
            ref = oracle.tokenize(text)
            try:
                got, dt = cand.tokenize(text)
            except Exception as e:
                report['ok'] = False
                report['tokenize'].append({'text': text, 'error': str(e)})
                log(f'  [ERROR] {text[:18]!r}: {e}')
                continue
            c = cmp_tokens(got, ref)
            c.update({'text': text, 'candidate_ms': round(dt * 1000),
                      'detok_ok': oracle.detokenize(got) == text})
            report['tokenize'].append(c)
            status = 'PASS' if c['match'] else f"FAIL(prefix={c['common_prefix']})"
            if not c['match']:
                report['ok'] = False
            log(f"  [{status}] {text[:24]!r} cand={c['candidate_len']} ref={c['reference_len']}")

    if args.suite in ('all', 'generate'):
        gen_texts = [t for t in (args.gen_texts or [
            '周六早上八点香山门口集合，别迟到！',
            '请把项目周会的会议纪要发我一下。',
        ])]
        log(f'== greedy 生成对照：{len(gen_texts)} 个提示，n_predict={args.n_predict} ==')
        for text in gen_texts:
            prompt = title_prompt(text)
            ref_prompt_ids = oracle.tokenize(prompt)
            ref = oracle.generate(prompt, n_predict=args.n_predict)
            try:
                got = cand.generate(prompt, args.n_predict, prompt_ids=ref_prompt_ids)
            except Exception as e:
                report['ok'] = False
                report['generate'].append({'text': text, 'error': str(e)})
                log(f'  [ERROR] {text[:18]!r}: {e}')
                continue
            c = cmp_tokens(trim_trailing_eos(got['tokens']), trim_trailing_eos(ref['tokens']))
            c.update({'text': text, 'candidate_text': got['text'],
                      'reference_text': ref['content'],
                      'candidate_raw_tokens': got['tokens'],
                      'reference_raw_tokens': ref['tokens'],
                      'candidate_ms': round(got['elapsed_s'] * 1000)})
            report['generate'].append(c)
            prefix_ok = c['match'] or c['common_prefix'] >= min(args.n_predict, len(c['reference']), 8)
            c['prefix8_ok'] = prefix_ok
            if not (c['match'] or prefix_ok):
                report['ok'] = False
            log(f"  [{'PASS' if c['match'] else ('PREFIX' if prefix_ok else 'FAIL')}] "
                f"{text[:20]!r} cand={c['candidate_len']} ref={c['reference_len']} "
                f"prefix={c['common_prefix']} cand_text={got['text']!r}")
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description='AI engine vs llama.cpp oracle comparison')
    ap.add_argument('--engine', choices=['node', 'cpp', 'cmd'], default='node')
    ap.add_argument('--model', default=MODEL_Q8, help='GGUF model for the candidate engine')
    ap.add_argument('--cpp-exe', default=None, help='C++ ai-selftest executable path')
    ap.add_argument('--tokenize-cmd', default=None, help='JSON argv template for --engine cmd')
    ap.add_argument('--generate-cmd', default=None, help='JSON argv template for --engine cmd')
    ap.add_argument('--suite', choices=['tokens', 'generate', 'all'], default='all')
    ap.add_argument('--n-predict', type=int, default=8)
    ap.add_argument('--gen-texts', action='append', default=None, help='生成对照文本（可重复）')
    ap.add_argument('--oracle-port', type=int, default=0)
    ap.add_argument('--oracle-timeout', type=float, default=300)
    ap.add_argument('--out', default=None, help='报告 JSON 输出路径')
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args(argv)

    if not os.path.isfile(args.model):
        print(json.dumps({'ok': False, 'error': 'model not found: ' + args.model}, ensure_ascii=False))
        return 2
    try:
        cand = Candidate(args.engine, os.path.abspath(args.model), args.cpp_exe,
                         args.tokenize_cmd, args.generate_cmd)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        return 2

    oracle = LlamaOracle(model=os.path.abspath(args.model), port=args.oracle_port,
                         startup_timeout=args.oracle_timeout, verbose=args.verbose)
    try:
        log(f'oracle: 启动 llama-server 加载 {os.path.basename(args.model)} …')
        oracle.start()
        report = run_suite(args, oracle, cand)
    finally:
        oracle.stop()
    report['finished'] = time.strftime('%Y-%m-%d %H:%M:%S')
    out = args.out or os.path.join(SRC, 'tests', 'tmp',
                                   f'ai_compare_{args.engine}.json')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    n_tok = len(report['tokenize'])
    n_tok_pass = sum(1 for c in report['tokenize'] if c.get('match'))
    n_gen = len(report['generate'])
    n_gen_pass = sum(1 for c in report['generate'] if c.get('match') or c.get('prefix8_ok'))
    summary = {'ok': report['ok'], 'engine': args.engine, 'out': out,
               'tokenize': f'{n_tok_pass}/{n_tok}', 'generate': f'{n_gen_pass}/{n_gen}'}
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
