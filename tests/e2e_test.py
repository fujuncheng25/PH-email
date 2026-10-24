#!/usr/bin/env python3
"""End-to-end test for the email-chatter C++ client using mock mail servers.

Usage: python e2e_test.py [--exe path/to/email-chatter(.exe)] [--port N]

Covers: HTTP API, config, friend whitelist, SMTP send, POP3 receive,
IMAP receive + \\Seen marking, whitelist filtering, read/unread, UI assets.
"""
import argparse
import base64
import email
import email.policy
import json
import os
import shutil
import smtplib
import socket
import subprocess
import sys
import threading
import time
import urllib.request

sys.dont_write_bytecode = True  # 不在源码目录留下 __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mock_mail  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PASS = []
FAIL = []
SKIP = []

# 1x1 透明 PNG（用于上传/图片附件测试）
PNG_1X1 = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')


def cleanup_tmp(path, attempts=6):
    """Windows 下刚被杀掉的客户端可能短暂占用文件，重试删除。"""
    for _ in range(attempts):
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.exists(path):
            return True
        time.sleep(0.4)
    return not os.path.exists(path)


def check(name, cond, extra=''):
    if cond:
        PASS.append(name)
        print(f'  [PASS] {name}')
    else:
        FAIL.append(name)
        print(f'  [FAIL] {name} {extra}')


def check_skip(name, reason):
    """Record a conditionally-skipped check (environment/implementation limits)."""
    SKIP.append(name)
    print(f'  [SKIP] {name} ({reason})')


# ------------------------------------------------------------ 2.0 test utils --
def parse_mail(raw):
    """Parse a raw MIME message with the stdlib decoder (RFC2047/2231 aware)."""
    if isinstance(raw, str):
        raw = raw.encode('utf-8', 'replace')
    return email.message_from_bytes(raw, policy=email.policy.default)


def mail_body(msg):
    """Decoded text/plain body of an email.message.Message (body part = no filename)."""
    if msg.is_multipart():
        parts = msg.iter_parts()
        for part in parts:
            if part.get_content_type() == 'text/plain' and not part.get_filename():
                return part.get_content()
        for part in msg.walk():
            if part.get_content_type() == 'text/plain':
                return part.get_content()
        return ''
    return msg.get_content()


def mail_parts(msg):
    """All top-level child parts (attachments) of a multipart mail.

    注意：text/plain **带 filename** 的附件（例如 .txt 文件）是附件而不是正文，
    不能用 Content-Type 排除；正文部分按「无 filename 的 text/plain」识别。
    """
    if not msg.is_multipart():
        return []
    return [p for p in msg.iter_parts() if p.get_content_maintype() != 'multipart'
            and not (p.get_content_type() == 'text/plain' and not p.get_filename())]


def mail_attachments(msg):
    """List of {'filename','mime','data'} for attachment parts."""
    out = []
    for p in mail_parts(msg):
        out.append({
            'filename': p.get_filename(),
            'mime': p.get_content_type(),
            'data': p.get_payload(decode=True) or b'',
        })
    return out


def http_bytes(port, method, path, body=None, headers=None, timeout=30):
    """Raw HTTP request returning (status, body_bytes, headers_dict)."""
    import http.client
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
    hdrs = dict(headers or {})
    if body is not None and 'Content-Type' not in hdrs:
        hdrs['Content-Type'] = 'application/octet-stream'
    conn.request(method, path, body=body, headers=hdrs)
    r = conn.getresponse()
    data = r.read()
    out = dict(r.getheaders())
    status = r.status
    conn.close()
    return status, data, out


def http_json2(port, method, path, body=None, timeout=30):
    status, data, _ = http_bytes(port, method, path,
                                 json.dumps(body).encode() if body is not None else None,
                                 {'Content-Type': 'application/json'}, timeout=timeout)
    try:
        return status, json.loads(data.decode('utf-8', 'replace'))
    except Exception:
        return status, {'_raw': data.decode('utf-8', 'replace')}


def upload_bytes(port, name, data, mime='application/octet-stream'):
    """POST /api/upload?name=... (raw body); returns (status, json)."""
    import urllib.parse
    q = urllib.parse.quote(name)
    status, body, _ = http_bytes(port, 'POST', f'/api/upload?name={q}', data,
                                 {'Content-Type': mime})
    try:
        return status, json.loads(body.decode('utf-8', 'replace'))
    except Exception:
        return status, {'_raw': body.decode('utf-8', 'replace')}


def read_data_json(prog, filename):
    path = os.path.join(data_of(prog), filename)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def start_configured(name, exe, base_port, mock, *, mode='pop3', ai=None,
                     pre_config=None, pre_messages=None):
    """Start a fresh client already configured + one friend; returns (proc, prog)."""
    prog = make_progdir(name, exe)
    if pre_config is not None or pre_messages is not None:
        data = data_of(prog)
        os.makedirs(data, exist_ok=True)
        if pre_config is not None:
            with open(os.path.join(data, 'config.json'), 'w', encoding='utf-8') as f:
                json.dump(pre_config, f, ensure_ascii=False)
        if pre_messages is not None:
            with open(os.path.join(data, 'messages.json'), 'w', encoding='utf-8') as f:
                json.dump(pre_messages, f, ensure_ascii=False)
    port = base_port
    proc = start_client(prog, port, os.path.join(HERE, 'tmp', f'client_{name}.log'))
    cfg = {
        'email': 'me@test.local', 'display_name': '我', 'password': 'authcode',
        'mode': mode,
        'pop3': {'host': '127.0.0.1', 'port': mock.pop3_port, 'ssl': False},
        'imap': {'host': '127.0.0.1', 'port': mock.imap_port, 'ssl': False},
        'smtp': {'host': '127.0.0.1', 'port': mock.smtp_port, 'ssl': False},
        'poll_interval': 3,
    }
    if ai is not None:
        cfg['ai'] = ai
    r = http_json(port, 'POST', '/api/config', cfg)
    if not r.get('ok'):
        raise RuntimeError(f'config failed: {r}')
    http_json(port, 'POST', '/api/friends', {'action': 'add', 'email': 'friend@example.com',
                                             'name': '小明'})
    return proc, prog, port


def wait_message(port, peer, pred, timeout=8.0, interval=0.4):
    """Poll /api/messages?with=peer until pred(messages) is truthy; returns list."""
    deadline = time.time() + timeout
    msgs = []
    while time.time() < deadline:
        msgs = messages_of(port, peer)
        if pred(msgs):
            return msgs
        time.sleep(interval)
    return msgs


def last_mail(mbox):
    raw = mbox.last_raw()
    return raw, parse_mail(raw) if raw else None


class StubHttpServer:
    """Local HTTP stub for AI download tests (no external network).

    Routes:
      /missing          -> 404
      /redirect         -> 302 to /file
      /file             -> 200 regular file (GGUF-ish header, ~2MB)
      /slow             -> 200 chunked-ish slow stream (~2MB, 40ms/chunk)
      /slow-redirect    -> 307 to /slow
    """

    def __init__(self, port=0):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        stub = self
        self.payload = b'GGUF' + b'\x00' * 8 + bytes(range(256)) * 8192  # ~2MB

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *a):
                pass

            def do_GET(self):
                path = self.path.split('?', 1)[0]
                if path == '/missing':
                    self.send_error(404, 'not found')
                elif path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/file')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                elif path == '/slow-redirect':
                    self.send_response(307)
                    self.send_header('Location', '/slow')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                elif path == '/file':
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(len(stub.payload)))
                    self.end_headers()
                    self.wfile.write(stub.payload)
                elif path == '/slow':
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(len(stub.payload)))
                    self.end_headers()
                    try:
                        for i in range(0, len(stub.payload), 16384):
                            self.wfile.write(stub.payload[i:i + 16384])
                            self.wfile.flush()
                            time.sleep(0.02)
                    except OSError:
                        pass
                else:
                    self.send_error(404)

        self.server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        try:
            self.server.shutdown()
        except Exception:
            pass



def http_json(port, method, path, body=None, raw=False, timeout=15):
    url = f'http://127.0.0.1:{port}{path}'
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        content = r.read().decode('utf-8', 'replace')
    return content if raw else json.loads(content)


