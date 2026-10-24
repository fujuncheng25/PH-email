#!/usr/bin/env python3
"""Mock SMTP / POP3 / IMAP servers + MIME builders for email-chatter e2e tests.

All servers listen on 127.0.0.1 and speak plaintext (no TLS).
The mailbox is shared: messages received via SMTP (or injected directly)
are served back through POP3/IMAP, simulating the user's own mailbox.

Extensions for Email Chatter 2.0 (FEATURE-SPEC.md §3 / §9):

* SMTP captures the **full raw message** (dot-unstuffed, CRLF preserved) plus
  the SMTP envelope (MAIL FROM / RCPT TO) so tests can assert headers,
  multipart bodies, Bcc-only recipients, and the ``X-Email-Chatter-*`` headers.
* ``Mailbox.add_raw(raw)`` / ``Mailbox.add_mime(**kw)`` inject **arbitrary raw
  MIME mail** directly into the mailbox (delivered to POP3/IMAP without SMTP).
* ``build_raw(...)`` builds standards-shaped MIME messages: plain / multipart
  with attachments (base64, 76-col wrapped, RFC2047 or RFC2231 filenames),
  ``X-Email-Chatter-Kind/Quote/Recall`` headers, quote body block, Cc header.
* Optional HTTP **control server** (``--http PORT``) exposes ``/health``,
  ``/mails``, ``/inject``, ``/reset`` so out-of-process tests (Node e2e) can
  read captured raw mail and inject arbitrary raw MIME.

Backwards compatibility: the old ``Mailbox`` API, ``serve()``,
``handle_smtp/handle_pop3/handle_imap`` signatures and CLI flags are unchanged,
so the legacy e2e suites keep working.
"""
import argparse
import base64
import json
import re
import socket
import threading
import time

CRLF = b'\r\n'


# ------------------------------------------------------------------ Mailbox --
class Mailbox:
    def __init__(self):
        self.lock = threading.Lock()
        self.raws = []          # list of raw message bytes
        self.envelopes = []     # parallel to raws: {'from': str, 'rcpts': [str]}
        self.imap_seen = set()  # uid values marked \Seen

    def reset(self):
        with self.lock:
            self.raws.clear()
            self.envelopes.clear()
            self.imap_seen.clear()

    def add_raw(self, raw, envelope=None):
        """Add one raw MIME message to the mailbox (str or bytes)."""
        if isinstance(raw, str):
            raw = raw.encode('utf-8')
        if envelope is None:
            envelope = {}
        with self.lock:
            self.raws.append(raw)
            self.envelopes.append(envelope)

    def add_mime(self, **kw):
        """Build a MIME message with build_raw() and add it to the mailbox."""
        raw = build_raw(**kw)
        self.add_raw(raw, {'from': kw.get('frm'), 'rcpts': [kw.get('to')]})
        return raw

    def received_count(self):
        with self.lock:
            return len(self.raws)

    def snapshot(self):
        with self.lock:
            return list(self.raws), list(self.envelopes)

    def last_raw(self):
        with self.lock:
            return self.raws[-1] if self.raws else None

    def last_envelope(self):
        with self.lock:
            return self.envelopes[-1] if self.envelopes else None

    def get_raw(self, idx):
        with self.lock:
            return self.raws[idx] if 0 <= idx < len(self.raws) else None

    def mark_seen_all(self):
        with self.lock:
            for i in range(len(self.raws)):
                self.imap_seen.add(i + 1)


# ------------------------------------------------------------- MIME helpers --
def b64_wrap(data, width=76):
    """base64-encode bytes/str, wrapped at ``width`` chars with CRLF."""
    if isinstance(data, str):
        data = data.encode('utf-8')
    s = base64.b64encode(data).decode('ascii')
    return '\r\n'.join(s[i:i + width] for i in range(0, len(s), width))


def rfc2047(text):
    """RFC2047 B-encode a header value (returns plain value when ASCII)."""
    try:
        text.encode('ascii')
        return text
    except UnicodeEncodeError:
        return '=?UTF-8?B?' + base64.b64encode(text.encode('utf-8')).decode('ascii') + '?='


