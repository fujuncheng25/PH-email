#!/usr/bin/env python3
"""TLS 根证书回归测试（task-18）：Windows「问候失败」修复验证。

覆盖：
1. `--tls-info`：受信任根证书总数 > 0；能看到系统根证书库（Windows: crypt32/
   系统根证书）或本地 CA 文件加载信息；若程序目录存在 cacert.pem 则必须列出且证书数 >0。
2. 正向 TLS：用 tls-test/ 的 ca.crt 复制为临时程序目录 `cacert.pem`，客户端
   SSL=true 连接本地 TLS 代理（→ mock Mail 服务器），POST /api/test 断言
   smtp.ok && recv.ok（验证「本地 CA 文件 → TLS 校验」链路）。
3. 负向 TLS：临时程序目录**不放** cacert.pem（并清除 SSL_CERT_FILE/SSL_CERT_DIR），
   同一 TLS 代理（自签名 CA），POST /api/test 断言 smtp/recv 的 error 含 TLS 失败
   原因（不是裸「问候失败：」），防止回退明文/静默失败回归。

不依赖外网、不占固定端口（默认 TLS 代理 27850/27851/27852 → mock 27950/27951/27952，
客户端 API 27800，可用 --base-port 改）。资产复用 Lead 的 `tls-test/`。

用法：
    C:\\Users\\splay\\anaconda3\\python.exe tests\\tls_ca_test.py
    ... --exe build\\Release\\email-chatter.exe --base-port 27800 --keep
"""
import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)
ROOT = os.path.dirname(SRC)
# 自带测试证书/代理（tests/tls_fixtures），保证源码包内也能自测；
# 若外部 tls-test/ 存在且更新，也允许用 CHATTER_TLS_TEST 指定。
TLS_TEST = os.environ.get('CHATTER_TLS_TEST') or os.path.join(HERE, 'tls_fixtures')
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
import mock_mail  # noqa: E402

EXE_NAME = 'email-chatter.exe' if os.name == 'nt' else 'email-chatter'
PASS, FAIL, SKIP = [], [], []


def check(name, cond, extra=''):
    if cond:
        PASS.append(name)
        print(f'  [PASS] {name}')
    else:
        FAIL.append(name)
        print(f'  [FAIL] {name} {extra}')


def check_skip(name, reason):
    SKIP.append(name)
    print(f'  [SKIP] {name} ({reason})')


def http_json(port, method, path, body=None, timeout=90):
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


def port_open(port, timeout=0.3):
    try:
        s = socket.create_connection(('127.0.0.1', port), timeout=timeout)
        s.close()
        return True
    except OSError:
        return False


def unique_dir(name):
    d = os.path.join(HERE, 'tmp', f'tls_{name}_{os.getpid()}_{int(time.time()) % 100000}')
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d, exist_ok=True)
    return d


def make_progdir(name, exe):
    """复制一份独立程序目录（exe + DLL + web），数据只写在这里。"""
    src = os.path.dirname(os.path.abspath(exe))
    dst = unique_dir(name)
    for entry in os.listdir(src):
        s = os.path.join(src, entry)
        d = os.path.join(dst, entry)
        if os.path.isdir(s):
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)
    # 确保负向测试不受外部 CA 环境变量影响
    os.makedirs(os.path.join(dst, 'data'), exist_ok=True)
    return dst


def clean_env():
    env = os.environ.copy()
    for k in ('SSL_CERT_FILE', 'SSL_CERT_DIR'):
        env.pop(k, None)
    return env


def read_tls_info(exe, prog):
    env = clean_env()
    r = subprocess.run([exe, '--tls-info'], cwd=prog, env=env,
                       capture_output=True, timeout=90)
    text = (r.stdout or b'').decode('utf-8', 'replace') + \
           (r.stderr or b'').decode('utf-8', 'replace')
    return r.returncode, text


def parse_tls_info(text):
    """尽量宽容地解析 --tls-info 输出（实现可中英文、行格式可微调）。"""
    info = {'raw': text, 'root_count': 0, 'system_mention': False,
            'local_mention': 'cacert.pem' in text, 'local_count': None}
    pats = [
        r'(?:受信任(?:的)?根证书|根证书|trusted\s+root(?:\s+CA)?s?)[^\d\n]{0,40}(\d+)',
        r'(?:系统根证书|system\s+roots?|crypt32|系统证书|系统\s*CA)[^\d\n]{0,40}(\d+)',
    ]
    for p in pats:
        for m in re.finditer(p, text, re.IGNORECASE):
            info['root_count'] = max(info['root_count'], int(m.group(1)))
    # 本地 cacert.pem 的证书数
    m = re.search(r'cacert\.pem[^\d\n]{0,60}(\d+)', text)
    if m:
        info['local_count'] = int(m.group(1))
    info['system_mention'] = bool(re.search(
        r'系统根证书|system\s+roots?|crypt32|系统证书|系统\s*CA|crypt32', text, re.IGNORECASE))
    # 兜底：输出里有 "roots/N" 之类
    if info['root_count'] == 0:
        m = re.search(r'(?:roots?|根证书)[^\d\n]{0,10}(\d+)', text, re.IGNORECASE)
        if m:
            info['root_count'] = int(m.group(1))
    return info


