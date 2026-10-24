#!/usr/bin/env python3
"""End-to-end test for the email-chatter C++ client using mock mail servers.

Usage: python e2e_test.py [--exe path/to/email-chatter(.exe)] [--port N]

Covers: HTTP API, config, friend whitelist, SMTP send, POP3 receive,
IMAP receive + \\Seen marking, whitelist filtering, read/unread, UI assets.
"""
import argparse
import json
import os
import shutil
import smtplib
import socket
import subprocess
import sys
import time
import urllib.request

sys.dont_write_bytecode = True  # 不在源码目录留下 __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mock_mail  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PASS = []
FAIL = []


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


def http_json(port, method, path, body=None, raw=False):
    url = f'http://127.0.0.1:{port}{path}'
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=15) as r:
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
    if not wait_ready(port):
        logf.close()
        print(open(log_path, 'rb').read().decode('utf-8', 'replace'))
        raise RuntimeError('client did not become ready')
    return proc


def data_of(prog):
    return os.path.join(prog, 'data')


def stop_client(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


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


def scenario_imap(exe, base_port, mock):
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

    # second poll should fetch nothing new (server marked \Seen)
    http_json(port, 'POST', '/api/poll', {})
    time.sleep(2.5)
    msgs2 = messages_of(port, 'friend@example.com')
    check('B3 已读标记生效，无重复', len(msgs2) == 2, str(len(msgs2)))
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

    r = http_json(port, 'POST', '/api/test', {})
    msg = json.dumps(r, ensure_ascii=False)
    check('E5 测试连接报错含 host:port', ('pophz.qiye.163.com:995' in msg or 'imaphz' in msg), msg[:200])
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--exe', default=os.path.join(HERE, '..', 'build', 'Release', 'email-chatter.exe' if os.name == 'nt' else 'email-chatter'))
    ap.add_argument('--base-port', type=int, default=48731)
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

    try:
        scenario_assets(exe, args.base_port)
        mbox.reset()
        scenario_pop3(exe, args.base_port, mock, mbox)
        mbox.reset()
        scenario_imap(exe, args.base_port, mock)
        scenario_security(exe, args.base_port)
        scenario_hosts(exe, args.base_port)
        scenario_probe(exe, args.base_port, mock)
        mbox.reset()
        scenario_fallback(exe, args.base_port, mock, mbox)
        scenario_guard(exe, args.base_port)
        mbox.reset()
        scenario_autopoll(exe, args.base_port, mock)
    finally:
        if not args.keep_tmp:
            cleanup_tmp(tmp)

    print()
    print(f'== RESULT: {len(PASS)} passed, {len(FAIL)} failed ==')
    for f in FAIL:
        print('  FAILED:', f)
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()