def mime_filename(name, style='rfc2047'):
    """Encode an attachment filename for Content-Type/Disposition."""
    try:
        name.encode('ascii')
        return f'"{name}"'
    except UnicodeEncodeError:
        if style == 'rfc2231':
            quoted = ''.join('%%%02X' % b for b in name.encode('utf-8'))
            return f"UTF-8''{quoted}"
        return f'"{rfc2047(name)}"'


def quote_header_value(quote):
    """base64(UTF-8 JSON) folded to 76-char lines, continuation starts with ' '."""
    payload = json.dumps({
        'text': quote.get('text', ''),
        'from': quote.get('from', ''),
        'ts': int(quote.get('ts') or 0),
        'mid': quote.get('mid', '') or '',
    }, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    s = base64.b64encode(payload).decode('ascii')
    return '\r\n '.join(s[i:i + 76] for i in range(0, len(s), 76))


def quote_body_block(quote):
    """Human-readable quote block appended to the mail body (§3.1)."""
    ts = int(quote.get('ts') or 0)
    when = time.strftime('%Y-%m-%d %H:%M', time.localtime(ts)) if ts else ''
    lines = [f'> {line}' for line in (quote.get('text') or '').split('\n')]
    return ('\n\n--- 引用 ---\n> 发件人：%s\n> 时间：%s\n%s'
            % (quote.get('from', ''), when, '\n'.join(lines)))


def parse_quote_header_value(value):
    """Decode a (possibly folded) X-Email-Chatter-Quote value (for assertions)."""
    compact = ''.join(value.split())
    raw = base64.b64decode(compact + '=' * (-len(compact) % 4))
    return json.loads(raw.decode('utf-8'))


def build_raw(frm='friend@example.com', to='me@test.local', subject='测试邮件',
              body='正文内容', *,
              mid=None, kind=None, quote=None, recall=None, cc=None,
              attachments=None, headers=None, extra_headers=None,
              body_b64=True, append_quote_block=True, quote_block=None,
              rfc2047_subject=False, date=None, mime_version=True,
              filename_style='rfc2047', html_body=None, include_text=True):
    """Build a raw MIME message (bytes) for SMTP injection / POP3-IMAP delivery.

    attachments: list of dicts {'name','mime','data'} (data bytes/str) or
                 (name, mime, data) tuples.
    extra_headers: dict or list of (name, value) raw header lines.
    include_text=False: multipart/mixed with attachments only，不生成
                 text/plain 正文段（用于「仅附件无正文」回归 M1）。
    """
    if isinstance(body, bytes):
        body_text = body.decode('utf-8')
        body_bytes = body
    else:
        body_text = body
        body_bytes = body.encode('utf-8')
    if quote and append_quote_block and quote_block is None:
        block = quote_body_block(quote)
        body_text += block
        body_bytes = body_text.encode('utf-8')
    elif quote_block:
        body_text += quote_block
        body_bytes = body_text.encode('utf-8')

    hdrs = []
    hdrs.append(f'From: {frm}')
    hdrs.append(f'To: {to}')
    if cc:
        hdrs.append(f'Cc: {cc if isinstance(cc, str) else ", ".join(cc)}')
    hdrs.append('Subject: ' + (rfc2047(subject) if rfc2047_subject else subject))
    hdrs.append('Date: ' + (date or time.strftime('%a, %d %b %Y %H:%M:%S +0800')))
    if mid:
        hdrs.append(f'Message-ID: {mid}')
    if mime_version:
        hdrs.append('MIME-Version: 1.0')
    if kind:
        hdrs.append(f'X-Email-Chatter-Kind: {kind}')
    if recall:
        hdrs.append(f'X-Email-Chatter-Recall: {recall}')
    if quote:
        hdrs.append('X-Email-Chatter-Quote: ' + quote_header_value(quote))

    all_extra = []
    if isinstance(headers, dict):
        all_extra.extend(headers.items())
    elif headers:
        all_extra.extend(headers)
    if extra_headers:
        all_extra.extend(extra_headers if not isinstance(extra_headers, dict)
                         else extra_headers.items())
    for k, v in all_extra:
        hdrs.append(f'{k}: {v}')

    atts = []
    for a in (attachments or []):
        if isinstance(a, dict):
            atts.append((a.get('name', 'file.bin'), a.get('mime', 'application/octet-stream'),
                         a.get('data', b'')))
        else:
            atts.append((a[0], a[1], a[2]))

    if not atts:
        hdrs.append('Content-Type: text/plain; charset=UTF-8')
        hdrs.append('Content-Transfer-Encoding: base64')
        if not include_text:
            return ('\r\n'.join(hdrs) + '\r\n\r\n\r\n').encode('utf-8')
        return ('\r\n'.join(hdrs) + '\r\n\r\n' + b64_wrap(body_bytes) + '\r\n').encode('utf-8')

    boundary = '=ec_test_%d_%d' % (int(time.time() * 1000) % 1000000, len(atts))
    hdrs.append(f'Content-Type: multipart/mixed; boundary="{boundary}"')
    parts = []
    if include_text:
        parts += [f'--{boundary}',
                  'Content-Type: text/plain; charset=UTF-8',
                  'Content-Transfer-Encoding: base64',
                  '',
                  b64_wrap(body_bytes)]
    for name, mime, data in atts:
        if isinstance(data, str):
            data = data.encode('utf-8')
        parts += [f'--{boundary}',
                  f'Content-Type: {mime}; name={mime_filename(name, filename_style)}',
                  f'Content-Disposition: attachment; filename={mime_filename(name, filename_style)}',
                  'Content-Transfer-Encoding: base64',
                  '',
                  b64_wrap(data)]
    parts += [f'--{boundary}--', '']
    return ('\r\n'.join(hdrs) + '\r\n\r\n' + '\r\n'.join(parts) + '\r\n').encode('utf-8')


# ------------------------------------------------------------- line reader --
class LineReader:
    """Line-buffered reader: returns exactly one line per call."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = b''

    def readline(self):
        while True:
            idx = self.buf.find(b'\n')
            if idx >= 0:
                line = self.buf[:idx]
                self.buf = self.buf[idx + 1:]
                return line.rstrip(b'\r')
            chunk = self.sock.recv(4096)
            if not chunk:
                return None
            self.buf += chunk


def serve(port, handler):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', port))
    s.listen(32)

    def loop():
        while True:
            try:
                c, _ = s.accept()
            except OSError:
                break

            def run(conn):
                try:
                    handler(conn)
                except OSError:
                    pass
                finally:
                    try:
                        conn.close()
                    except OSError:
                        pass

            threading.Thread(target=run, args=(c,), daemon=True).start()

    threading.Thread(target=loop, daemon=True).start()
    return s


# ---------------- SMTP ----------------
_MAIL_RE = re.compile(r'FROM:\s*<?([^>\s]*)>?', re.IGNORECASE)
_RCPT_RE = re.compile(r'TO:\s*<?([^>\s]*)>?', re.IGNORECASE)


def handle_smtp(mbox, c, log):
    r = LineReader(c)
    c.sendall(b'220 mock-smtp ESMTP ready\r\n')
    env = {'from': '', 'rcpts': []}
    while True:
        line = r.readline()
        if line is None:
            break
        cmd = line.decode('latin-1', 'replace')
        log(f'SMTP C: {cmd[:60]}')
        up = cmd.upper()
        if up.startswith('EHLO') or up.startswith('HELO'):
            c.sendall(b'250-mock-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n')
        elif up.startswith('AUTH LOGIN'):
            c.sendall(b'334 VXNlcm5hbWU6\r\n')
            if r.readline() is None:
                break
            c.sendall(b'334 UGFzc3dvcmQ6\r\n')
            if r.readline() is None:
                break
            c.sendall(b'235 2.7.0 Authentication successful\r\n')
        elif up.startswith('AUTH PLAIN'):
            c.sendall(b'235 2.7.0 Authentication successful\r\n')
        elif up.startswith('MAIL FROM'):
            m = _MAIL_RE.search(cmd)
            env = {'from': (m.group(1) if m else ''), 'rcpts': []}
            c.sendall(b'250 2.1.0 Ok\r\n')
        elif up.startswith('RCPT TO'):
            m = _RCPT_RE.search(cmd)
            if m:
                env['rcpts'].append(m.group(1))
            c.sendall(b'250 2.1.5 Ok\r\n')
        elif up.startswith('DATA'):
            c.sendall(b'354 End data with <CR><LF>.<CR><LF>\r\n')
            raw = b''
            while True:
                l = r.readline()
                if l is None:
                    break
                if l == b'.':
                    break
                if l.startswith(b'..'):
                    l = l[1:]
                raw += l + b'\r\n'
            mbox.add_raw(raw, dict(env))
            log(f'SMTP stored message ({len(raw)} bytes) rcpts={env["rcpts"]}')
            c.sendall(b'250 2.0.0 Ok: queued as mock\r\n')
        elif up.startswith('RSET'):
            env = {'from': '', 'rcpts': []}
            c.sendall(b'250 2.1.0 Ok\r\n')
        elif up.startswith('QUIT'):
            c.sendall(b'221 2.0.0 Bye\r\n')
            break
        else:
            c.sendall(b'250 Ok\r\n')
    try:
        c.close()
    except OSError:
        pass


# ---------------- POP3 ----------------
def handle_pop3(mbox, c, log):
    r = LineReader(c)
    c.sendall(b'+OK mock-pop3 ready\r\n')
    while True:
        line = r.readline()
        if line is None:
            break
        cmd = line.decode('latin-1', 'replace')
        log(f'POP3 C: {cmd[:60]}')
        up = cmd.upper()
        if up.startswith('USER') or up.startswith('PASS'):
            c.sendall(b'+OK\r\n')
        elif up.startswith('STAT'):
            with mbox.lock:
                n = len(mbox.raws)
                sz = sum(len(m) for m in mbox.raws)
            c.sendall(f'+OK {n} {sz}\r\n'.encode())
        elif up.startswith('UIDL'):
            c.sendall(b'+OK\r\n')
            with mbox.lock:
                for i in range(len(mbox.raws)):
                    c.sendall(f'{i + 1} uid{i + 1}\r\n'.encode())
            c.sendall(b'.\r\n')
        elif up.startswith('LIST'):
            c.sendall(b'+OK\r\n')
            with mbox.lock:
                for i, m in enumerate(mbox.raws):
                    c.sendall(f'{i + 1} {len(m)}\r\n'.encode())
            c.sendall(b'.\r\n')
        elif up.startswith('RETR'):
            parts = cmd.split()
            if len(parts) < 2:
                c.sendall(b'-ERR bad args\r\n')
                continue
            idx = int(parts[1]) - 1
            with mbox.lock:
                raw = mbox.raws[idx] if 0 <= idx < len(mbox.raws) else None
            if raw is None:
                c.sendall(b'-ERR no such message\r\n')
                continue
            c.sendall(b'+OK message follows\r\n')
            # 批量组装后分块发送：旧实现每行一次 sendall 在几 MB 邮件上会很慢，
            # 干扰 H3「POP3 大邮件轮询 < 2s」的耗时断言（协议语义不变）。
            out = bytearray()
            for l in raw.split(b'\r\n'):
                if l.startswith(b'.'):
                    l = b'.' + l
                out += l + b'\r\n'
            out += b'.\r\n'
            chunk = 1 << 20
            for i in range(0, len(out), chunk):
                c.sendall(out[i:i + chunk])
        elif up.startswith('DELE') or up.startswith('RSET') or up.startswith('NOOP'):
            c.sendall(b'+OK\r\n')
        elif up.startswith('QUIT'):
            c.sendall(b'+OK bye\r\n')
            break
        else:
            c.sendall(b'-ERR unknown command\r\n')
    try:
        c.close()
    except OSError:
        pass


# ---------------- IMAP ----------------
def handle_imap(mbox, c, log):
    r = LineReader(c)
    c.sendall(b'* OK mock-imap ready\r\n')
    while True:
        line = r.readline()
        if line is None:
            break
        cmd = line.decode('latin-1', 'replace')
        log(f'IMAP C: {cmd[:80]}')
        up = cmd.upper()
        tag = cmd.split()[0] if cmd.split() else '*'
        stripped = up[len(tag):].strip()
        if stripped.startswith('CAPABILITY'):
            c.sendall(b'* CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=LOGIN ID UIDPLUS\r\n')
            c.sendall(f'{tag} OK CAPABILITY completed\r\n'.encode())
        elif stripped.startswith('ID'):
            c.sendall(b'* ID NIL\r\n')
            c.sendall(f'{tag} OK ID completed\r\n'.encode())
        elif stripped.startswith('LOGIN'):
            c.sendall(f'{tag} OK LOGIN completed\r\n'.encode())
        elif stripped.startswith('SELECT') or stripped.startswith('EXAMINE'):
            with mbox.lock:
                n = len(mbox.raws)
            c.sendall(f'* {n} EXISTS\r\n* {n} RECENT\r\n* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\Recent)\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n'.encode())
            c.sendall(f'{tag} OK [READ-WRITE] SELECT completed\r\n'.encode())
        elif stripped.startswith('UID SEARCH') or stripped.startswith('SEARCH'):
            # 兼容客户端使用 UID SEARCH（真实服务器返回的就是 UID）
            uids = []
            with mbox.lock:
                for i in range(len(mbox.raws)):
                    if (i + 1) not in mbox.imap_seen:
                        uids.append(i + 1)
            c.sendall(('* SEARCH ' + ' '.join(str(u) for u in uids) + '\r\n').encode() if uids else b'* SEARCH\r\n')
            c.sendall(f'{tag} OK SEARCH completed\r\n'.encode())
        elif stripped.startswith('UID FETCH') or stripped.startswith('FETCH'):
            # RFC3501 语义：BODY.PEEK[] 不置 \Seen；BODY[] / RFC822 会隐式置 \Seen。
            # 2.1 客户端用 BODY.PEEK[] 拉取（保持邮箱未读），/api/read 后单独 UID STORE。
            parts = stripped.split()
            is_uid = parts[0] == 'UID'
            target = parts[2] if is_uid and len(parts) > 2 else (parts[1] if not is_uid and len(parts) > 1 else '')
            uids = []
            for tok in target.split(','):
                try:
                    uids.append(int(tok))
                except ValueError:
                    pass
            peek = 'BODY.PEEK' in stripped
            item = 'BODY[]' if 'BODY' in stripped else 'RFC822'
            seq = 1
            with mbox.lock:
                for u in uids:
                    idx = u - 1
                    if not (0 <= idx < len(mbox.raws)):
                        continue
                    raw = mbox.raws[idx]
                    c.sendall(f'* {seq} FETCH (UID {u} {item} {{{len(raw)}}}\r\n'.encode())
                    c.sendall(raw + b')\r\n')
                    seq += 1
                    if not peek:
                        mbox.imap_seen.add(u)
            c.sendall(f'{tag} OK FETCH completed\r\n'.encode())
        elif stripped.startswith('UID STORE') or stripped.startswith('STORE'):
            # 支持逗号分隔多 uid（2.1 批量标记已读），以及旧的单 uid。
            parts = stripped.split()
            is_uid = parts[0] == 'UID'
            target = parts[2] if is_uid and len(parts) > 2 else (parts[1] if not is_uid and len(parts) > 1 else '')
            uids = []
            with mbox.lock:
                max_uid = len(mbox.raws)
            for tok in target.split(','):
                if ':' in tok:
                    a, b = tok.split(':', 1)
                    try:
                        lo = int(a)
                        hi = max_uid if b == '*' else int(b)
                        uids.extend(range(lo, hi + 1))
                    except ValueError:
                        continue
                else:
                    try:
                        uids.append(int(tok))
                    except ValueError:
                        continue
            remove = '-FLAGS' in stripped and '\\SEEN' in stripped
            with mbox.lock:
                for u in uids:
                    if remove:
                        mbox.imap_seen.discard(u)
                    else:
                        mbox.imap_seen.add(u)
            for u in uids:
                c.sendall(f'* {u} FETCH (FLAGS (\\Seen))\r\n'.encode())
            c.sendall(f'{tag} OK STORE completed\r\n'.encode())
        elif stripped.startswith('NOOP') or stripped.startswith('CHECK'):
            c.sendall(f'{tag} OK completed\r\n'.encode())
        elif stripped.startswith('LOGOUT'):
            c.sendall(b'* BYE logging out\r\n')
            c.sendall(f'{tag} OK LOGOUT completed\r\n'.encode())
            break
        else:
            c.sendall(f'{tag} OK completed\r\n'.encode())
    try:
        c.close()
    except OSError:
        pass


# ---------------- HTTP control (out-of-process tests) ----------------
def make_control_handler(mbox, log):
    from http.server import BaseHTTPRequestHandler

    class ControlHandler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, fmt, *args):
            pass

        def _send(self, obj, status=200):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=UTF-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split('?', 1)[0]
            if path == '/health':
                self._send({'ok': True, 'count': mbox.received_count()})
            elif path == '/mails':
                with mbox.lock:
                    mails = [{'raw_b64': base64.b64encode(raw).decode('ascii'),
                              'envelope': env,
                              'raw': raw.decode('utf-8', 'replace')}
                             for raw, env in zip(mbox.raws, mbox.envelopes)]
                self._send({'ok': True, 'count': len(mails), 'mails': mails})
            elif path == '/last':
                raw = mbox.last_raw()
                self._send({'ok': True, 'raw_b64': base64.b64encode(raw).decode('ascii') if raw else '',
                            'envelope': mbox.last_envelope() or {}})
            elif path == '/imap-seen':
                # 供 2.1 未读语义断言：mock IMAP 服务器上被标记 \Seen 的 uid 列表
                with mbox.lock:
                    seen = sorted(mbox.imap_seen)
                    n = len(mbox.raws)
                self._send({'ok': True, 'seen': seen, 'count': n})
            else:
                self._send({'ok': False, 'error': 'not found'}, 404)

        def do_POST(self):
            path = self.path.split('?', 1)[0]
            length = int(self.headers.get('Content-Length') or 0)
            data = self.rfile.read(length) if length else b''
            if path == '/inject':
                mbox.add_raw(data)
                self._send({'ok': True, 'count': mbox.received_count()})
            elif path == '/reset':
                mbox.reset()
                self._send({'ok': True})
            else:
                self._send({'ok': False, 'error': 'not found'}, 404)

    return ControlHandler


def serve_control(port, mbox, log=None):
    """Start the HTTP control server in a background thread; returns server."""
    from http.server import ThreadingHTTPServer
    handler = make_control_handler(mbox, log or (lambda m: None))
    srv = ThreadingHTTPServer(('127.0.0.1', port), handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--smtp', type=int, default=2525)
    ap.add_argument('--pop3', type=int, default=2110)
    ap.add_argument('--imap', type=int, default=2143)
    ap.add_argument('--http', type=int, default=0, help='optional HTTP control port (0=off)')
    ap.add_argument('--log', action='store_true')
    args = ap.parse_args()

    mbox = Mailbox()
    log = (lambda m: print(m, flush=True)) if args.log else (lambda m: None)
    serve(args.smtp, lambda c: handle_smtp(mbox, c, log))
    serve(args.pop3, lambda c: handle_pop3(mbox, c, log))
    serve(args.imap, lambda c: handle_imap(mbox, c, log))
    if args.http:
        serve_control(args.http, mbox, log)
    print(f'mock mail: SMTP=127.0.0.1:{args.smtp} POP3=127.0.0.1:{args.pop3} '
          f'IMAP=127.0.0.1:{args.imap}' + (f' HTTP=127.0.0.1:{args.http}' if args.http else ''))
    threading.Event().wait()


if __name__ == '__main__':
    main()