def stop_proc(p):
    if p is None:
        return
    try:
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
    except Exception:
        pass


def start_mock(target_ports):
    mbox = mock_mail.Mailbox()
    log = lambda m: None
    mock_mail.serve(target_ports[0], lambda c: mock_mail.handle_smtp(mbox, c, log))
    mock_mail.serve(target_ports[1], lambda c: mock_mail.handle_pop3(mbox, c, log))
    mock_mail.serve(target_ports[2], lambda c: mock_mail.handle_imap(mbox, c, log))
    for p in target_ports:
        t0 = time.time()
        while time.time() - t0 < 10:
            if port_open(p):
                break
            time.sleep(0.1)
    return mbox


def start_tls_proxy(proxy_ports, target_ports):
    cmd = [sys.executable, os.path.join(TLS_TEST, 'tls_proxy.py'),
           '--smtp', str(proxy_ports[0]), '--smtp-target', str(target_ports[0]),
           '--pop3', str(proxy_ports[1]), '--pop3-target', str(target_ports[1]),
           '--imap', str(proxy_ports[2]), '--imap-target', str(target_ports[2])]
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=flags, env=clean_env())
    t0 = time.time()
    while time.time() - t0 < 15:
        if all(port_open(pp) for pp in proxy_ports):
            return p
        time.sleep(0.15)
    stop_proc(p)
    raise RuntimeError('TLS proxy 未在 15s 内监听: ' + str(proxy_ports))


def tls_kind(err):
    """错误信息是否包含 TLS 层失败原因（而不是裸「问候失败」）。"""
    low = (err or '').lower()
    keys = ['tls', 'ssl', '证书', 'certificate', 'handshake', '握手', 'verify',
            '根证书', 'ca ', 'x509', 'self-signed', '自签名', 'unknown ca']
    return any(k in low for k in keys)


def start_infra(base_port):
    """启动一次 mock + TLS 代理（所有 roundtrip 共用，避免 Windows SO_REUSEADDR 端口重绑问题）。"""
    proxy_ports = (base_port + 50, base_port + 51, base_port + 52)
    target_ports = (base_port + 150, base_port + 151, base_port + 152)
    mbox = start_mock(target_ports)
    proxy = start_tls_proxy(proxy_ports, target_ports)
    return {'proxy_ports': proxy_ports, 'target_ports': target_ports,
            'mbox': mbox, 'proxy': proxy}


def stop_infra(infra):
    stop_proc(infra.get('proxy'))


