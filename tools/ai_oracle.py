#!/usr/bin/env python3
"""Compare the C++ AI engine against a running llama-server oracle.

The llama.cpp server (LM Studio's llama-server.exe) must already be running
with the same GGUF model, e.g.:

  llama-server.exe -m <model.gguf> --port 25390 --host 127.0.0.1 -c 2048 -t 4 --no-webui

Usage:
  python ai_oracle.py --exe build-ai/Release/ai-selftest.exe --model <model.gguf> [--port 25390]

Tests:
  1. tokenizer exact-id agreement on a mixed Chinese/English/punctuation corpus
     (`AI_THREADS` irrelevant here)
  2. greedy generation from identical prompt token ids (first N ids must match)
  3. next-token top-k logit agreement for a few prompt id sequences
"""
import argparse
import json
import subprocess
import sys
import urllib.request

CASES = [
    "Hello world",
    "你好，世界！这是一个测试。",
    "Email: test@example.com 12345 3.14",
    "don't can't I'll we're",
    "  leading spaces and\nnewlines\n\n",
    "\tTab\tand   multiple   spaces ",
    "中文English混排 with punctuation?!",
    "😀🎉 emoji test",
    "会议安排在2026年10月24日下午3点，请准时参加。",
    "Re: [Project] Q3 planning\n\nHi team,\nPlease review the attached doc.\n\nThanks!",
    "「引号」和“引号”以及'单引号'",
    "a1b2c3",
    "C++ / C# / .NET",
    "   ",
    "\n\n",
    "line1\nline2\n\nline3",
    "DON'T STOP",
    "\u3000全角空格\u00a0硬空格",
    "https://example.com/path?q=1&x=2",
    "3.1415926535",
    "  你好  世界  ",
    "测试：中文标点。！？；：",
    "- bullet item\n# heading\n> quote",
    "🙂",
    "这是一段较长的中文正文，用来测试分词器在处理连续汉字、数字 123 和英文 mixed words 时的切分是否与 llama.cpp 完全一致。",
    "can we meet tomorrow? i'll bring the doc, don't worry.",
    "   缩进四个空格开头的行\n第二行",
    "----====****~~~~____",
    "MiXeD CaSe WORDS and UPPER",
    "",
]


def post(port, path, obj, timeout=300):
    req = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (port, path),
        data=json.dumps(obj).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def run_selftest(exe, args):
    p = subprocess.run([exe] + args, capture_output=True)
    if p.returncode != 0:
        raise SystemExit("ai-selftest failed (%d): %s" % (p.returncode, p.stderr.decode("utf-8", "replace")))
    out = p.stdout.decode("utf-8", "replace").strip()
    try:
        return json.loads(out)
    except Exception:
        raise SystemExit("bad JSON from ai-selftest: %r" % out[:400])


def test_tokenizer(exe, model, port):
    ok = 0
    bad = []
    for text in CASES:
        ref = post(port, "/tokenize", {"content": text, "add_special": False, "parse_special": True})
        got = run_selftest(exe, ["tokenize", model, text, "--add-special"])["tokens"]
        if ref["tokens"] == got:
            ok += 1
        else:
            bad.append((text, ref["tokens"], got))
    print("[tokenizer] %d/%d exact matches (%.1f%%)" % (ok, len(CASES), 100.0 * ok / len(CASES)))
    for text, a, b in bad:
        print("  MISMATCH %r\n    llama=%s\n    ours =%s" % (text, a, b))
    return ok, len(CASES)


