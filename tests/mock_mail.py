#!/usr/bin/env python3
"""Mock SMTP / POP3 / IMAP servers for end-to-end testing of email-chatter.

All servers listen on 127.0.0.1 and speak plaintext (no TLS).
The mailbox is shared: messages received via SMTP (or injected directly)
are served back through POP3/IMAP, simulating the user's own mailbox.
"""
import argparse
import socket
import threading


class Mailbox:
    def __init__(self):
        self.lock = threading.Lock()
        self.raws = []          # list of raw message bytes
        self.imap_seen = set()  # uid values marked \Seen

    def reset(self):
        with self.lock:
            self.raws.clear()
            self.imap_seen.clear()

    def add_raw(self, raw):
        with self.lock:
            self.raws.append(raw)

    def received_count(self):
        with self.lock:
            return len(self.raws)


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
def handle_smtp(mbox, c, log):
    r = LineReader(c)
    c.sendall(b'220 mock-smtp ESMTP ready\r\n')
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
            c.sendall(b'250 2.1.0 Ok\r\n')
        elif up.startswith('RCPT TO'):
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
            mbox.add_raw(raw)
            log(f'SMTP stored message ({len(raw)} bytes)')
            c.sendall(b'250 2.0.0 Ok: queued as mock\r\n')
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
            for l in raw.split(b'\r\n'):
                if l.startswith(b'.'):
                    l = b'.' + l
                c.sendall(l + b'\r\n')
            c.sendall(b'.\r\n')
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
            c.sendall(b'* 3 EXISTS\r\n* 3 RECENT\r\n* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\Recent)\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n')
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
            parts = stripped.split()
            try:
                uids = [int(parts[2] if parts[0] == 'UID' else parts[1])]
            except (IndexError, ValueError):
                uids = []
            seq = 1
            with mbox.lock:
                for u in uids:
                    idx = u - 1
                    if 0 <= idx < len(mbox.raws):
                        raw = mbox.raws[idx]
                        c.sendall(f'* {seq} FETCH (UID {u} RFC822 {{{len(raw)}}}\r\n'.encode())
                        c.sendall(raw + b')\r\n')
                        seq += 1
            c.sendall(f'{tag} OK FETCH completed\r\n'.encode())
        elif stripped.startswith('UID STORE') or stripped.startswith('STORE'):
            parts = stripped.split()
            try:
                uid = int(parts[2] if parts[0] == 'UID' else parts[1])
            except (IndexError, ValueError):
                uid = None
            if uid is not None:
                with mbox.lock:
                    mbox.imap_seen.add(uid)
                c.sendall(f'* {uid} FETCH (FLAGS (\\Seen))\r\n'.encode())
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--smtp', type=int, default=2525)
    ap.add_argument('--pop3', type=int, default=2110)
    ap.add_argument('--imap', type=int, default=2143)
    ap.add_argument('--log', action='store_true')
    args = ap.parse_args()

    mbox = Mailbox()
    log = (lambda m: print(m, flush=True)) if args.log else (lambda m: None)
    serve(args.smtp, lambda c: handle_smtp(mbox, c, log))
    serve(args.pop3, lambda c: handle_pop3(mbox, c, log))
    serve(args.imap, lambda c: handle_imap(mbox, c, log))
    print(f'mock mail: SMTP=127.0.0.1:{args.smtp} POP3=127.0.0.1:{args.pop3} IMAP=127.0.0.1:{args.imap}')
    threading.Event().wait()


if __name__ == '__main__':
    main()