def run_tls_roundtrip(exe, base_port, with_ca, host='127.0.0.1', api_offset=0, infra=None):
    """启动客户端并 POST /api/test；infra 为 None 时自行启动/清理 mock+TLS 代理。"""
    own_infra = infra is None
    if own_infra:
        infra = start_infra(base_port)
    proxy_ports = infra['proxy_ports']
    api_port = base_port + 100 + api_offset
    prog = make_progdir('withca' if with_ca else 'noca', exe)
    client = None
    try:
        ca_dir = os.path.join(prog, 'cacert.pem')
        if with_ca:
            shutil.copyfile(os.path.join(TLS_TEST, 'ca.crt'), ca_dir)
        else:
            for cand in ('cacert.pem', 'cert.pem'):
                p = os.path.join(prog, cand)
                if os.path.exists(p):
                    os.remove(p)  # 排除 build 目录自带的 CA，确保无信任
        logf = open(os.path.join(prog, 'client.log'), 'wb')
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        client = subprocess.Popen([os.path.join(prog, EXE_NAME), '--no-browser',
                                   '--port', str(api_port)],
                                  stdout=logf, stderr=logf, creationflags=flags,
                                  env=clean_env())
        if not wait_ready(api_port):
            return {'_started': False, 'prog': prog, 'mbox': infra['mbox'],
                    'log': os.path.join(prog, 'client.log')}
        cfg = {
            'email': 'me@test.local', 'display_name': '我', 'password': 'testpass',
            'mode': 'imap', 'poll_interval': 3, 'auto_poll': False,
            'imap': {'host': host, 'port': proxy_ports[2], 'ssl': True},
            'pop3': {'host': host, 'port': proxy_ports[1], 'ssl': True},
            'smtp': {'host': host, 'port': proxy_ports[0], 'ssl': True},
        }
        last_err = None
        for _ in range(3):
            try:
                http_json(api_port, 'POST', '/api/config', cfg, timeout=30)
                last_err = None
                break
            except Exception as e:  # 端口刚释放时的瞬时 reset，重试
                last_err = e
                time.sleep(0.6)
        if last_err is not None:
            return {'_started': False, 'prog': prog, 'mbox': infra['mbox'],
                    'log': os.path.join(prog, 'client.log'), 'error': repr(last_err)}
        r = http_json(api_port, 'POST', '/api/test', {}, timeout=120)
        return {'_started': True, 'test': r, 'prog': prog, 'mbox': infra['mbox'],
                'log': os.path.join(prog, 'client.log')}
    finally:
        stop_proc(client)
        if own_infra:
            stop_infra(infra)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--exe', default=os.path.join(SRC, 'build', 'Release', EXE_NAME))
    ap.add_argument('--base-port', type=int, default=27800)
    ap.add_argument('--keep', action='store_true')
    args = ap.parse_args()
    exe = os.path.abspath(args.exe)
    if not os.path.isfile(exe):
        print('exe not found:', exe)
        return 2
    print(f'== TLS CA 回归测试（exe={os.path.basename(exe)} '
          f'mtime={time.strftime("%H:%M:%S", time.localtime(os.path.getmtime(exe)))}）==')

    # ---------- 1. --tls-info 根证书加载 ----------
    prog = make_progdir('tlsinfo', exe)
    try:
        prog_exe = os.path.join(prog, EXE_NAME)  # 必须在临时程序目录运行，才会读该目录的 cacert.pem
        try:
            rc, text = read_tls_info(prog_exe, prog)
        except subprocess.TimeoutExpired:
            rc, text = -1, '(--tls-info 超时)'
        print('  --- --tls-info 输出 ---')
        for line in text.strip().splitlines()[:20]:
            print('   |', line)
        parsed = parse_tls_info(text)
        check('T1 --tls-info 可执行且返回 0', rc == 0 and bool(text.strip()),
              f'rc={rc} text={text[:200]!r}')
        check('T2 受信任根证书总数 > 0', parsed['root_count'] > 0,
              f"root_count={parsed['root_count']} text={text[:400]!r}")
        check('T3 显示系统根证书库或本地 CA 加载信息',
              parsed['system_mention'] or parsed['local_mention'],
              f"system={parsed['system_mention']} local={parsed['local_mention']} raw={text[:400]!r}")
        builtin_ca = os.path.isfile(os.path.join(os.path.dirname(exe), 'cacert.pem'))
        if builtin_ca:
            check('T4 程序目录 cacert.pem 被 --tls-info 列出且证书数>0',
                  parsed['local_mention'] and (parsed['local_count'] or 0) > 0,
                  f"local_count={parsed['local_count']} raw={text[:400]!r}")
        else:
            check_skip('T4 程序目录 cacert.pem 被加载', 'build/Release 无 cacert.pem（按规格跳过）')
        if args.keep:
            print('  tlsinfo prog:', prog)
    finally:
        if not args.keep:
            shutil.rmtree(prog, ignore_errors=True)

    # T2b: 移除程序目录 cacert.pem/cert.pem 后，仍必须能从「系统根证书库」加载 >0 根证书
    #（原始 bug 回归点：Windows OPENSSLDIR 不存在导致 0 根证书 → 问候失败）
    prog2 = make_progdir('tlsinfo_noca', exe)
    try:
        for cand in ('cacert.pem', 'cert.pem'):
            p = os.path.join(prog2, cand)
            if os.path.exists(p):
                os.remove(p)
        try:
            rc2, text2 = read_tls_info(os.path.join(prog2, EXE_NAME), prog2)
        except subprocess.TimeoutExpired:
            rc2, text2 = -1, '(--tls-info 超时)'
        parsed2 = parse_tls_info(text2)
        check('T2b 无程序目录 CA 时仍从系统根证书库加载 >0（原 bug 回归点）',
              rc2 == 0 and parsed2['root_count'] > 0 and parsed2['system_mention'],
              f"rc={rc2} root_count={parsed2['root_count']} system={parsed2['system_mention']} "
              f"raw={text2[:400]!r}")
        if args.keep:
            print('  tlsinfo_noca prog:', prog2)
    finally:
        if not args.keep:
            shutil.rmtree(prog2, ignore_errors=True)

    # ---------- 2/3. TLS 正向（本地 CA）/ 负向（无信任） ----------
    if not (os.path.isfile(os.path.join(TLS_TEST, 'tls_proxy.py'))
            and os.path.isfile(os.path.join(TLS_TEST, 'ca.crt'))
            and os.path.isfile(os.path.join(TLS_TEST, 'srv.crt'))
            and os.path.isfile(os.path.join(TLS_TEST, 'srv.key'))):
        check_skip('T5 TLS 正向（本地 cacert.pem）', 'tls-test/ 资产缺失')
        check_skip('T6 TLS 负向（无信任时错误信息）', 'tls-test/ 资产缺失')
        return finish()

    # mock + TLS 代理只启动一次，所有 roundtrip 复用（避免 Windows 端口重绑问题）
    infra = start_infra(args.base_port)
    try:
        # 正向：ca.crt -> prog/cacert.pem（按 Lead tls-test 配置使用 127.0.0.1）
        res = None
        try:
            res = run_tls_roundtrip(exe, args.base_port, with_ca=True, host='127.0.0.1',
                                    api_offset=0, infra=infra)
        except Exception as e:
            res = {'_started': False, 'error': repr(e)}
        t5_ok = False
        if not res.get('_started'):
            check('T5 TLS 正向（本地 cacert.pem, 127.0.0.1）', False,
                  f"client 未启动: {res.get('error', '')} log={res.get('log')}")
        else:
            r = res.get('test') or {}
            smtp = r.get('smtp') or {}
            recv = r.get('recv') or {}
            t5_ok = r.get('ok') is True and smtp.get('ok') is True and recv.get('ok') is True
            check('T5 TLS 正向（本地 cacert.pem, 127.0.0.1）：smtp.ok && recv.ok', t5_ok,
                  json.dumps(r, ensure_ascii=False)[:500])
            if args.keep:
                print('  withca prog:', res.get('prog'))
            if not args.keep:
                shutil.rmtree(res.get('prog', ''), ignore_errors=True)

        # 对照：同一 CA 链路改用 DNS 主机名 localhost（区分「CA 未加载」与「IP 字面量主机名校验」）
        if not t5_ok:
            try:
                res2 = run_tls_roundtrip(exe, args.base_port, with_ca=True, host='localhost',
                                         api_offset=2, infra=infra)
            except Exception as e:
                res2 = {'_started': False, 'error': repr(e)}
            if not res2.get('_started'):
                check('T5b TLS 正向对照（localhost）', False,
                      f"client 未启动: {res2.get('error', '')} log={res2.get('log')}")
            else:
                r2 = res2.get('test') or {}
                s2 = r2.get('smtp') or {}
                v2 = r2.get('recv') or {}
                check('T5b TLS 正向对照（localhost，DNS SAN）：smtp.ok && recv.ok',
                      r2.get('ok') is True and s2.get('ok') is True and v2.get('ok') is True,
                      json.dumps(r2, ensure_ascii=False)[:500])
                if args.keep:
                    print('  withca-localhost prog:', res2.get('prog'))
                if not args.keep:
                    shutil.rmtree(res2.get('prog', ''), ignore_errors=True)

        # 负向：无 cacert.pem / 无系统信任
        try:
            res = run_tls_roundtrip(exe, args.base_port, with_ca=False, host='127.0.0.1',
                                    api_offset=4, infra=infra)
        except Exception as e:
            res = {'_started': False, 'error': repr(e)}
        if not res.get('_started'):
            check('T6 TLS 负向（无信任时错误信息）', False,
                  f"client 未启动: {res.get('error', '')} log={res.get('log')}")
        else:
            r = res.get('test') or {}
            smtp = r.get('smtp') or {}
            recv = r.get('recv') or {}
            e_smtp = smtp.get('error') or ''
            e_recv = recv.get('error') or ''
            check('T6 TLS 负向：smtp/recv 失败且错误含 TLS 失败原因（非裸问候失败）',
                  smtp.get('ok') is False and recv.get('ok') is False
                  and tls_kind(e_smtp) and tls_kind(e_recv),
                  f'smtp={e_smtp!r} recv={e_recv!r}')
            check('T7 错误信息不是裸「问候失败」',
                  not re.fullmatch(r'.*问候失败[：:]\s*', e_smtp)
                  and not re.fullmatch(r'.*问候失败[：:]\s*', e_recv),
                  f'smtp={e_smtp!r} recv={e_recv!r}')
            if args.keep:
                print('  noca prog:', res.get('prog'))
            if not args.keep:
                shutil.rmtree(res.get('prog', ''), ignore_errors=True)
    finally:
        stop_infra(infra)
    return finish()


def finish():
    print()
    print(f'== RESULT: {len(PASS)} passed, {len(FAIL)} failed, {len(SKIP)} skipped ==')
    for f in FAIL:
        print('  FAILED:', f)
    for s in SKIP:
        print('  SKIPPED:', s)
    return 0 if not FAIL else 1


if __name__ == '__main__':
    sys.exit(main())
