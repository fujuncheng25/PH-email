#!/usr/bin/env python3
"""Tiny TLS-terminating proxy: TLS on listen ports, plaintext to mock servers.

Used by Lead to reproduce/validate the Windows CA-store bug without internet.
"""
import argparse
import select
import socket
import ssl
import threading

HERE = r"C:\Users\splay\Documents\email-automate\tls-test"


def pump(a, b):
    try:
        while True:
            r, _, _ = select.select([a, b], [], [], 30)
            if not r:
                break
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.close()
            except OSError:
                pass


def serve(listen_port, target_port, ctx):
    ls = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ls.bind(("127.0.0.1", listen_port))
    ls.listen(16)

    def loop():
        while True:
            c, _ = ls.accept()
            threading.Thread(target=handle, args=(c, target_port, ctx), daemon=True).start()

    def handle(c, tport, context):
        try:
            tls = context.wrap_socket(c, server_side=True)
        except Exception as e:
            print("TLS handshake failed:", e, flush=True)
            try:
                c.close()
            except OSError:
                pass
            return
        try:
            up = socket.create_connection(("127.0.0.1", tport), timeout=20)
        except OSError:
            tls.close()
            return
        pump(tls, up)

    threading.Thread(target=loop, daemon=True).start()
    print("TLS proxy 127.0.0.1:%d -> %d" % (listen_port, target_port), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smtp", type=int, default=25750)
    ap.add_argument("--smtp-target", type=int, default=25850)
    ap.add_argument("--pop3", type=int, default=25751)
    ap.add_argument("--pop3-target", type=int, default=25851)
    ap.add_argument("--imap", type=int, default=25752)
    ap.add_argument("--imap-target", type=int, default=25852)
    a = ap.parse_args()
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(HERE + r"\srv.crt", HERE + r"\srv.key")
    serve(a.smtp, a.smtp_target, ctx)
    serve(a.pop3, a.pop3_target, ctx)
    serve(a.imap, a.imap_target, ctx)
    threading.Event().wait()


if __name__ == "__main__":
    main()