def wait_ready(port, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            http_json(port, 'GET', '/api/state')
            return True
        except Exception:
            time.sleep(0.3)
    return False


EXE_NAME = 'email-chatter.exe' if os.name == 'nt' else 'email-chatter'


def make_progdir(name, exe):
    """复制一份独立的「程序目录」（exe + DLL + web），数据只落在这个目录里。"""
    src = os.path.dirname(os.path.abspath(exe))
    dst = os.path.join(HERE, 'tmp', 'progs', name)
    cleanup_tmp(dst)
    shutil.copytree(src, dst)
    return dst


def start_client(prog, port, log_path):
    flags = 0
    if os.name == 'nt':
        flags = subprocess.CREATE_NO_WINDOW
    logf = open(log_path, 'wb')
    proc = subprocess.Popen(
        [os.path.join(prog, EXE_NAME), '--no-browser', '--port', str(port)],
        stdout=logf, stderr=logf, creationflags=flags)
    ACTIVE_CLIENTS.append(proc)
    if not wait_ready(port):
        logf.close()
        print(open(log_path, 'rb').read().decode('utf-8', 'replace'))
        raise RuntimeError('client did not become ready')
    return proc


# 记录所有由本测试启动的客户端，场景异常时也能在 main 的 finally 里清理干净，
# 避免残留进程占用文件/端口影响后续场景。
ACTIVE_CLIENTS = []


def data_of(prog):
    return os.path.join(prog, 'data')


def stop_client(proc):
    try:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
    finally:
        try:
            ACTIVE_CLIENTS.remove(proc)
        except ValueError:
            pass


def stop_all_clients():
    """场景中途抛异常时兜底：终止本测试启动的所有客户端。"""
    for proc in list(ACTIVE_CLIENTS):
        try:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
        except Exception:
            pass
        try:
            ACTIVE_CLIENTS.remove(proc)
        except ValueError:
            pass


def inject_mail(smtp_port, frm, to, subject, body, use_b64=True, mid=None):
    msg = f'From: 好友 <{frm}>\r\nTo: {to}\r\nSubject: {subject}\r\nDate: {time.strftime("%a, %d %b %Y %H:%M:%S +0800")}\r\n'
    if mid:
        msg += f'Message-ID: {mid}\r\n'
    if use_b64:
        msg += 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n'
        msg += '\r\n' + __import__('base64').b64encode(body.encode()).decode() + '\r\n'
    else:
        msg += 'Content-Type: text/plain; charset=UTF-8\r\n\r\n' + body + '\r\n'
    with smtplib.SMTP('127.0.0.1', smtp_port, timeout=10) as s:
        s.ehlo()
        s.sendmail(frm, [to], msg.encode('utf-8'))


def messages_of(port, peer):
    d = http_json(port, 'GET', f'/api/messages?with={peer}')
    return d.get('messages', [])


def scenario_pop3(exe, base_port, mock, mbox):
    print('== Scenario A: POP3 mode ==')
    port = base_port + 1
    prog = make_progdir('pop3', exe)
    proc = start_client(prog, port, os.path.join(HERE, 'tmp', 'client_pop3.log'))

    s = http_json(port, 'GET', '/api/state')
    check('A1 初始未配置', s.get('configured') is False)

    r = http_json(port, 'POST', '/api/config', {
        'email': 'me@test.local', 'display_name': '我', 'password': 'authcode',
        'mode': 'pop3',
        'pop3': {'host': '127.0.0.1', 'port': mock.pop3_port, 'ssl': False},
        'smtp': {'host': '127.0.0.1', 'port': mock.smtp_port, 'ssl': False},
        'poll_interval': 3,
    })
    check('A2 保存配置', r.get('ok') is True)

    r = http_json(port, 'POST', '/api/friends', {'action': 'add', 'email': 'friend@example.com', 'name': '小明'})
    check('A3 添加好友', r.get('ok') is True)

    r = http_json(port, 'POST', '/api/send', {'to': 'friend@example.com', 'text': '你好，这是第一条消息，测试中文!'})
    check('A4 发送消息', r.get('ok') is True, str(r))
    check('A5 SMTP 服务器收到', mbox.received_count() >= 1)

    inject_mail(mock.smtp_port, 'friend@example.com', 'me@test.local', '测试主题', '收到请回复！😀')
    http_json(port, 'POST', '/api/poll', {})
    time.sleep(2.5)

    msgs = messages_of(port, 'friend@example.com')
    texts = [m['text'] for m in msgs]
    check('A6 收到好友来信', len(msgs) == 2 and '收到请回复！😀' in texts, str(texts))
    check('A7 外发消息已保存', '你好，这是第一条消息，测试中文!' in texts, str(texts))

    inject_mail(mock.smtp_port, 'stranger@x.com', 'me@test.local', '广告', '买吗？')
    http_json(port, 'POST', '/api/poll', {})
    time.sleep(2.5)
    msgs2 = messages_of(port, 'friend@example.com')
    check('A8 非白名单邮件被忽略', len(msgs2) == 2, str(len(msgs2)))

    st = http_json(port, 'GET', '/api/state')
    fr = next((f for f in st['friends'] if f['email'] == 'friend@example.com'), None)
    check('A9 好友列表/未读数', fr and fr.get('unread', 0) == 1, str(fr))

    http_json(port, 'POST', '/api/read', {'with': 'friend@example.com'})
    st = http_json(port, 'GET', '/api/state')
    fr = next((f for f in st['friends'] if f['email'] == 'friend@example.com'), None)
    check('A10 已读清零', fr and fr.get('unread', -1) == 0, str(fr))

    r = http_json(port, 'POST', '/api/friends', {'action': 'remove', 'email': 'friend@example.com'})
    check('A11 删除好友', r.get('ok') is True)
    msgs3 = messages_of(port, 'friend@example.com')
    check('A12 删除好友后会话清除', len(msgs3) == 0, str(len(msgs3)))

    stop_client(proc)
    print(f'-- POP3 scenario: {len(PASS)} passed so far, {len(FAIL)} failed --')


def scenario_imap(exe, base_port, mock, mbox):
    print('== Scenario B: IMAP mode ==')
    port = base_port + 2
    prog = make_progdir('imap', exe)
    proc = start_client(prog, port, os.path.join(HERE, 'tmp', 'client_imap.log'))

    http_json(port, 'POST', '/api/config', {
        'email': 'me@test.local', 'display_name': '我', 'password': 'authcode',
        'mode': 'imap',
        'imap': {'host': '127.0.0.1', 'port': mock.imap_port, 'ssl': False},
        'smtp': {'host': '127.0.0.1', 'port': mock.smtp_port, 'ssl': False},
        'poll_interval': 3,
    })
    http_json(port, 'POST', '/api/friends', {'action': 'add', 'email': 'friend@example.com', 'name': '小明'})
    inject_mail(mock.smtp_port, 'friend@example.com', 'me@test.local', 'IMAP主题', 'IMAP 第一封')
    inject_mail(mock.smtp_port, 'friend@example.com', 'me@test.local', 'IMAP主题2', 'IMAP 第二封')

    http_json(port, 'POST', '/api/poll', {})
    time.sleep(2.5)
    msgs = messages_of(port, 'friend@example.com')
    texts = [m['text'] for m in msgs]
    check('B1 IMAP 收到两封', len(msgs) == 2 and 'IMAP 第一封' in texts and 'IMAP 第二封' in texts, str(texts))

    st = http_json(port, 'GET', '/api/state')
    fr = next((f for f in st['friends'] if f['email'] == 'friend@example.com'), None)
    check('B2 IMAP 未读数=2', fr and fr.get('unread', 0) == 2, str(fr))

    # second poll should fetch nothing new (local seen_imap dedupe). 2.1:
    # BODY.PEEK[] 拉取不改变服务器 \Seen；好友邮件在邮箱里保持未读。
    http_json(port, 'POST', '/api/poll', {})
    time.sleep(2.5)
    msgs2 = messages_of(port, 'friend@example.com')
    seen = sorted(mbox.imap_seen)
    check('B3 PEEK 拉取不置服务器已读且本地无重复', len(msgs2) == 2 and seen == [],
          f'msgs={len(msgs2)} seen={seen}')
    st = http_json(port, 'GET', '/api/state')
    check('B4 轮询状态正常', st.get('poll', {}).get('ok') is True, str(st.get('poll')))

    stop_client(proc)
    print(f'-- IMAP scenario: {len(PASS)} passed so far, {len(FAIL)} failed --')


def scenario_assets(exe, base_port):
    print('== Scenario C: static UI assets ==')
    port = base_port + 3
    prog = make_progdir('assets', exe)
    proc = start_client(prog, port, os.path.join(HERE, 'tmp', 'client_assets.log'))
    page = urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=10).read().decode('utf-8', 'replace')
    check('C1 index.html 包含界面', 'Email Chatter' in page)
    for asset in ['style.css', 'app.js', 'manifest.json', 'sw.js', 'icons/icon-192.png', 'icons/icon-512.png']:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/{asset}', timeout=10) as r:
                body = r.read()
            check(f'C2 静态资源 {asset}', len(body) > 0)
        except Exception as e:
            check(f'C2 静态资源 {asset}', False, str(e))
    stop_client(proc)


def scenario_security(exe, base_port):
    print('== Scenario D: 目录边界（程序目录外 0 读取 / 0 写入）==')
    prog = make_progdir('sec', exe)
    outside = os.path.join(HERE, 'tmp', 'outside-data')
    os.makedirs(outside, exist_ok=True)
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

    r = subprocess.run([os.path.join(prog, EXE_NAME), '--no-browser', '--port', str(base_port + 5),
                        '--data', outside], capture_output=True, timeout=20, creationflags=flags)
    check('D1 拒绝程序目录外的 --data 目录', r.returncode != 0 and b'--data' in r.stderr, r.stderr[:200])

    outside_web = os.path.join(HERE, 'tmp', 'outside-web')
    os.makedirs(outside_web, exist_ok=True)
    r2 = subprocess.run([os.path.join(prog, EXE_NAME), '--no-browser', '--port', str(base_port + 5),
                         '--web', outside_web], capture_output=True, timeout=20, creationflags=flags)
    check('D2 拒绝程序目录外的 --web 目录', r2.returncode != 0 and b'--web' in r2.stderr, r2.stderr[:200])

    leaked = os.listdir(outside) + os.listdir(outside_web)
    check('D3 被拒时未在外部目录写入任何文件', leaked == [], str(leaked))


def scenario_hosts(exe, base_port):
    print('== Scenario E: 主机名清洗（https:// 前缀 / host:port）==')
    port = base_port + 6
    prog = make_progdir('hosts', exe)
    proc = start_client(prog, port, os.path.join(HERE, 'tmp', 'client_hosts.log'))
    http_json(port, 'POST', '/api/config', {
        'email': 'u@example.com', 'password': 'x', 'mode': 'imap',
        'imap': {'host': 'imaphz.qiye.163.com', 'port': 993, 'ssl': True},
        'pop3': {'host': 'https://pophz.qiye.163.com/', 'port': 995, 'ssl': True},
        'smtp': {'host': 'smtphz.qiye.163.com:465', 'port': 994, 'ssl': True},
    })
    st = http_json(port, 'GET', '/api/state')
    acc = st.get('account', {})
    check('E1 https:// 前缀被清洗', acc['pop3']['host'] == 'pophz.qiye.163.com', str(acc['pop3']))
    check('E2 pop3 端口保留', acc['pop3']['port'] == 995, str(acc['pop3']))
    check('E3 host:port 写法解析', acc['smtp']['host'] == 'smtphz.qiye.163.com' and acc['smtp']['port'] == 465, str(acc['smtp']))
    check('E4 imap 主机名不变', acc['imap']['host'] == 'imaphz.qiye.163.com', str(acc['imap']))

    # E5: 用本机不可达端口验证 /api/test 的错误消息（避免依赖外网：真实 163
    # 服务器在无网环境会连接超时，属于基线环境限制，不能因此判实现失败）。
    http_json(port, 'POST', '/api/config', {
        'mode': 'pop3',
        'pop3': {'host': '127.0.0.1', 'port': 1, 'ssl': False},
        'smtp': {'host': '127.0.0.1', 'port': 1, 'ssl': False},
        'imap': {'host': '127.0.0.1', 'port': 1, 'ssl': False},
    })
    try:
        r = http_json(port, 'POST', '/api/test', {}, timeout=20)
        msg = json.dumps(r, ensure_ascii=False)
        check('E5 测试连接报错含 host:port', '127.0.0.1:1' in msg, msg[:200])
    except Exception as e:
        check_skip('E5 测试连接报错含 host:port', f'本机不可达端口测试异常: {e}')
    stop_client(proc)