def test_generate(exe, model, port, n_predict=16):
    texts = [
        "The capital of France is",
        "你好，请帮我写一个",
        "Meeting reminder:",
        "1 + 1 =",
        "def fibonacci(n):",
    ]
    ok = 0
    total = 0
    for text in texts:
        ref_tok = post(port, "/tokenize", {"content": text, "add_special": False, "parse_special": True})
        ids = ref_tok["tokens"]
        r = post(port, "/completion", {
            "prompt": ids,
            "n_predict": n_predict,
            "temperature": 0.0,
            "top_k": 1,
            "cache_prompt": False,
        })
        ref_ids = [p["id"] for p in r.get("completion_probabilities", [])]
        # fall back to re-tokenizing content if probabilities were omitted
        if not ref_ids:
            rt = post(port, "/tokenize", {"content": r.get("content", ""), "add_special": False,
                                          "parse_special": False})
            ref_ids = rt["tokens"]
        ours = run_selftest(exe, ["generate", model, "--ids", ",".join(str(i) for i in ids),
                                  str(n_predict), "--no-newline-stop"])
        got = ours["tokens"]
        total += 1
        match_n = 0
        for a, b in zip(ref_ids, got):
            if a != b:
                break
            match_n += 1
        status = "OK" if match_n >= 8 else "FAIL"
        if status == "OK":
            ok += 1
        print("[generate] %-28r prompt=%d tokens: first-match=%d/%d %s"
              % (text, len(ids), match_n, max(len(ref_ids), len(got)), status))
        if status != "OK":
            print("    llama=%s\n    ours =%s" % (ref_ids[:16], got[:16]))
    print("[generate] %d/%d cases with >=8 matching leading tokens" % (ok, total))
    return ok, total


def test_logits(exe, model, port):
    seqs = [
        [9707, 1879],
        [108386, 3837, 99489, 6313],
        [151644, 8948, 198, 6023, 198, 2610, 525, 498, 30, 151645],
        [104811, 22574, 100235, 59956, 448, 61503, 25984],
        [220, 6388],
    ]
    ok = 0
    for ids in seqs:
        r = post(port, "/completion", {
            "prompt": ids,
            "n_predict": 1,
            "temperature": 0.0,
            "top_k": 1,
            "cache_prompt": False,
            "n_probs": 10,
        })
        probs = (r.get("completion_probabilities") or [])
        if not probs:
            print("[logits] no completion_probabilities for", ids)
            continue
        top = probs[0]["top_logprobs"]
        ref = [(t["id"], t["logprob"]) for t in top]
        ours = run_selftest(exe, ["logits", model, ",".join(str(i) for i in ids)])["topk"]
        ours_norm = [(x["id"], x["logit"] - ours[0]["logit"]) for x in ours]
        ref_norm = [(i, lp - ref[0][1]) for i, lp in ref]
        ids_match = [i for i, _ in ref] == [i for i, _ in ours_norm]
        max_delta = 0.0
        common = 0
        ref_map = dict(ref_norm)
        for i, d in ours_norm:
            if i in ref_map:
                max_delta = max(max_delta, abs(d - ref_map[i]))
                common += 1
        status = "OK" if ids_match and max_delta < 0.05 else "FAIL"
        if status == "OK":
            ok += 1
        print("[logits] prompt=%s top10 ids %s max_rel_logit_delta=%.5f common=%d %s"
              % (ids, "match" if ids_match else "DIFF", max_delta, common, status))
        if status != "OK":
            print("    llama(top5)=%s\n    ours (top5)=%s" % (ref_norm[:5], ours_norm[:5]))
    print("[logits] %d/%d sequences agree" % (ok, len(seqs)))
    return ok, len(seqs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--port", type=int, default=25390)
    ap.add_argument("--skip", default="")
    a = ap.parse_args()
    skip = set(x for x in a.skip.split(",") if x)
    fail = 0
    if "tokenizer" not in skip:
        ok, n = test_tokenizer(a.exe, a.model, a.port)
        fail += (n - ok) > 0
    if "generate" not in skip:
        ok, n = test_generate(a.exe, a.model, a.port)
        fail += (n - ok) > 0
    if "logits" not in skip:
        ok, n = test_logits(a.exe, a.model, a.port)
        fail += (n - ok) > 0
    print("RESULT:", "PASS" if fail == 0 else "FAIL")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
