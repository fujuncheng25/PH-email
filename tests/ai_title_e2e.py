#!/usr/bin/env python3
"""End-to-end check: real C++ AI title generation over HTTP (/api/ai/title, /api/send).

No network, no model download: the local reference GGUF from FEATURE-SPEC.md §8
(Qwen2.5-1.5B-Instruct Q8_0) is **hard-linked** into the test client's
``data/models/qwen2.5-0.5b-instruct-q4_k_m.gguf`` slot (same Qwen2 arch, so the
engine loads it), then we compare the generated title against the llama.cpp
oracle (tools/ref_llama.py) for the same §6.3 prompt.

Usage::
    C:\\Users\\splay\\anaconda3\\python.exe tests\\ai_title_e2e.py
    ... --exe source/build/Release/email-chatter.exe --model <path.gguf>
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(SRC, 'tools'))
import mock_mail  # noqa: E402
from ref_llama import LlamaOracle, MODEL_Q8, title_prompt  # noqa: E402

EXE_NAME = 'email-chatter.exe' if os.name == 'nt' else 'email-chatter'
MODEL_FILE = 'qwen2.5-0.5b-instruct-q4_k_m.gguf'
TEXT = '周六早上八点香山门口集合，别迟到！'


def http_json(port, method, path, body=None, timeout=180):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def wait_ready(port, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            http_json(port, 'GET', '/api/state', timeout=5)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--exe', default=os.path.join(SRC, 'build', 'Release', EXE_NAME))
    ap.add_argument('--model', default=MODEL_Q8)
    ap.add_argument('--base-port', type=int, default=57600)
    ap.add_argument('--keep', action='store_true')
    args = ap.parse_args()
    exe = os.path.abspath(args.exe)
    model = os.path.abspath(args.model)
    if not os.path.isfile(exe) or not os.path.isfile(model):
        print(json.dumps({'ok': False, 'error': 'exe/model not found'}, ensure_ascii=False))
        return 2
    smtp_p, pop3_p, imap_p = args.base_port + 1, args.base_port + 2, args.base_port + 3
    api_p = args.base_port + 4
    checks = {}

    mbox = mock_mail.Mailbox()
    mock_mail.serve(smtp_p, lambda c: mock_mail.handle_smtp(mbox, c, lambda m: None))
    mock_mail.serve(pop3_p, lambda c: mock_mail.handle_pop3(mbox, c, lambda m: None))
    mock_mail.serve(imap_p, lambda c: mock_mail.handle_imap(mbox, c, lambda m: None))

    tmp_root = os.path.join(HERE, 'tmp')
    os.makedirs(tmp_root, exist_ok=True)
    # 注意：不要用 tempfile.mkdtemp（在当前 sandbox 下其创建的子目录无法再建子目录），
    # 与 e2e 测试一致，直接 os.makedirs 一个唯一目录。
    work = os.path.join(tmp_root, 'ai_title_%d_%s' % (os.getpid(),
                                                      hex(int(time.time() * 1000))[2:]))
    os.makedirs(work, exist_ok=True)
    prog = os.path.join(work, 'prog')
    os.makedirs(os.path.join(prog, 'data', 'models'), exist_ok=True)
    for name in os.listdir(os.path.dirname(exe)):
        if name == 'data':
            continue
        src = os.path.join(os.path.dirname(exe), name)
        dst = os.path.join(prog, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    model_dst = os.path.join(prog, 'data', 'models', MODEL_FILE)
    try:
        os.link(model, model_dst)   # hard link: instant, no 1.6GB copy
    except OSError:
        shutil.copyfile(model, model_dst)

    oracle = LlamaOracle(model=model, port=0, verbose=False)
    proc = None
    try:
        # Reference title from llama.cpp for the exact §6.3 prompt
        oracle.start()
        ref = oracle.generate(title_prompt(TEXT), n_predict=24)
        expected_title = ref['content'].strip()
        # 后处理（§6.3）与参考生成对齐：去引号/前缀/句号等
        print(f'oracle 参考生成: {expected_title!r} tokens={ref["tokens"][:12]}', file=sys.stderr)

        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        logf = open(os.path.join(work, 'client.log'), 'wb')
        proc = subprocess.Popen([os.path.join(prog, EXE_NAME), '--no-browser', '--port', str(api_p)],
                                stdout=logf, stderr=logf, creationflags=flags)
        checks['启动'] = wait_ready(api_p)
        r = http_json(api_p, 'POST', '/api/config', {
            'email': 'me@test.local', 'display_name': '我', 'password': 'authcode', 'mode': 'pop3',
            'pop3': {'host': '127.0.0.1', 'port': pop3_p, 'ssl': False},
            'smtp': {'host': '127.0.0.1', 'port': smtp_p, 'ssl': False},
            'poll_interval': 3,
            'ai': {'enabled': True, 'model_file': MODEL_FILE},
        }, timeout=30)
        checks['保存 AI 配置'] = r.get('ok') is True
        http_json(api_p, 'POST', '/api/friends', {'action': 'add', 'email': 'friend@example.com',
                                                  'name': '小明'})
        st = http_json(api_p, 'GET', '/api/ai/status', timeout=10).get('ai') or {}
        checks['模型就绪(model_ready)'] = st.get('model_ready') is True
        t0 = time.time()
        r = http_json(api_p, 'POST', '/api/ai/title', {'text': TEXT}, timeout=180)
        title_ms = round((time.time() - t0) * 1000)
        title = (r.get('subject') or '').strip()
        checks['title ok/source=ai'] = r.get('ok') is True and r.get('source') == 'ai'
        checks['title 与 llama.cpp 一致'] = title == expected_title
        print(f'/api/ai/title -> {title!r} source={r.get("source")} {title_ms}ms', file=sys.stderr)

        # 扩展邮件模式空主题 -> 发送时 AI 生成主题，普通邮件 Subject 正确
        mbox.reset()
        r = http_json(api_p, 'POST', '/api/send', {
            'to': 'friend@example.com', 'kind': 'email', 'text': TEXT}, timeout=180)
        checks['email 发送 ok/ai=true'] = r.get('ok') is True and r.get('ai') is True
        raw = mbox.last_raw()
        msg = None
        if raw:
            import email
            import email.policy
            msg = email.message_from_bytes(raw, policy=email.policy.default)
        subj = str(msg['Subject']) if msg is not None else None
        checks['email Subject==AI 标题'] = subj == (r.get('subject') or '') and subj is not None
        checks['X-Email-Chatter-Kind=email'] = (
            msg is not None and str(msg.get('X-Email-Chatter-Kind', '')) == 'email')
        print(f'email send subject={subj!r} ai={r.get("ai")}', file=sys.stderr)

        # chat 模式：AI 开启且就绪时主题 = AI 生成（§4.1.3）
        mbox.reset()
        r = http_json(api_p, 'POST', '/api/send', {'to': 'friend@example.com', 'text': TEXT},
                      timeout=180)
        raw = mbox.last_raw()
        msg = None
        if raw:
            import email
            import email.policy
            msg = email.message_from_bytes(raw, policy=email.policy.default)
        subj = str(msg['Subject']) if msg is not None else None
        checks['chat AI 主题 ok/ai=true'] = r.get('ok') is True and r.get('ai') is True
        checks['chat Subject==AI 标题'] = subj == (r.get('subject') or '') and subj is not None
        print(f'chat send subject={subj!r} ai={r.get("ai")}', file=sys.stderr)
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        oracle.stop()
        if args.keep:
            print('work dir:', work, file=sys.stderr)
        else:
            for _ in range(6):
                shutil.rmtree(work, ignore_errors=True)
                if not os.path.exists(work):
                    break
                time.sleep(0.4)

    ok = all(checks.values())
    print(json.dumps({'ok': ok, 'checks': checks}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