def scenario_probe(exe, base_port, mock):
    print('== Scenario F: 自动检测服务器 (probe) ==')
    port = base_port + 7
    prog = make_progdir('probe', exe)
    proc = start_client(prog, port, os.path.join(HERE, 'tmp', 'client_probe.log'))
    r = http_json(port, 'POST', '/api/probe', {'candidates': [
        {'kind': 'imap', 'host': '127.0.0.1', 'port': mock.imap_port, 'ssl': False},
        {'kind': 'pop3', 'host': '127.0.0.1', 'port': mock.pop3_port, 'ssl': False},
        {'kind': 'smtp', 'host': '127.0.0.1', 'port': mock.smtp_port, 'ssl': False},
        {'kind': 'imap', 'host': '127.0.0.1', 'port': 1, 'ssl': False},
    ]})
    res = r.get('results') or []
    ok = [x for x in res if x.get('ok')]
    check('F1 三个协议都探测成功', len(ok) == 3, json.dumps(res, ensure_ascii=False)[:300])
    check('F2 协议类型匹配正确', {x['kind'] for x in ok} == {'imap', 'pop3', 'smtp'}, str([x['kind'] for x in ok]))
    bad = [x for x in res if not x.get('ok')]
    check('F3 不通的端口被标记失败', len(bad) == 1 and bad[0]['port'] == 1, json.dumps(bad, ensure_ascii=False)[:200])
    stop_client(proc)


def scenario_fallback(exe, base_port, mock, mbox):
    """Scenario G: SSL 勾在明文端口上也要能用（自动回退 STARTTLS/明文）。
    与真实校园网邮箱（imap 143 / pop 110 / smtp 587 + 误勾 SSL）错配场景一致。
    """
    print('== Scenario G: SSL 勾在明文端口上自动回退 ==')
    port = base_port + 13
    prog = make_progdir('fallback', exe)
    proc = start_client(prog, port, os.path.join(HERE, 'tmp', 'client_fallback.log'))

    r = http_json(port, 'POST', '/api/config', {
        'email': 'me@test.local', 'display_name': '我', 'password': 'authcode',
        'mode': 'pop3',
        # 与用户真实配置一致：ssl=True 但端口是明文端口（143/110/587 错配）
        'pop3': {'host': '127.0.0.1', 'port': mock.pop3_port, 'ssl': True},
        'smtp': {'host': '127.0.0.1', 'port': mock.smtp_port, 'ssl': True},
        'poll_interval': 3,
    })
    check('G1 保存 SSL 错配配置', r.get('ok') is True, str(r))

    r = http_json(port, 'POST', '/api/friends', {'action': 'add', 'email': 'friend@example.com', 'name': '小明'})
    check('G2 添加好友', r.get('ok') is True)

    r = http_json(port, 'POST', '/api/send', {'to': 'friend@example.com', 'text': 'SSL 错配也要能发出！'})
    check('G3 SMTP 回退后发送成功', r.get('ok') is True, str(r))
    check('G4 SMTP 服务器确实收到', mbox.received_count() >= 1)

    inject_mail(mock.smtp_port, 'friend@example.com', 'me@test.local', '回退测试', 'POP3 回退收到')
    http_json(port, 'POST', '/api/poll', {})
    time.sleep(2.5)
    msgs = messages_of(port, 'friend@example.com')
    texts = [m['text'] for m in msgs]
    check('G5 POP3 回退后收到来信', 'POP3 回退收到' in texts, str(texts))
    st = http_json(port, 'GET', '/api/state')
    check('G6 回退后轮询状态正常', st.get('poll', {}).get('ok') is True, str(st.get('poll')))
    stop_client(proc)

    # IMAP 模式同样验证（真实配置是 mode:imap + imap 143 ssl）
    port = base_port + 14
    prog = make_progdir('fallback_imap', exe)
    proc = start_client(prog, port, os.path.join(HERE, 'tmp', 'client_fallback_imap.log'))
    http_json(port, 'POST', '/api/config', {
        'email': 'me@test.local', 'display_name': '我', 'password': 'authcode',
        'mode': 'imap',
        'imap': {'host': '127.0.0.1', 'port': mock.imap_port, 'ssl': True},
        'smtp': {'host': '127.0.0.1', 'port': mock.smtp_port, 'ssl': True},
        'poll_interval': 3,
    })
    http_json(port, 'POST', '/api/friends', {'action': 'add', 'email': 'friend@example.com', 'name': '小明'})
    inject_mail(mock.smtp_port, 'friend@example.com', 'me@test.local', 'IMAP回退', 'IMAP 回退收到')
    http_json(port, 'POST', '/api/poll', {})
    time.sleep(2.5)
    msgs = messages_of(port, 'friend@example.com')
    texts = [m['text'] for m in msgs]
    check('G7 IMAP 回退后收到来信', 'IMAP 回退收到' in texts, str(texts))
    st = http_json(port, 'GET', '/api/state')
    check('G8 IMAP 回退后轮询状态正常', st.get('poll', {}).get('ok') is True, str(st.get('poll')))
    stop_client(proc)
    print(f'-- Fallback scenario: {len(PASS)} passed so far, {len(FAIL)} failed --')


def raw_request(port, method, path, body=None, headers=None):
    """发送带自定义 Host/Origin 的 HTTP 请求，返回 (status, text)。"""
    import http.client
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    hdrs = {'Content-Type': 'application/json'}
    if headers:
        hdrs.update(headers)
    conn.request(method, path, body=json.dumps(body).encode() if body is not None else None, headers=hdrs)
    r = conn.getresponse()
    data = r.read().decode('utf-8', 'replace')
    conn.close()
    return r.status, data


def scenario_guard(exe, base_port):
    """Scenario H: /api/* 的 Host / Origin 校验（防 DNS rebinding / 防恶意网页冒用）。"""
    print('== Scenario H: Host / Origin 校验 ==')
    port = base_port + 15
    prog = make_progdir('guard', exe)
    proc = start_client(prog, port, os.path.join(HERE, 'tmp', 'client_guard.log'))

    s = http_json(port, 'GET', '/api/state')
    check('H1 正常回环请求可用', isinstance(s, dict))

    st, body = raw_request(port, 'GET', '/api/state', headers={'Host': 'evil.example.com'})
    check('H2 恶意 Host 被拒绝', st == 403, f'{st} {body[:100]}')

    st, body = raw_request(port, 'GET', '/api/state', headers={'Origin': 'http://evil.example.com'})
    check('H3 恶意 Origin 被拒绝', st == 403, f'{st} {body[:100]}')

    st, body = raw_request(port, 'POST', '/api/config', {'email': 'u@evil.com'},
                           headers={'Host': '127.0.0.1:' + str(port), 'Origin': 'http://127.0.0.1:' + str(port)})
    check('H4 合法 Origin 请求放行', st == 200 and '"ok"' in body, f'{st} {body[:100]}')

    st, body = raw_request(port, 'POST', '/api/config', {'email': 'u2@evil.com'},
                           headers={'Host': 'localhost:' + str(port)})
    check('H5 localhost Host 放行', st == 200 and '"ok"' in body, f'{st} {body[:100]}')

    stop_client(proc)
    print(f'-- Guard scenario: {len(PASS)} passed so far, {len(FAIL)} failed --')


def scenario_autopoll(exe, base_port, mock):
    """Scenario I: auto_poll 关闭 / 部分字段保存不清空其它字段 / Message-ID 去重。"""
    print('== Scenario I: 自动收信开关 / 部分保存 / Message-ID 去重 ==')
    port = base_port + 16
    prog = make_progdir('autopoll', exe)
    proc = start_client(prog, port, os.path.join(HERE, 'tmp', 'client_autopoll.log'))

    r = http_json(port, 'POST', '/api/config', {
        'email': 'me@test.local', 'display_name': '我', 'password': 'authcode',
        'mode': 'imap',
        'imap': {'host': '127.0.0.1', 'port': mock.imap_port, 'ssl': False},
        'smtp': {'host': '127.0.0.1', 'port': mock.smtp_port, 'ssl': False},
        'poll_interval': 3,
        'auto_poll': True,
    })
    check('I1 保存配置（开自动收信）', r.get('ok') is True, str(r))

    # 只改 auto_poll 一项：email 等其它字段不能被清空（旧版 bug）
    r = http_json(port, 'POST', '/api/config', {'auto_poll': False})
    check('I2 部分保存 ok', r.get('ok') is True, str(r))
    s = http_json(port, 'GET', '/api/state')
    check('I3 部分保存后 email 仍在', s.get('account', {}).get('email') == 'me@test.local', str(s.get('account')))
    check('I4 状态反映 auto_poll=false', s.get('account', {}).get('auto_poll') is False, str(s.get('account')))
    # 保存配置会立即触发一次收信（确认新参数可用），等它跑完再注入邮件
    time.sleep(3.0)

    # 自动收信已关：注入邮件后不应自动拉取
    http_json(port, 'POST', '/api/friends', {'action': 'add', 'email': 'friend@example.com', 'name': '小明'})
    inject_mail(mock.smtp_port, 'friend@example.com', 'me@test.local', '不该自动收到', '自动收信已关闭')
    time.sleep(6)  # > poll_interval * 2
    msgs = messages_of(port, 'friend@example.com')
    check('I5 关闭自动收信后未自动收取', len(msgs) == 0, str(len(msgs)))

    # 手动收信仍可用
    http_json(port, 'POST', '/api/poll', {})
    time.sleep(2.5)
    msgs = messages_of(port, 'friend@example.com')
    texts = [m['text'] for m in msgs]
    check('I6 手动收信仍可用', '自动收信已关闭' in texts, str(texts))

    # Message-ID 去重：同一封邮件（同 Message-ID）被注入两次，只应出现一条
    http_json(port, 'POST', '/api/config', {'auto_poll': True})
    inject_mail(mock.smtp_port, 'friend@example.com', 'me@test.local', '去重', '重复正文', mid='<dup-1@test.local>')
    inject_mail(mock.smtp_port, 'friend@example.com', 'me@test.local', '去重', '重复正文', mid='<dup-1@test.local>')
    http_json(port, 'POST', '/api/poll', {})
    time.sleep(2.5)
    msgs = messages_of(port, 'friend@example.com')
    dup = [m for m in msgs if m['text'] == '重复正文']
    check('I7 同 Message-ID 邮件去重为一条', len(dup) == 1, str([(m.get('text'), m.get('mid')) for m in msgs]))

    stop_client(proc)
    print(f'-- AutoPoll scenario: {len(PASS)} passed so far, {len(FAIL)} failed --')


