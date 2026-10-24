#!/usr/bin/env python3
"""Seed the running demo client (127.0.0.1:48731) with a sample conversation.

Starts the mock mail servers IN-PROCESS (they live as long as this script),
injects two messages from a whitelisted friend and sends one reply, then polls.
"""
import json
import os
import sys
import time
import urllib.request
import smtplib
import base64

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mock_mail  # noqa: E402

API = 'http://127.0.0.1:48731'
SMTP_PORT = 2525
POP3_PORT = 2110
IMAP_PORT = 2143


def api(method, path, body=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode('utf-8'))


def inject(frm, subject, body):
    msg = ('From: %s\r\nTo: me@163.com\r\nSubject: %s\r\n'
           'Date: %s\r\n'
           'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n'
           'Content-Transfer-Encoding: base64\r\n\r\n') % (
        frm, subject, time.strftime('%a, %d %b %Y %H:%M:%S +0800'))
    msg += base64.b64encode(body.encode('utf-8')).decode() + '\r\n'
    with smtplib.SMTP('127.0.0.1', SMTP_PORT, timeout=10) as s:
        s.sendmail(frm, ['me@163.com'], msg.encode('utf-8'))


def main():
    mbox = mock_mail.Mailbox()
    mock_mail.serve(SMTP_PORT, lambda c: mock_mail.handle_smtp(mbox, c, lambda m: None))
    mock_mail.serve(POP3_PORT, lambda c: mock_mail.handle_pop3(mbox, c, lambda m: None))
    mock_mail.serve(IMAP_PORT, lambda c: mock_mail.handle_imap(mbox, c, lambda m: None))
    time.sleep(0.5)

    print('config:', api('POST', '/api/config', {
        'email': 'me@163.com', 'display_name': '我', 'password': '授权密码示例', 'mode': 'pop3',
        'pop3': {'host': '127.0.0.1', 'port': POP3_PORT, 'ssl': False},
        'smtp': {'host': '127.0.0.1', 'port': SMTP_PORT, 'ssl': False},
        'poll_interval': 3}))
    print('add friend:', api('POST', '/api/friends', {
        'action': 'add', 'email': 'xiaoming@163.com', 'name': '小明', 'note': '高中同学'}))
    inject('xiaoming@163.com', '周末爬山', '周六早上八点香山门口集合，别迟到！😀')
    inject('xiaoming@163.com', '照片', '给你发了些上次旅行的照片，记得查收~')
    print('send:', api('POST', '/api/send', {
        'to': 'xiaoming@163.com', 'text': '收到，我周六肯定到！'}))
    time.sleep(1)
    print('poll:', api('POST', '/api/poll', {}))
    time.sleep(3)
    st = api('GET', '/api/state')
    if not st['friends']:
        print('ERROR: no friends in state')
        sys.exit(1)
    for f in st['friends']:
        print('friend:', f['email'], f['name'], 'unread=', f['unread'], 'last=', repr(f['last_text']))
    msgs = api('GET', '/api/messages?with=xiaoming@163.com')
    for m in msgs['messages']:
        print('  msg:', m['dir'], repr(m['text']['$t'] if isinstance(m.get('text'), dict) else m['text']))
    print('SEED OK')


if __name__ == '__main__':
    main()