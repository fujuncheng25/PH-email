#!/usr/bin/env python3
"""Local HTTP download tests for the C++ ai::Manager downloader (no internet needed).

Starts a local HTTP server with several behaviours (Content-Length, chunked,
301/302 redirect chains, redirect loop, 404, truncated body, slow stream for
cancellation, and all-404 HF candidates for mirror fallback), then runs
`ai-selftest download ...` against each and asserts the resulting manager state.

Usage:
  python ai_dl_test.py --exe build-ai/Release/ai-selftest.exe
"""
import argparse
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time

GB = 1024 * 1024
PAYLOAD_SIZE = 53 * 1024 * 1024  # > 50 MB validation threshold
MODEL = "qwen2.5-0.5b-instruct-q4_k_m.gguf"
HERE = os.path.dirname(os.path.abspath(__file__))


def make_payload(size=PAYLOAD_SIZE, magic=b"GGUF"):
    # GGUF magic + zeros; enough for the manager's magic/size validation.
    return magic + b"\x00" * (size - len(magic))


PAYLOAD = make_payload()
SMALL_PAYLOAD = make_payload(1 * GB)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send_headers(self, code, length=None, chunked=False, location=None):
        self.send_response(code)
        if location is not None:
            self.send_header("Location", location)
        if chunked:
            self.send_header("Transfer-Encoding", "chunked")
        elif length is not None:
            self.send_header("Content-Length", str(length))
        self.end_headers()

    def _send_all(self, data, chunked=False):
        if chunked:
            block = 64 * 1024
            for i in range(0, len(data), block):
                part = data[i:i + block]
                self.wfile.write(("%x\r\n" % len(part)).encode() + part + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
        else:
            self.wfile.write(data)

    def do_GET(self):
        p = self.path.split("?")[0]
        try:
            if p == "/ok":
                self._send_headers(200, length=len(PAYLOAD))
                self._send_all(PAYLOAD)
            elif p == "/ok-chunked":
                self._send_headers(200, chunked=True)
                self._send_all(PAYLOAD, chunked=True)
            elif p == "/redirect-ok":
                self._send_headers(302, location="/ok")
            elif p == "/redirect-chain":
                self._send_headers(302, location="/redirect-ok")
            elif p == "/redirect-loop":
                self._send_headers(302, location="/redirect-loop")
            elif p == "/small":
                self._send_headers(200, length=len(SMALL_PAYLOAD))
                self._send_all(SMALL_PAYLOAD)
            elif p == "/bad-magic":
                bad = b"NOPE" + b"\x00" * (PAYLOAD_SIZE - 4)
                self._send_headers(200, length=len(bad))
                self._send_all(bad)
            elif p == "/404":
                self._send_headers(404, length=0)
            elif p == "/truncated":
                self._send_headers(200, length=len(PAYLOAD))
                self.wfile.write(PAYLOAD[: len(PAYLOAD) // 2])
                self.wfile.flush()
                self.close_connection = True
            elif p == "/slow":
                self._send_headers(200, length=len(PAYLOAD))
                block = 1024 * 1024
                for i in range(0, len(PAYLOAD), block):
                    try:
                        self.wfile.write(PAYLOAD[i:i + block])
                        self.wfile.flush()
                    except Exception:
                        return
                    time.sleep(0.15)
            elif "/unsloth/" in p:
                self._send_headers(200, length=len(PAYLOAD))
                self._send_all(PAYLOAD)
            elif "/bartowski/" in p or "/Qwen/" in p:
                self._send_headers(404, length=0)
            else:
                self._send_headers(404, length=0)
        except (BrokenPipeError, ConnectionResetError):
            pass


def start_server():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, srv.server_address[1]


def run_selftest(exe, args, timeout=180):
    p = subprocess.run([exe] + args, capture_output=True, timeout=timeout)
    out = p.stdout.decode("utf-8", "replace").strip()
    try:
        return json.loads(out), p.returncode, p.stderr.decode("utf-8", "replace")
    except Exception:
        raise SystemExit("bad JSON (%d): %r\nstderr: %s" % (p.returncode, out[:400], p.stderr[-800:]))


def case_dir(root, name):
    d = os.path.join(root, name)
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    return d


def run_case(exe, root, name, base, extra, expect_ok, expect_error_substr=None,
             expect_part=False, expect_model=True):
    d = case_dir(root, name)
    args = ["download", d, MODEL, "--url", base] + extra
    t0 = time.time()
    res, rc, err = run_selftest(exe, args)
    dt = time.time() - t0
    problems = []
    if res.get("ok") is not expect_ok:
        problems.append("ok=%r expected %r" % (res.get("ok"), expect_ok))
    if res.get("model_exists") is not expect_model:
        problems.append("model_exists=%r expected %r" % (res.get("model_exists"), expect_model))
    if res.get("part_exists") is not expect_part:
        problems.append("part_exists=%r expected %r" % (res.get("part_exists"), expect_part))
    if rc != (0 if expect_ok else 5):
        problems.append("exit=%d" % rc)
    err_text = (res.get("error") or "") + " " + (res.get("status", {}).get("error") or "")
    if expect_error_substr and expect_error_substr not in err_text:
        problems.append("error %r missing %r" % (err_text[:200], expect_error_substr))
    mp = os.path.join(d, "models", MODEL)
    if expect_model and expect_ok:
        if not os.path.exists(mp) or os.path.getsize(mp) != PAYLOAD_SIZE:
            problems.append("model file size mismatch")
        else:
            with open(mp, "rb") as f:
                if f.read(4) != b"GGUF":
                    problems.append("model magic mismatch")
    st = res.get("status", {})
    status = "PASS" if not problems else "FAIL: " + "; ".join(problems)
    print("[dl] %-22s %6.2fs %s  (downloaded=%s/%s)" %
          (name, dt, status, st.get("downloaded_bytes"), st.get("total_bytes")))
    if problems:
        print("     result:", json.dumps(res, ensure_ascii=False)[:500])
    return not problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    a = ap.parse_args()
    root = os.path.join(os.path.dirname(os.path.abspath(a.exe)), "dl-test")
    os.makedirs(root, exist_ok=True)
    srv, port = start_server()
    base = "http://127.0.0.1:%d" % port
    print("[dl] local server on", base, "payload %.1f MB" % (PAYLOAD_SIZE / 1048576.0))
    results = []
    try:
        results.append(run_case(a.exe, root, "ok", base + "/ok", [], True))
        results.append(run_case(a.exe, root, "chunked", base + "/ok-chunked", [], True))
        results.append(run_case(a.exe, root, "redirect-302", base + "/redirect-ok", [], True))
        results.append(run_case(a.exe, root, "redirect-chain", base + "/redirect-chain", [], True))
        results.append(run_case(a.exe, root, "redirect-loop", base + "/redirect-loop", [], False,
                                "重定向次数过多", expect_part=False, expect_model=False))
        results.append(run_case(a.exe, root, "too-small", base + "/small", [], False, "过小",
                                expect_model=False))
        results.append(run_case(a.exe, root, "bad-magic", base + "/bad-magic", [], False, "GGUF",
                                expect_model=False))
        results.append(run_case(a.exe, root, "http-404", base + "/404", [], False, "404",
                                expect_model=False))
        results.append(run_case(a.exe, root, "truncated", base + "/truncated", [], False,
                                "下载中断", expect_model=False))
        results.append(run_case(a.exe, root, "cancel", base + "/slow",
                                ["--cancel-after-ms", "700"], False, "取消",
                                expect_part=False, expect_model=False))
        results.append(run_case(a.exe, root, "connect-refused",
                                "http://127.0.0.1:1/ok", [], False, "无法连接",
                                expect_model=False))
        # mirror 候选依次尝试：前两个 404，第三个（unsloth）成功
        d = case_dir(root, "mirror-fallback")
        res, rc, err = run_selftest(a.exe, ["download", d, MODEL, "--mirror", base])
        ok = rc == 0 and res.get("ok") and res.get("model_exists")
        print("[dl] %-22s %s" % ("mirror-fallback", "PASS" if ok else "FAIL: " + json.dumps(res)[:300]))
        results.append(bool(ok))
        # 已就绪时再次下载：start_download 应立即返回 false + "已就绪"
        res, rc, err = run_selftest(a.exe, ["download", d, MODEL])
        already = (rc == 4 and "已就绪" in (res.get("error") or ""))
        print("[dl] %-22s %s" % ("already-ready", "PASS" if already else
                               "FAIL: rc=%d res=%s" % (rc, json.dumps(res, ensure_ascii=False)[:300])))
        results.append(already)
        # https 到明文 HTTP 端口：TLS 握手失败，错误信息明确
        res, rc, err = run_selftest(a.exe, ["download", case_dir(root, "tls-fail"), MODEL,
                                            "--url", "https://127.0.0.1:%d/ok" % port])
        tls_ok = (rc == 5 and ("TLS" in ((res.get("error") or "") + (res.get("status", {}).get("error") or ""))))
        print("[dl] %-22s %s" % ("tls-handshake-fail", "PASS" if tls_ok else
                               "FAIL: " + json.dumps(res, ensure_ascii=False)[:300]))
        results.append(tls_ok)
    finally:
        srv.shutdown()
    ok = sum(1 for r in results if r)
    print("[dl] %d/%d cases passed" % (ok, len(results)))
    print("RESULT:", "PASS" if ok == len(results) else "FAIL")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