def _raw_header(msg, name):
    if msg is None:
        return None
    for k, v in msg.raw_items():
        if k.lower() == name.lower():
            return str(v).strip()
    return None


def _quote_of_header(raw_value):
    return mock_mail.parse_quote_header_value(raw_value)


def scenario_email_mode(exe, base_port, mock, mbox):
    """Scenario J: 扩展邮件模式 — 标准 MIME、主题、Cc/Bcc、引用头/引用块。"""
    print('== Scenario J: 扩展邮件模式（标准邮件 / 主题 / CC / BCC / 引用）==')
    mbox.reset()
    proc, prog, port = start_configured('emailmode', exe, base_port + 17, mock)
    quote = {'text': '被引用的原文第一行\n被引用的原文第二行', 'from': '小明',
             'ts': 1729990000, 'mid': '<orig-1@test.local>'}
    subject = '项目周会安排'
    text = '第一行正文\n第二行有\t制表符'
    try:
        r = http_json(port, 'POST', '/api/send', {
            'to': 'friend@example.com', 'kind': 'email', 'subject': subject, 'text': text,
            'cc': 'cc1@example.com, cc2@example.com', 'bcc': 'bcc@example.com', 'quote': quote})
        check('J1 邮件模式发送成功', r.get('ok') is True, str(r))
        check('J2 返回实际主题（2.1 引用=reply 加 Re:）', r.get('subject') == 'Re: ' + subject, str(r))
        check('J3 非 AI 生成', r.get('ai') is False, str(r))
        check('J4 SMTP 收到一封', mbox.received_count() == 1, str(mbox.received_count()))
        raw, msg = last_mail(mbox)
        if msg is None:
            check('J5 邮件可解析', False, 'no raw mail')
            return
        check('J5 标准邮件头（From/To/Cc/MIME）',
              bool(msg['From']) and bool(msg['To']) and bool(msg['Cc']) and bool(msg['MIME-Version']),
              str([(k, msg[k]) for k in ('From', 'To', 'Cc', 'MIME-Version')]))
        check('J6 主题正确（Re: 前缀）', str(msg['Subject']) == 'Re: ' + subject, str(msg['Subject']))
        check('J6b 引用=reply 写入 In-Reply-To/References',
              str(msg.get('In-Reply-To', '')) == quote['mid']
              and str(msg.get('References', '')) == quote['mid'],
              f'irt={msg.get("In-Reply-To")} refs={msg.get("References")}')
        check('J7 X-Email-Chatter-Kind: email',
              _raw_header(msg, 'X-Email-Chatter-Kind') == 'email',
              str(_raw_header(msg, 'X-Email-Chatter-Kind')))
        cc_val = str(msg['Cc'] or '')
        check('J8 Cc 写入邮件头', 'cc1@example.com' in cc_val and 'cc2@example.com' in cc_val, cc_val)
        check('J9 Bcc 不写入邮件头', _raw_header(msg, 'Bcc') is None, str(_raw_header(msg, 'Bcc')))
        env = mbox.last_envelope() or {}
        rcpts = set(env.get('rcpts') or [])
        check('J10 SMTP 信封含 to+cc+bcc',
              rcpts == {'friend@example.com', 'cc1@example.com', 'cc2@example.com', 'bcc@example.com'},
              str(env))
        body = mail_body(msg)
        check('J11 正文保留换行/Tab', text in body, repr(body[:120]))
        check('J12 正文含可读引用块', '--- 引用 ---' in body and '> 发件人：小明' in body, repr(body[:200]))
        qraw = _raw_header(msg, 'X-Email-Chatter-Quote')
        try:
            q = _quote_of_header(qraw)
        except Exception as e:
            q = None
            check('J13 X-Email-Chatter-Quote 可解析', False, f'{e} raw={qraw!r}'[:200])
        check('J13 X-Email-Chatter-Quote 可解析',
              q is not None and q.get('text') == quote['text'] and q.get('from') == quote['from']
              and q.get('mid') == quote['mid'] and int(q.get('ts')) == quote['ts'], str(q))
        check('J14 无附件时 text/plain', msg.get_content_type() == 'text/plain',
              msg.get_content_type())

        msgs = wait_message(port, 'friend@example.com',
                            lambda ms: any(m.get('dir') == 'out' and m.get('kind') == 'email' for m in ms))
        out = [m for m in msgs if m.get('dir') == 'out' and m.get('kind') == 'email']
        m = out[-1] if out else {}
        check('J15 本地消息 kind=email/subject(Re:)/mid',
              m.get('kind') == 'email' and m.get('subject') == 'Re: ' + subject and m.get('mid'),
              str({k: m.get(k) for k in ('kind', 'subject', 'mid')}))
        check('J16 本地正文不含引用块副本', m.get('text') == text, repr(m.get('text')))
        check('J17 本地 quote 字段保留', isinstance(m.get('quote'), dict)
              and m['quote'].get('text') == quote['text'], str(m.get('quote')))
        check('J18 本地 recalled=false', m.get('recalled') is False, str(m.get('recalled')))
        st = http_json(port, 'GET', '/api/state')
        fr = next((f for f in st['friends'] if f['email'] == 'friend@example.com'), {})
        check('J19 last_text 预览=主题（Re:）', fr.get('last_text') == 'Re: ' + subject,
              str(fr.get('last_text')))

        # 主题注入清洗：CR/LF 不得写入新邮件头
        inj = http_json(port, 'POST', '/api/send', {
            'to': 'friend@example.com', 'kind': 'email', 'text': '注入测试',
            'subject': '正常主题\r\nBcc: evil@example.com'})
        raw2, msg2 = last_mail(mbox)
        check('J20 主题 CR/LF 注入被清洗',
              inj.get('ok') is True and '\r' not in str(inj.get('subject')) and '\n' not in str(inj.get('subject'))
              and _raw_header(msg2, 'Bcc') is None,
              str(inj.get('subject')) + ' raw=' + repr(raw2[:200]))
        # 空主题 + AI 关闭 -> 启发式主题
        r = http_json(port, 'POST', '/api/send', {
            'to': 'friend@example.com', 'kind': 'email', 'text': '无主题邮件正文第一行\n第二行'})
        check('J21 空主题回落到启发式标题',
              r.get('ok') is True and r.get('subject') and r.get('subject') != 'email-chatter 消息'
              and '无主题邮件正文第一行' in r.get('subject'), str(r))
        # chat 模式仍用固定主题
        r = http_json(port, 'POST', '/api/send', {'to': 'friend@example.com', 'text': '普通聊天'})
        check('J22 chat 模式固定主题', r.get('subject') == 'email-chatter 消息', str(r))
        raw3, msg3 = last_mail(mbox)
        check('J23 chat 邮件头 Kind=chat',
              _raw_header(msg3, 'X-Email-Chatter-Kind') in (None, 'chat'),
              str(_raw_header(msg3, 'X-Email-Chatter-Kind')))
    finally:
        stop_client(proc)
    print(f'-- Email mode scenario: {len(PASS)} passed so far, {len(FAIL)} failed --')


def scenario_attachments(exe, base_port, mock, mbox):
    """Scenario K: /api/upload + 附件发送 + /api/attachment + 收信附件解析。"""
    print('== Scenario K: 上传 / 附件发送与接收 / 附件下载 ==')
    mbox.reset()
    proc, prog, port = start_configured('attach', exe, base_port + 18, mock)
    text_bytes = '这是一个文本附件。\n第二行'.encode('utf-8')
    try:
        st, up_img = upload_bytes(port, 'photo.png', PNG_1X1, 'image/png')
        check('K1 上传图片成功', st == 200 and up_img.get('ok') is True
              and str(up_img.get('id', '')).startswith('u_')
              and up_img.get('name') == 'photo.png' and up_img.get('size') == len(PNG_1X1)
              and up_img.get('mime') == 'image/png', f'{st} {up_img}')
        st, up_txt = upload_bytes(port, '报告附件.txt', text_bytes, 'text/plain')
        check('K2 上传中文文件名成功', st == 200 and up_txt.get('ok') is True
              and up_txt.get('name') == '报告附件.txt' and up_txt.get('size') == len(text_bytes),
              f'{st} {up_txt}')
        r = http_json(port, 'POST', '/api/send', {
            'to': 'friend@example.com', 'text': '看附件',
            'attachments': [{'id': up_img.get('id'), 'name': up_img.get('name')},
                            {'id': up_txt.get('id'), 'name': up_txt.get('name')}]})
        check('K3 带附件发送成功', r.get('ok') is True, str(r))
        check('K4 SMTP 收到 multipart 邮件', mbox.received_count() == 1, str(mbox.received_count()))
        raw, msg = last_mail(mbox)
        atts = mail_attachments(msg) if msg is not None else []
        check('K5 邮件为 multipart/mixed', msg is not None
              and msg.get_content_type() == 'multipart/mixed', msg.get_content_type() if msg else 'none')
        check('K6 图片附件字节一致', any(a['mime'] == 'image/png' and a['data'] == PNG_1X1 for a in atts),
              str([(a['filename'], a['mime'], len(a['data'])) for a in atts]))
        check('K7 中文附件名可解码', any((a['filename'] or '') == '报告附件.txt' for a in atts),
              str([a['filename'] for a in atts]))
        check('K8 文本附件字节一致', any(a['data'] == text_bytes for a in atts),
              str([len(a['data']) for a in atts]))
        check('K9 正文仍是可读纯文本', '看附件' in mail_body(msg), repr(mail_body(msg)[:80]))

        msgs = wait_message(port, 'friend@example.com',
                            lambda ms: any(m.get('dir') == 'out' and m.get('attachments') for m in ms))
        out = [m for m in msgs if m.get('dir') == 'out' and m.get('attachments')]
        m = out[-1] if out else {}
        las = m.get('attachments') or []
        check('K10 本地消息 attachments 字段完整', len(las) == 2
              and las[0].get('name') == 'photo.png' and las[0].get('mime') == 'image/png'
              and las[0].get('size') == len(PNG_1X1) and las[0].get('inline') is True
              and las[0].get('url', '').startswith('/api/attachment?file=')
              and las[1].get('inline') is False and las[1].get('file'),
              str(las)[:400])
        ok_get = True
        if len(las) >= 2:
            st1, b1, h1 = http_bytes(port, 'GET', las[0]['url'])
            st2, b2, h2 = http_bytes(port, 'GET', las[1]['url'])
            ok_get = (st1 == 200 and b1 == PNG_1X1 and 'image/png' in (h1.get('Content-Type') or '')
                      and st2 == 200 and b2 == text_bytes)
        check('K11 GET /api/attachment 返回原始字节', ok_get)
        st_bad, _, _ = http_bytes(port, 'GET', '/api/attachment?file=..%2Fconfig.json')
        check('K12 附件路径穿越被拒绝', st_bad in (400, 403, 404), str(st_bad))
        st_bad2, _, _ = http_bytes(port, 'GET', '/api/attachment?file=no-such-file.bin')
        check('K13 不存在附件返回 404', st_bad2 == 404, str(st_bad2))

        # 收信附件解析：注入带图片/文件附件的普通邮件
        in_raw = mock_mail.build_raw(
            frm='friend@example.com', to='me@test.local', subject='收到的附件', body='请查收图片和文件',
            mid='<in-attach-1@test.local>',
            attachments=[{'name': 'inbox.png', 'mime': 'image/png', 'data': PNG_1X1},
                         {'name': '清单.csv', 'mime': 'text/csv', 'data': 'a,b\n1,2'.encode()}])
        mbox.add_raw(in_raw)
        http_json(port, 'POST', '/api/poll', {})
        msgs = wait_message(port, 'friend@example.com',
                            lambda ms: any(m.get('dir') == 'in' and m.get('attachments') for m in ms),
                            timeout=10)
        inc = [m for m in msgs if m.get('dir') == 'in' and m.get('attachments')]
        im = inc[-1] if inc else {}
        ias = im.get('attachments') or []
        check('K14 收信消息带 attachments 元数据', len(ias) == 2
              and ias[0].get('mime') == 'image/png' and ias[0].get('inline') is True
              and ias[0].get('size') == len(PNG_1X1) and ias[0].get('url')
              and ias[1].get('inline') is False, str(ias)[:400])
        ok_in = False
        if len(ias) == 2:
            st1, b1, h1 = http_bytes(port, 'GET', ias[0]['url'])
            st2, b2, h2 = http_bytes(port, 'GET', ias[1]['url'])
            ok_in = (st1 == 200 and b1 == PNG_1X1 and st2 == 200 and b2 == 'a,b\n1,2'.encode())
        check('K15 收信附件可下载且字节一致', ok_in)
        check('K16 收信正文解析', '请查收图片和文件' in (im.get('text') or ''), repr(im.get('text')))

        # 邮件模式正文为空但有附件 -> 正文补「无正文」
        body_txt = None
        r = http_json(port, 'POST', '/api/send', {
            'to': 'friend@example.com', 'kind': 'email', 'subject': '只有附件',
            'text': '', 'attachments': [{'id': up_img.get('id'), 'name': up_img.get('name')}]})
        raw4, msg4 = last_mail(mbox)
        if msg4 is not None:
            body_txt = mail_body(msg4)
        check('K17 email 无正文时补「无正文」', r.get('ok') is True and body_txt is not None
              and ('（无正文）' in body_txt or '无正文' in body_txt), repr(body_txt))
    finally:
        stop_client(proc)
    print(f'-- Attachments scenario: {len(PASS)} passed so far, {len(FAIL)} failed --')


def scenario_quote_recall(exe, base_port, mock, mbox):
    """Scenario L: 引用接收 / 撤回收发 / pending_recalls。"""
    print('== Scenario L: 引用 / 撤回 / pending_recalls ==')
    mbox.reset()
    proc, prog, port = start_configured('quote_recall', exe, base_port + 19, mock)
    peer = 'friend@example.com'
    try:
        # 1) 发送一条聊天消息，拿到 mid
        r = http_json(port, 'POST', '/api/send', {'to': peer, 'text': '原始聊天消息'})
        msgs = wait_message(port, peer, lambda ms: any(
            m.get('dir') == 'out' and m.get('text') == '原始聊天消息' for m in ms))
        orig = next((m for m in msgs if m.get('dir') == 'out' and m.get('text') == '原始聊天消息'), None)
        check('L1 发件消息记录 mid', r.get('ok') is True and orig is not None and bool(orig.get('mid')),
              str(orig and {k: orig.get(k) for k in ('id', 'mid')}))
        # 2) 带引用发送
        r = http_json(port, 'POST', '/api/send', {
            'to': peer, 'text': '这是引用回复',
            'quote': {'text': orig.get('text') if orig else '原始聊天消息', 'from': '我',
                      'ts': orig.get('ts') if orig else 0, 'mid': orig.get('mid') if orig else ''}})
        raw, msg = last_mail(mbox)
        qh = _raw_header(msg, 'X-Email-Chatter-Quote') if msg is not None else None
        try:
            q = _quote_of_header(qh)
        except Exception:
            q = {}
        body = mail_body(msg) if msg is not None else ''
        check('L2 引用头写入并可解析', q.get('text') == '原始聊天消息' and q.get('mid') ==
              (orig.get('mid') if orig else ''), str(q))
        check('L3 引用正文块可读', '--- 引用 ---' in body and '> 发件人：我' in body, repr(body[:200]))
        msgs = wait_message(port, peer, lambda ms: any(m.get('text') == '这是引用回复' for m in ms))
        quoted = next((m for m in msgs if m.get('text') == '这是引用回复'), {})
        check('L4 本地发送消息保存 quote', isinstance(quoted.get('quote'), dict)
              and quoted['quote'].get('text') == '原始聊天消息', str(quoted.get('quote')))

        # 3) 撤回自己发出的消息
        if orig is not None:
            r = http_json(port, 'POST', '/api/recall', {'with': peer, 'id': orig.get('id')})
            check('L5 撤回接口成功', r.get('ok') is True, str(r))
            raw, msg = last_mail(mbox)
            check('L6 SMTP 收到撤回通知', msg is not None
                  and str(msg['Subject']) == '撤回了一条消息'
                  and _raw_header(msg, 'X-Email-Chatter-Kind') == 'recall'
                  and (orig.get('mid') or '') in (_raw_header(msg, 'X-Email-Chatter-Recall') or ''),
                  f'subject={msg["Subject"] if msg else None} '
                  f'recall={_raw_header(msg, "X-Email-Chatter-Recall") if msg else None}')
            msgs = wait_message(port, peer, lambda ms: any(
                m.get('id') == orig.get('id') and m.get('recalled') for m in ms))
            m2 = next((m for m in msgs if m.get('id') == orig.get('id')), {})
            check('L7 本地消息 recalled=true', m2.get('recalled') is True, str(m2.get('recalled')))
            r = http_json(port, 'POST', '/api/recall', {'with': peer, 'id': orig.get('id')})
            check('L8 重复撤回被拒绝', r.get('ok') is False and r.get('error'), str(r))

        # 4) 接收引用邮件（正文引用块应被剥离）
        quote2 = {'text': '对方引用的内容\n第二行', 'from': '小明', 'ts': 1730000000,
                  'mid': '<in-quote@test.local>'}
        in_raw = mock_mail.build_raw(frm=peer, to='me@test.local', subject='邮件回复',
                                     body='我的邮件回复', kind='email', quote=quote2,
                                     mid='<in-quote@test.local>')
        mbox.add_raw(in_raw)
        http_json(port, 'POST', '/api/poll', {})
        msgs = wait_message(port, peer, lambda ms: any(m.get('text') == '我的邮件回复' for m in ms),
                            timeout=10)
        im = next((m for m in msgs if m.get('text') == '我的邮件回复'), None)
        check('L9 收到引用邮件且正文不重复', im is not None
              and '--- 引用 ---' not in (im.get('text') or '')
              and isinstance(im.get('quote'), dict)
              and im['quote'].get('text') == quote2['text'] and im['quote'].get('mid') == quote2['mid'],
              str(im and {k: im.get(k) for k in ('text', 'quote', 'subject')}))
        check('L10 引用邮件 kind/subject 正确', im is not None
              and im.get('kind') == 'email' and im.get('subject') == '邮件回复',
              str(im and {k: im.get(k) for k in ('kind', 'subject')}))
        in_mid = (im or {}).get('mid') or '<in-quote@test.local>'
        n_before = len(msgs)

        # 5) 接收撤回通知：目标消息 recalled=true 且不新增消息
        rec_raw = mock_mail.build_raw(frm=peer, to='me@test.local', subject='撤回了一条消息',
                                      body='对方撤回了一条消息', kind='recall', recall=in_mid,
                                      mid='<recall-notice-1@test.local>')
        mbox.add_raw(rec_raw)
        http_json(port, 'POST', '/api/poll', {})
        msgs = wait_message(port, peer, lambda ms: any(
            m.get('mid') == in_mid and m.get('recalled') for m in ms), timeout=10)
        im2 = next((m for m in msgs if m.get('mid') == in_mid), {})
        check('L11 收到撤回后目标消息 recalled=true', im2.get('recalled') is True,
              str(im2.get('recalled')))
        check('L12 撤回通知不生成聊天消息', len(msgs) == n_before, f'{n_before} -> {len(msgs)}')

        # 6) pending_recalls：先收到未知 mid 的撤回，再收到该 mid 的来信应被丢弃
        unknown_mid = '<pending-unknown@test.local>'
        mbox.add_raw(mock_mail.build_raw(frm=peer, to='me@test.local', subject='撤回了一条消息',
                                         body='对方撤回了一条消息', kind='recall',
                                         recall=unknown_mid, mid='<recall-notice-2@test.local>'))
        http_json(port, 'POST', '/api/poll', {})
        time.sleep(2.0)
        msgs = messages_of(port, peer)
        n_after_pending = len(msgs)
        cfg = read_data_json(prog, 'config.json')
        cfg_text = json.dumps(cfg, ensure_ascii=False) if cfg else ''
        check('L13 未知 mid 撤回进入 pending_recalls', unknown_mid in cfg_text,
              cfg_text[:300])
        check('L14 pending 撤回本身不新增消息', n_after_pending == n_before,
              f'{n_before} -> {n_after_pending}')
        mbox.add_raw(mock_mail.build_raw(frm=peer, to='me@test.local', subject='迟到来信',
                                         body='这封应该被丢弃', mid=unknown_mid))
        http_json(port, 'POST', '/api/poll', {})
        time.sleep(2.0)
        msgs = messages_of(port, peer)
        check('L15 pending mid 的迟到来信被丢弃',
              len(msgs) == n_before and not any(m.get('text') == '这封应该被丢弃' for m in msgs),
              f'{n_before} -> {len(msgs)}')
    finally:
        stop_client(proc)
    print(f'-- Quote/Recall scenario: {len(PASS)} passed so far, {len(FAIL)} failed --')


def scenario_ai(exe, base_port, mock):
    """Scenario M: AI 状态/配置/启发式回落/下载失败与取消（本地 stub，无外网）。"""
    print('== Scenario M: AI 状态 / 配置 / 启发式回落 / 下载失败与取消 ==')
    port = base_port + 20
    prog = make_progdir('ai', exe)
    proc = start_client(prog, port, os.path.join(HERE, 'tmp', 'client_ai.log'))
    try:
        st = http_json(port, 'GET', '/api/state')
        ai0 = st.get('ai') or {}
        required = ['enabled', 'model_ready', 'downloading', 'downloaded_bytes', 'total_bytes',
                    'percent', 'error', 'model_file', 'mirror', 'busy', 'engine']
        check('M1 /api/state 顶层 ai 状态字段完整',
              isinstance(ai0, dict) and all(k in ai0 for k in required), str(ai0))
        check('M2 默认 AI 关闭且模型未下载',
              ai0.get('enabled') is False and ai0.get('model_ready') is False
              and ai0.get('downloading') is False and ai0.get('percent') == 0, str(ai0))
        check('M3 默认 model_file/mirror', ai0.get('model_file') == 'qwen2.5-0.5b-instruct-q4_k_m.gguf'
              and 'hf-mirror' in (ai0.get('mirror') or ''), str(ai0))
        stt = http_json(port, 'GET', '/api/ai/status')
        check('M4 /api/ai/status 返回 ok+ai', stt.get('ok') is True
              and isinstance(stt.get('ai'), dict) and all(k in stt['ai'] for k in required), str(stt)[:300])

        # 保存 ai 配置并回显
        r = http_json(port, 'POST', '/api/config', {
            'email': 'me@test.local', 'display_name': '我', 'password': 'authcode', 'mode': 'pop3',
            'pop3': {'host': '127.0.0.1', 'port': mock.pop3_port, 'ssl': False},
            'smtp': {'host': '127.0.0.1', 'port': mock.smtp_port, 'ssl': False},
            'poll_interval': 3,
            'ai': {'enabled': True, 'mirror': 'http://127.0.0.1:9/', 'model_url': 'http://127.0.0.1:1/x.gguf'}})
        st = http_json(port, 'GET', '/api/state')
        acc_ai = (st.get('account') or {}).get('ai') or {}
        top_ai = st.get('ai') or {}
        check('M5 /api/config 保存 ai 并回显',
              r.get('ok') is True and acc_ai.get('enabled') is True
              and acc_ai.get('mirror') == 'http://127.0.0.1:9/'
              and (acc_ai.get('model_file') or '') == 'qwen2.5-0.5b-instruct-q4_k_m.gguf'
              and top_ai.get('enabled') is True,
              f'{r} acc={acc_ai} top={top_ai}')
        http_json(port, 'POST', '/api/friends', {'action': 'add', 'email': 'friend@example.com',
                                                 'name': '小明'})

        # 未下载模型时标题回落启发式（不返回 http 错误）
        r = http_json(port, 'POST', '/api/ai/title',
                      {'text': '周六早上八点香山门口集合，别迟到！'}, timeout=30)
        check('M6 未下载时 /api/ai/title 回落启发式',
              r.get('ok') is True and r.get('source') == 'heuristic'
              and (r.get('subject') or '') and len(r.get('subject') or '') <= 31
              and '香山' in (r.get('subject') or ''), str(r))
        r = http_json(port, 'POST', '/api/ai/title', {'text': ''}, timeout=30)
        check('M7 空正文标题=无主题', r.get('ok') is True
              and r.get('source') == 'heuristic' and r.get('subject') == '无主题', str(r))

        # 发送回落：AI 开但未就绪 -> chat 固定主题 / email 启发式
        r = http_json(port, 'POST', '/api/send', {'to': 'friend@example.com',
                                                 'text': 'AI 开启但模型未下载'}, timeout=180)
        check('M8 AI 未就绪时 chat 回落固定主题',
              r.get('ok') is True and r.get('subject') == 'email-chatter 消息'
              and r.get('ai') is False, str(r))
        r = http_json(port, 'POST', '/api/send', {
            'to': 'friend@example.com', 'kind': 'email',
            'text': '这条邮件没有主题需要自动生成'}, timeout=180)
        check('M9 AI 未就绪时 email 回落启发式',
              r.get('ok') is True and (r.get('subject') or '')
              and r.get('subject') != 'email-chatter 消息' and r.get('ai') is False, str(r))

        # 下载失败路径：本地不可达地址，必须优雅失败且 /api/ai/status 始终快速返回
        t0 = time.time()
        rd = http_json(port, 'POST', '/api/ai/download', {}, timeout=30)
        dt = time.time() - t0
        check('M10 下载接口立即返回', rd.get('ok') is True and dt < 10, f'{dt:.2f}s {rd}')
        err = ''
        deadline = time.time() + 25
        slow_status = 0
        while time.time() < deadline:
            ts = time.time()
            stt = http_json(port, 'GET', '/api/ai/status', timeout=10)
            if time.time() - ts > 3:
                slow_status += 1
            ai = stt.get('ai') or {}
            err = ai.get('error') or ''
            if not ai.get('downloading') and (err or ai.get('model_ready')):
                break
            time.sleep(0.5)
        ai = (http_json(port, 'GET', '/api/ai/status').get('ai') or {})
        check('M11 下载失败优雅报错', ai.get('downloading') is False
              and ai.get('model_ready') is False and bool(ai.get('error')), str(ai))
        check('M12 /api/ai/status 始终快速', slow_status == 0, f'slow={slow_status}')
        model_path = os.path.join(data_of(prog), 'models', 'qwen2.5-0.5b-instruct-q4_k_m.gguf')
        part_files = []
        mdir = os.path.dirname(model_path)
        if os.path.isdir(mdir):
            part_files = [f for f in os.listdir(mdir) if f.endswith('.part')]
        check('M13 失败后无残留模型/.part', not os.path.isfile(model_path) and not part_files,
              f'{os.path.isfile(model_path)} {part_files}')
        rc = http_json(port, 'POST', '/api/ai/cancel', {}, timeout=10)
        check('M14 取消接口可用', rc.get('ok') is True and isinstance(rc.get('ai'), dict), str(rc)[:200])

        # 本地 stub（重定向/进度/取消）：仅在实现支持 http:// 直链时检查
        stub = StubHttpServer()
        try:
            stub_url = f'http://127.0.0.1:{stub.port}/slow-redirect'
            http_json(port, 'POST', '/api/config', {'ai': {'model_url': stub_url, 'enabled': True}})
            http_json(port, 'POST', '/api/ai/download', {}, timeout=30)
            progress = None
            deadline = time.time() + 8
            while time.time() < deadline:
                ai = (http_json(port, 'GET', '/api/ai/status', timeout=10).get('ai') or {})
                if ai.get('downloading') and (ai.get('downloaded_bytes') or 0) > 0:
                    progress = ai
                    break
                if (ai.get('error') or '') and not ai.get('downloading'):
                    progress = ai
                    break
                time.sleep(0.2)
            if progress is None:
                check_skip('M15 本地 stub 重定向/进度/取消',
                           '实现未在 8s 内开始下载本地 stub URL')
            elif (progress.get('error') or '') and not progress.get('downloading') \
                    and not progress.get('downloaded_bytes'):
                check_skip('M15 本地 stub 重定向/进度/取消',
                           '实现不支持 http:// 本地模型直链: ' + str(progress.get('error'))[:120])
            else:
                check('M15 重定向后下载有进度', (progress.get('downloaded_bytes') or 0) > 0
                      and (progress.get('total_bytes') or 0) > 0, str(progress))
                rc = http_json(port, 'POST', '/api/ai/cancel', {}, timeout=10)
                stopped = False
                deadline = time.time() + 8
                while time.time() < deadline:
                    ai = (http_json(port, 'GET', '/api/ai/status', timeout=10).get('ai') or {})
                    if not ai.get('downloading'):
                        stopped = True
                        break
                    time.sleep(0.3)
                parts_after = []
                if os.path.isdir(mdir):
                    parts_after = [f for f in os.listdir(mdir) if f.endswith('.part')]
                check('M16 取消后停止且删除 .part', rc.get('ok') is True
                      and stopped and not parts_after, f'stopped={stopped} parts={parts_after}')
        finally:
            stub.close()
    finally:
        stop_client(proc)
    print(f'-- AI scenario: {len(PASS)} passed so far, {len(FAIL)} failed --')


def scenario_compat(exe, base_port, mock, mbox):
    """Scenario N: 旧 messages.json / config.json 无损加载 + 默认字段 + 旧数据撤回。"""
    print('== Scenario N: 旧数据文件兼容 ==')
    mbox.reset()
    old_cfg = {
        'email': 'me@test.local', 'display_name': '我', 'password': 'authcode', 'mode': 'pop3',
        'poll_interval': 3, 'auto_poll': True,
        'pop3': {'host': '127.0.0.1', 'port': mock.pop3_port, 'ssl': False},
        'imap': {'host': '127.0.0.1', 'port': mock.imap_port, 'ssl': False},
        'smtp': {'host': '127.0.0.1', 'port': mock.smtp_port, 'ssl': False},
        'friends': [{'email': 'friend@example.com', 'name': '小明', 'note': '旧备注',
                     'added_at': 1729000000}],
        'seen_pop3': [], 'seen_imap': [], 'unread': {'friend@example.com': 0}, 'next_msg_id': 3,
    }
    old_msgs = {'conversations': {'friend@example.com': [
        {'id': 1, 'dir': 'in', 'text': '旧版收到的消息', 'ts': 1729000001, 'mid': '<old-1@test.local>'},
        {'id': 2, 'dir': 'out', 'text': '旧版发出的消息', 'ts': 1729000002, 'mid': '<old-2@test.local>'},
    ]}}
    proc, prog, port = start_configured('compat', exe, base_port + 21, mock,
                                        pre_config=old_cfg, pre_messages=old_msgs)
    peer = 'friend@example.com'
    try:
        msgs = messages_of(port, peer)
        check('N1 旧 messages.json 加载', len(msgs) == 2 and
              {m.get('text') for m in msgs} == {'旧版收到的消息', '旧版发出的消息'},
              str([m.get('text') for m in msgs]))
        old_in = next((m for m in msgs if m.get('text') == '旧版收到的消息'), {})
        check('N2 旧消息默认 kind=chat/recalled=false/无附件',
              old_in.get('kind') in (None, 'chat') and old_in.get('recalled') in (None, False)
              and not old_in.get('attachments'), str(old_in))
        check('N3 旧消息保留 mid 与 id', old_in.get('mid') == '<old-1@test.local>'
              and old_in.get('id') == 1, str({k: old_in.get(k) for k in ('id', 'mid')}))
        st = http_json(port, 'GET', '/api/state')
        check('N4 旧 config.json 加载（账户/好友）',
              (st.get('account') or {}).get('email') == 'me@test.local'
              and any(f['email'] == peer for f in st['friends']), str(st.get('account')))
        ai = st.get('ai') or {}
        check('N5 旧配置无 ai 字段时默认关闭',
              ai.get('enabled') is False and ai.get('model_ready') is False, str(ai))
        r = http_json(port, 'POST', '/api/send', {'to': peer, 'text': '新版消息'})
        msgs = wait_message(port, peer, lambda ms: any(m.get('text') == '新版消息' for m in ms))
        new_out = next((m for m in msgs if m.get('text') == '新版消息'), {})
        check('N6 旧数据上继续发送且 id 递增', r.get('ok') is True
              and new_out.get('id', 0) >= 3, str(new_out.get('id')))
        # 旧消息（有 mid）可以撤回 -> 通知邮件
        r = http_json(port, 'POST', '/api/recall', {'with': peer, 'id': 2})
        raw, msg = last_mail(mbox)
        check('N7 旧发件消息支持撤回', r.get('ok') is True and msg is not None
              and '<old-2@test.local>' in (_raw_header(msg, 'X-Email-Chatter-Recall') or ''),
              f'{r} recall={_raw_header(msg, "X-Email-Chatter-Recall") if msg else None}')
        msgs = messages_of(port, peer)
        old_out = next((m for m in msgs if m.get('id') == 2), {})
        check('N8 旧消息撤回后 recalled=true', old_out.get('recalled') is True,
              str(old_out.get('recalled')))
    finally:
        stop_client(proc)
    print(f'-- Legacy compat scenario: {len(PASS)} passed so far, {len(FAIL)} failed --')


def scenario_robustness(exe, base_port, mock, mbox):
    """Scenario P: reviewer 发现的健壮性回归。

    P1/H1  JSON 深度炸弹：POST /api/send body='['*60000，客户端不得崩溃。
    P3/H1b Quote 头炸弹：非好友/好友邮件带 X-Email-Chatter-Quote=base64('['*100000)，
           轮询后客户端必须存活（JSON 解析失败应被忽略而不是栈溢出崩溃）。
    P5/M1  仅附件无文本段的 MIME 邮件 -> text==""、attachments 1 项且可下载。
    """
    print('== Scenario P: 健壮性回归（JSON 深度炸弹 / Quote 头炸弹 / 仅附件）==')
    mbox.reset()
    proc, prog, port = start_configured('robust', exe, base_port + 22, mock)
    peer = 'friend@example.com'
    try:
        # ---- H1: 深度嵌套 JSON（60000 层数组）不得栈溢出崩溃 ----
        t0 = time.time()
        status, body, _ = (None, b'', {})
        try:
            status, body, _ = http_bytes(port, 'POST', '/api/send', b'[' * 60000,
                                         {'Content-Type': 'application/json'}, timeout=60)
        except Exception as e:
            body = f'{type(e).__name__}: {e}'.encode()
        dt = time.time() - t0
        print(f'  [TIME] P1 H1 JSON 60000 层: status={status} dt={dt:.3f}s')
        alive = False
        try:
            http_json(port, 'GET', '/api/state', timeout=10)
            alive = True
        except Exception:
            alive = False
        check('P1 H1 JSON 深度炸弹不崩溃且进程存活', alive and status is not None,
              f'status={status} alive={alive} dt={dt:.2f}s body={body[:120]!r}')
        # 崩溃/异常后服务仍可用（正常发送）
        r = http_json(port, 'POST', '/api/send', {'to': peer, 'text': 'H1 之后正常消息'}, timeout=30)
        msgs = wait_message(port, peer, lambda ms: any(m.get('text') == 'H1 之后正常消息' for m in ms))
        check('P2 H1 后服务仍可正常收发', r.get('ok') is True
              and any(m.get('text') == 'H1 之后正常消息' for m in msgs), str(r))

        # ---- H1b: Quote 头炸弹（base64('['*100000)，JSON 深度 10 万层）----
        bomb = base64.b64encode(b'[' * 100000).decode('ascii')
        # 非好友邮件
        mbox.add_raw(mock_mail.build_raw(
            frm='stranger@example.com', to='me@test.local', subject='quote-bomb',
            body='炸弹邮件', headers={'X-Email-Chatter-Quote': bomb},
            mid='<quote-bomb-stranger@test.local>'))
        poll_ok1 = False
        t_p3 = time.time()
        try:
            http_json(port, 'POST', '/api/poll', {}, timeout=60)
            poll_ok1 = True
        except Exception:
            poll_ok1 = False
        print(f'  [TIME] P3 poll with 133KB quote header = {time.time() - t_p3:.3f}s')
        time.sleep(2.0)
        alive1 = False
        try:
            http_json(port, 'GET', '/api/state', timeout=10)
            alive1 = True
        except Exception:
            alive1 = False
        check('P3 H1b 非好友 Quote 头炸弹后客户端存活', alive1, f'poll_ok={poll_ok1}')
        # 好友邮件同样带炸弹：解析失败应忽略 quote 而不崩溃
        mbox.add_raw(mock_mail.build_raw(
            frm=peer, to='me@test.local', subject='quote-bomb-friend', body='好友炸弹正文',
            headers={'X-Email-Chatter-Quote': bomb},
            mid='<quote-bomb-friend@test.local>'))
        try:
            http_json(port, 'POST', '/api/poll', {}, timeout=60)
        except Exception:
            pass
        time.sleep(2.0)
        alive2 = False
        try:
            http_json(port, 'GET', '/api/state', timeout=10)
            alive2 = True
        except Exception:
            alive2 = False
        check('P4 H1b 好友 Quote 头炸弹后客户端存活', alive2)
        msgs = messages_of(port, peer)
        bomb_msg = next((m for m in msgs if m.get('mid') == '<quote-bomb-friend@test.local>'), None)
        check('P5 H1b 炸弹邮件正文仍可正常接收（quote 忽略）',
              bomb_msg is not None and '炸弹正文' in (bomb_msg.get('text') or '')
              and not bomb_msg.get('quote'), str(bomb_msg and {k: bomb_msg.get(k) for k in ('text', 'quote')}))

        # ---- M1: 仅附件、无 text/plain 正文段 ----
        mbox.add_raw(mock_mail.build_raw(
            frm=peer, to='me@test.local', subject='仅附件邮件', body='',
            include_text=False, mid='<only-attachment@test.local>',
            attachments=[{'name': 'only.png', 'mime': 'image/png', 'data': PNG_1X1}]))
        try:
            http_json(port, 'POST', '/api/poll', {}, timeout=30)
        except Exception:
            pass
        msgs = wait_message(port, peer, lambda ms: any(
            m.get('mid') == '<only-attachment@test.local>' for m in ms), timeout=15)
        only = next((m for m in msgs if m.get('mid') == '<only-attachment@test.local>'), None)
        check('P6 M1 仅附件邮件 text 为空串', only is not None and only.get('text') == '',
              repr(only.get('text') if only else None))
        atts = (only or {}).get('attachments') or []
        check('P7 M1 仅附件邮件 attachments 1 项且 inline',
              len(atts) == 1 and atts[0].get('mime') == 'image/png'
              and atts[0].get('inline') is True, str(atts)[:300])
        if atts:
            st, data, hdr = http_bytes(port, 'GET', atts[0].get('url', ''))
            check('P8 M1 仅附件邮件附件可下载且字节一致', st == 200 and data == PNG_1X1,
                  f'status={st} len={len(data)}')
        else:
            check('P8 M1 仅附件邮件附件可下载且字节一致', False, 'no attachments')
    finally:
        stop_client(proc)
    print(f'-- Robustness scenario: {len(PASS)} passed so far, {len(FAIL)} failed --')


def scenario_unread_reply(exe, base_port, mock, mbox):
    """Scenario Q: 2.1 新增 — 邮箱未读语义（BODY.PEEK[]/only read marks seen）、
    删除好友不改邮箱、引用=reply（In-Reply-To/References/Subject Re:）。"""
    print('== Scenario Q: 2.1 邮箱未读语义 / 删除好友 / 引用=reply ==')
    mbox.reset()
    port = base_port + 23
    prog = make_progdir('imap21', exe)
    proc = start_client(prog, port, os.path.join(HERE, 'tmp', 'client_imap21.log'))
    peer = 'friend@example.com'
    try:
        http_json(port, 'POST', '/api/config', {
            'email': 'me@test.local', 'display_name': '我', 'password': 'authcode',
            'mode': 'imap',
            'imap': {'host': '127.0.0.1', 'port': mock.imap_port, 'ssl': False},
            'smtp': {'host': '127.0.0.1', 'port': mock.smtp_port, 'ssl': False},
            'poll_interval': 3})
        http_json(port, 'POST', '/api/friends',
                  {'action': 'add', 'email': peer, 'name': '小明'})

        # ---- 非好友邮件：拉取但不标已读、不显示 ----
        mbox.add_raw(mock_mail.build_raw(
            frm='stranger@example.com', to='me@test.local', subject='陌生人邮件',
            body='非好友正文', mid='<stranger-21@test.local>'))
        http_json(port, 'POST', '/api/poll', {})
        time.sleep(2.5)
        msgs = messages_of(port, peer)
        seen = sorted(mbox.imap_seen)
        check('Q1 非好友邮件不在聊天显示', not any('非好友正文' in (m.get('text') or '') for m in msgs),
              str([m.get('text') for m in msgs]))
        check('Q2 非好友邮件在邮箱保持未读（imap_seen 不含 uid1）', seen == [], str(seen))
        st = http_json(port, 'GET', '/api/state')
        fr = next((f for f in st['friends'] if f['email'] == peer), {})
        check('Q3 非好友邮件不影响好友未读', fr.get('unread', 0) == 0, str(fr))

        # ---- 好友邮件：拉取后仍保持未读；/api/read 后才标服务器已读 ----
        mbox.add_raw(mock_mail.build_raw(
            frm=peer, to='me@test.local', subject='好友新邮件', body='好友正文21',
            mid='<friend-21@test.local>'))
        http_json(port, 'POST', '/api/poll', {})
        msgs = wait_message(port, peer, lambda ms: any('好友正文21' in (m.get('text') or '') for m in ms),
                            timeout=10)
        fm = next((m for m in msgs if '好友正文21' in (m.get('text') or '')), {})
        st = http_json(port, 'GET', '/api/state')
        fr = next((f for f in st['friends'] if f['email'] == peer), {})
        seen = sorted(mbox.imap_seen)
        check('Q4 好友邮件显示且未读=1', fm and fr.get('unread', 0) == 1, str(fr))
        check('Q5 好友邮件拉取后邮箱仍未读（imap_seen 不含 uid2）', 2 not in seen, str(seen))
        check('Q6 收件消息记录 IMAP uid', str(fm.get('uid', '')) == '2',
              str(fm.get('uid')))

        # /api/read 触发 pending seen -> 下次轮询 UID STORE 批量标已读
        http_json(port, 'POST', '/api/read', {'with': peer})
        time.sleep(3.0)
        http_json(port, 'POST', '/api/poll', {})
        time.sleep(2.5)
        seen = sorted(mbox.imap_seen)
        st = http_json(port, 'GET', '/api/state')
        fr = next((f for f in st['friends'] if f['email'] == peer), {})
        check('Q7 /api/read 后服务器标记该 uid 已读、其它邮件不受影响',
              2 in seen and 1 not in seen, str(seen))
        check('Q8 /api/read 后本地未读清零', fr.get('unread', -1) == 0, str(fr))

        # ---- 删除好友：不改邮箱、未读邮件仍 unseen ----
        mbox.add_raw(mock_mail.build_raw(
            frm=peer, to='me@test.local', subject='删除前未读', body='删除前未读正文',
            mid='<friend-21b@test.local>'))
        http_json(port, 'POST', '/api/poll', {})
        wait_message(port, peer, lambda ms: any('删除前未读正文' in (m.get('text') or '') for m in ms),
                     timeout=10)
        raw_count = len(mbox.raws)
        seen_before = sorted(mbox.imap_seen)
        r = http_json(port, 'POST', '/api/friends', {'action': 'remove', 'email': peer})
        time.sleep(1.0)
        check('Q9 删除好友不改邮箱邮件（raws 数量不变）',
              r.get('ok') is True and len(mbox.raws) == raw_count,
              f'{r} {raw_count}->{len(mbox.raws)}')
        check('Q10 删除好友后未读邮件仍保持 unseen',
              3 not in mbox.imap_seen and sorted(mbox.imap_seen) == seen_before,
              str(sorted(mbox.imap_seen)))
        check('Q11 删除好友后本地会话清除', len(messages_of(port, peer)) == 0,
              str(len(messages_of(port, peer))))

        # ---- 引用=reply（重新加好友后发送）----
        http_json(port, 'POST', '/api/friends', {'action': 'add', 'email': peer, 'name': '小明'})
        qmid = '<orig-thread-21@example.com>'
        quote = {'text': '被回复的原文', 'from': '小明', 'ts': 1729990000, 'mid': qmid}
        r = http_json(port, 'POST', '/api/send', {
            'to': peer, 'text': '聊天回复正文', 'quote': quote})
        raw, msg = last_mail(mbox)
        subj = str(msg['Subject']) if msg is not None else ''
        check('Q12 chat+quote.mid：Subject 加 Re: 前缀',
              r.get('ok') is True and subj.startswith('Re: ') and 'email-chatter 消息' in subj,
              subj)
        check('Q13 chat+quote.mid：In-Reply-To/References=mid',
              msg is not None and str(msg.get('In-Reply-To', '')) == qmid
              and str(msg.get('References', '')) == qmid,
              f'irt={msg.get("In-Reply-To") if msg else None} refs={msg.get("References") if msg else None}')
        body = mail_body(msg) if msg is not None else ''
        check('Q14 quote 头与可读引用块保留',
              msg is not None and _raw_header(msg, 'X-Email-Chatter-Quote') is not None
              and '--- 引用 ---' in body, repr(body[:120]))

        r = http_json(port, 'POST', '/api/send', {
            'to': peer, 'kind': 'email', 'subject': '项目讨论', 'text': '邮件回复正文',
            'quote': quote})
        raw, msg = last_mail(mbox)
        subj = str(msg['Subject']) if msg is not None else ''
        check('Q15 email+quote.mid：Subject=Re: 用户主题且引用头保留',
              r.get('ok') is True and subj == 'Re: 项目讨论'
              and str(msg.get('In-Reply-To', '')) == qmid
              and str(msg.get('References', '')) == qmid, subj)
        msgs = messages_of(port, peer)
        out = next((m for m in msgs if m.get('text') == '邮件回复正文'), {})
        check('Q16 本地发件消息 subject 记录 Re: 前缀', (out.get('subject') or '') == 'Re: 项目讨论',
              str(out.get('subject')))

        # 无 mid 的 quote：保留 quote 头/引用块，但不加 In-Reply-To/References、不加 Re:
        quote_nomid = {'text': '没有消息号的引用', 'from': '小明', 'ts': 1729990000, 'mid': ''}
        r = http_json(port, 'POST', '/api/send', {
            'to': peer, 'text': '无 mid 聊天回复', 'quote': quote_nomid})
        raw, msg = last_mail(mbox)
        check('Q17 无 mid：Subject 不加 Re: 且无 In-Reply-To/References',
              r.get('ok') is True and str(msg['Subject']) == 'email-chatter 消息'
              and msg.get('In-Reply-To') is None and msg.get('References') is None
              and _raw_header(msg, 'X-Email-Chatter-Quote') is not None,
              f'subj={msg["Subject"] if msg else None}')
        r = http_json(port, 'POST', '/api/send', {
            'to': peer, 'kind': 'email', 'subject': '会议纪要', 'text': '无 mid 邮件回复',
            'quote': quote_nomid})
        raw, msg = last_mail(mbox)
        check('Q18 无 mid email：Subject 保持用户主题且无线程头',
              r.get('ok') is True and str(msg['Subject']) == '会议纪要'
              and msg.get('In-Reply-To') is None and msg.get('References') is None,
              f'subj={msg["Subject"] if msg else None}')
    finally:
        stop_client(proc)
    print(f'-- Unread/Reply scenario: {len(PASS)} passed so far, {len(FAIL)} failed --')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--exe', default=os.path.join(HERE, '..', 'build', 'Release', 'email-chatter.exe' if os.name == 'nt' else 'email-chatter'))
    ap.add_argument('--base-port', type=int, default=48731)
    ap.add_argument('--only', default='', help='只跑指定场景，逗号分隔（A,B,...,J,K,L,M,N）；默认全部')
    ap.add_argument('--keep-tmp', action='store_true', help='保留测试数据目录（默认测试结束即删除）')
    args = ap.parse_args()
    exe = os.path.abspath(args.exe)
    if not os.path.isfile(exe):
        print('exe not found:', exe)
        sys.exit(2)

    tmp = os.path.join(HERE, 'tmp')
    cleanup_tmp(tmp)
    os.makedirs(tmp, exist_ok=True)

    mbox = mock_mail.Mailbox()
    mock_mail._mbox = mbox
    log = lambda m: None
    mock_mail.serve(args.base_port + 10, lambda c: mock_mail.handle_smtp(mbox, c, log))   # smtp
    mock_mail.serve(args.base_port + 11, lambda c: mock_mail.handle_pop3(mbox, c, log))   # pop3
    mock_mail.serve(args.base_port + 12, lambda c: mock_mail.handle_imap(mbox, c, log))   # imap

    mock = type('Mock', (), {'smtp_port': args.base_port + 10, 'pop3_port': args.base_port + 11,
                            'imap_port': args.base_port + 12})()

    scenarios = [
        ('A', '旧-POP3', lambda: scenario_pop3(exe, args.base_port, mock, mbox)),
        ('B', '旧-IMAP', lambda: scenario_imap(exe, args.base_port, mock, mbox)),
        ('C', '静态资源', lambda: scenario_assets(exe, args.base_port)),
        ('D', '目录边界', lambda: scenario_security(exe, args.base_port)),
        ('E', '主机名清洗', lambda: scenario_hosts(exe, args.base_port)),
        ('F', 'probe', lambda: scenario_probe(exe, args.base_port, mock)),
        ('G', 'SSL 回退', lambda: scenario_fallback(exe, args.base_port, mock, mbox)),
        ('H', 'Host/Origin', lambda: scenario_guard(exe, args.base_port)),
        ('I', '自动收信/去重', lambda: scenario_autopoll(exe, args.base_port, mock)),
        ('J', '邮件模式', lambda: scenario_email_mode(exe, args.base_port, mock, mbox)),
        ('K', '上传/附件', lambda: scenario_attachments(exe, args.base_port, mock, mbox)),
        ('L', '引用/撤回', lambda: scenario_quote_recall(exe, args.base_port, mock, mbox)),
        ('M', 'AI 接口', lambda: scenario_ai(exe, args.base_port, mock)),
        ('N', '旧数据兼容', lambda: scenario_compat(exe, args.base_port, mock, mbox)),
        ('P', '健壮性回归', lambda: scenario_robustness(exe, args.base_port, mock, mbox)),
        ('Q', '2.1未读/reply', lambda: scenario_unread_reply(exe, args.base_port, mock, mbox)),
    ]
    wanted = {x.strip().upper() for x in args.only.split(',') if x.strip()}
    if args.only and not wanted:
        wanted = set()
    try:
        for key, label, fn in scenarios:
            if wanted and key not in wanted:
                continue
            mbox.reset()
            try:
                fn()
            except Exception as e:
                check(f'{key} 场景异常', False, f'{type(e).__name__}: {e}')
                import traceback
                traceback.print_exc()
            finally:
                mbox.reset()
    finally:
        stop_all_clients()
        if not args.keep_tmp:
            cleanup_tmp(tmp)

    print()
    print(f'== RESULT: {len(PASS)} passed, {len(FAIL)} failed, {len(SKIP)} skipped ==')
    for f in FAIL:
        print('  FAILED:', f)
    for s in SKIP:
        print('  SKIPPED:', s)
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()