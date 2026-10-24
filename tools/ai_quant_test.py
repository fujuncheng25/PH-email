#!/usr/bin/env python3
"""Build a tiny random-weight Qwen2 GGUF exercising every supported quant type and
compare the C++ engine against llama.cpp (llama-server) on it.

Types covered: F32, F16, BF16, Q8_0, Q4_0, Q4_1, Q5_0, Q5_1, Q4_K, Q6_K
(the tokenizer metadata is copied from a real Qwen2.5 GGUF so llama.cpp loads it).

The official Qwen2.5-0.5B Q4_K_M file is a mix of k-quants and (for rows whose
ne0 is not a multiple of 256) legacy quants, so every decode path is validated.

Usage:
  python ai_quant_test.py --real <Qwen2.5-1.5B-Q8_0.gguf> [--exe build-ai/Release/ai-selftest.exe]
"""
import argparse
import json
import os
import struct
import subprocess
import sys
import time
import urllib.request

import numpy as np

BACKEND_DIR = r"C:\Users\splay\.lmstudio\extensions\backends\llama.cpp-win-x86_64-avx2-2.23.1"
LLAMA_SERVER = os.path.join(BACKEND_DIR, "llama-server.exe")

GGUF_MAGIC = b"GGUF"
T_U8, T_I8, T_U16, T_I16, T_U32, T_I32, T_F32, T_BOOL, T_STR, T_ARR, T_U64 = range(11)
T_F32_, T_F16_, T_Q4_0_, T_Q4_1_, T_Q5_0_, T_Q5_1_, T_Q8_0_, T_Q4_K_, T_Q5_K_, T_Q6_K_, T_BF16_ = (
    0, 1, 2, 3, 6, 7, 8, 12, 13, 14, 30)


def read_gguf_meta(path):
    with open(path, "rb") as f:
        assert f.read(4) == GGUF_MAGIC
        f.read(4)
        n_tensors = struct.unpack("<Q", f.read(8))[0]
        n_kv = struct.unpack("<Q", f.read(8))[0]

        def rstr():
            n = struct.unpack("<Q", f.read(8))[0]
            return f.read(n).decode("utf-8", "surrogateescape")

        def rval(t):
            if t in (0, 1):
                return struct.unpack("<B" if t == 0 else "<b", f.read(1))[0]
            if t in (2, 3):
                return struct.unpack("<H" if t == 2 else "<h", f.read(2))[0]
            if t in (4, 5):
                return struct.unpack("<I" if t == 4 else "<i", f.read(4))[0]
            if t == 6:
                return struct.unpack("<f", f.read(4))[0]
            if t == 7:
                return struct.unpack("<?", f.read(1))[0]
            if t == 8:
                return rstr()
            if t == 9:
                et = struct.unpack("<I", f.read(4))[0]
                n = struct.unpack("<Q", f.read(8))[0]
                return [rval(et) for _ in range(n)]
            if t == 10:
                return struct.unpack("<Q", f.read(8))[0]
            if t == 11:
                return struct.unpack("<q", f.read(8))[0]
            if t == 12:
                return struct.unpack("<d", f.read(8))[0]
            raise ValueError("kv type %d" % t)

        meta = {}
        for _ in range(n_kv):
            k = rstr()
            t = struct.unpack("<I", f.read(4))[0]
            meta[k] = rval(t)
        for _ in range(n_tensors):
            rstr()
            nd = struct.unpack("<I", f.read(4))[0]
            for _ in range(nd):
                f.read(8)
            f.read(4)
            f.read(8)
    return meta


# ---------------------------------------------------------------------------
# quant block writers (GGML layouts)
# ---------------------------------------------------------------------------
def quant_f32(vals):
    return np.asarray(vals, dtype=np.float32).tobytes()


def quant_f16(vals):
    return np.asarray(vals, dtype=np.float16).tobytes()


def quant_bf16(vals):
    f32 = np.asarray(vals, dtype=np.float32)
    return (f32.view(np.uint32) >> 16).astype(np.uint16).tobytes()


def _blocks(n, block, rng_fn):
    """One python-level call per block, joined once (linear, not quadratic)."""
    return b"".join(rng_fn(i) for i in range(n // block))


def _q8_0(n, rng):
    return _blocks(n, 32, lambda i: struct.pack("<e", 0.02) +
                   rng.integers(-127, 128, 32, dtype=np.int8).tobytes())


def _q4_0(n, rng):
    return _blocks(n, 32, lambda i: struct.pack("<e", 0.02) +
                   rng.integers(0, 256, 16, dtype=np.uint8).tobytes())


def _q4_1(n, rng):
    return _blocks(n, 32, lambda i: struct.pack("<e", 0.02) + struct.pack("<e", 0.01) +
                   rng.integers(0, 256, 16, dtype=np.uint8).tobytes())


def _q5_0(n, rng):
    return _blocks(n, 32, lambda i: struct.pack("<e", 0.02) +
                   rng.integers(0, 2 ** 32, 1, dtype=np.uint32).tobytes() +
                   rng.integers(0, 256, 16, dtype=np.uint8).tobytes())


def _q5_1(n, rng):
    return _blocks(n, 32, lambda i: struct.pack("<e", 0.02) + struct.pack("<e", 0.01) +
                   rng.integers(0, 2 ** 32, 1, dtype=np.uint32).tobytes() +
                   rng.integers(0, 256, 16, dtype=np.uint8).tobytes())


def _q4_k(n, rng):
    return _blocks(n, 256, lambda i: struct.pack("<e", 0.002) + struct.pack("<e", 0.001) +
                   rng.integers(0, 64, 12, dtype=np.uint8).tobytes() +
                   rng.integers(0, 256, 128, dtype=np.uint8).tobytes())


def _q5_k(n, rng):
    return _blocks(n, 256, lambda i: struct.pack("<e", 0.002) + struct.pack("<e", 0.001) +
                   rng.integers(0, 64, 12, dtype=np.uint8).tobytes() +
                   rng.integers(0, 256, 32, dtype=np.uint8).tobytes() +
                   rng.integers(0, 256, 128, dtype=np.uint8).tobytes())


def _q6_k(n, rng):
    return _blocks(n, 256, lambda i: rng.integers(0, 256, 128, dtype=np.uint8).tobytes() +
                   rng.integers(0, 256, 64, dtype=np.uint8).tobytes() +
                   rng.integers(-127, 128, 16, dtype=np.int8).tobytes() +
                   struct.pack("<e", 0.001))


def gen_f32(n, rng):
    return np.asarray(rng.normal(0.0, 0.02, n), dtype=np.float32).tobytes()


def gen_f16(n, rng):
    return np.asarray(rng.normal(0.0, 0.02, n), dtype=np.float16).tobytes()


def gen_bf16(n, rng):
    f32 = np.asarray(rng.normal(0.0, 0.02, n), dtype=np.float32)
    return (f32.view(np.uint32) >> 16).astype(np.uint16).tobytes()


QUANT = {
    T_F32_: gen_f32,
    T_F16_: gen_f16,
    T_BF16_: gen_bf16,
    T_Q8_0_: _q8_0,
    T_Q4_0_: _q4_0,
    T_Q4_1_: _q4_1,
    T_Q5_0_: _q5_0,
    T_Q5_1_: _q5_1,
    T_Q4_K_: _q4_k,
    T_Q5_K_: _q5_k,
    T_Q6_K_: _q6_k,
}


def f32_vec(n, rng, scale=1.0):
    return quant_f32(rng.normal(0.0, scale, n))


def enc_str(s):
    b = s.encode("utf-8", "surrogateescape")
    return struct.pack("<Q", len(b)) + b


def enc_kv(key, typ, val):
    out = bytearray()
    out += enc_str(key)
    out += struct.pack("<I", typ)
    if typ in (T_U8, T_I8):
        out += struct.pack("<B" if typ == T_U8 else "<b", val)
    elif typ in (T_U16, T_I16):
        out += struct.pack("<H" if typ == T_U16 else "<h", val)
    elif typ in (T_U32, T_I32):
        out += struct.pack("<I" if typ == T_U32 else "<i", val)
    elif typ == T_F32:
        out += struct.pack("<f", val)
    elif typ == T_BOOL:
        out += struct.pack("<?", bool(val))
    elif typ == T_STR:
        out += enc_str(val)
    elif typ == T_U64:
        out += struct.pack("<Q", val)
    elif typ == T_ARR:
        etyp, items = val
        out += struct.pack("<I", etyp) + struct.pack("<Q", len(items))
        if etyp == T_STR:
            for it in items:
                out += enc_str(it)
        elif etyp == T_I32:
            out += struct.pack("<%di" % len(items), *items)
        else:
            raise ValueError("array elem type")
    else:
        raise ValueError("kv type")
    return bytes(out)


def build(real_model, out_path, seed=20261024, override_type=None, tensor_types=None):
    meta = read_gguf_meta(real_model)
    tokens = meta["tokenizer.ggml.tokens"]
    types = meta["tokenizer.ggml.token_type"]
    merges = meta["tokenizer.ggml.merges"]
    vocab = len(tokens)
    rng = np.random.default_rng(seed)

    n_layer, n_embd, n_ff, n_head, n_head_kv = 2, 256, 512, 8, 2
    head_dim = n_embd // n_head
    kv_dim = n_head_kv * head_dim

    tensors = []

    def add(name, ttype, dims, data):
        tensors.append({"name": name, "type": ttype, "dims": dims, "data": data})

    def weights(name, ttype, out_dim, in_dim):
        if tensor_types and name in tensor_types:
            ttype = tensor_types[name]
        elif override_type is not None:
            ttype = override_type
        n = out_dim * in_dim
        add(name, ttype, [in_dim, out_dim], QUANT[ttype](n, rng))

    # token_embd / output exercise Q4_0 / Q5_0
    weights("token_embd.weight", override_type or T_Q4_0_, vocab, n_embd)
    weights("output.weight", override_type or T_Q5_0_, vocab, n_embd)
    add("output_norm.weight", T_F32_, [n_embd], f32_vec(n_embd, rng))
    # per-layer type mix (covers every implemented type)
    layer_types = [
        # attn_q, attn_k, attn_v, attn_output, ffn_gate, ffn_up, ffn_down
        (T_Q4_1_, T_Q5_1_, T_Q8_0_, T_Q4_K_, T_Q6_K_, T_F16_, T_BF16_),
        (T_Q5_1_, T_Q5_K_, T_Q4_1_, T_Q8_0_, T_Q4_K_, T_BF16_, T_Q6_K_),
    ]
    if override_type is not None:
        layer_types = [(override_type,) * 7, (override_type,) * 7]
    for i in range(n_layer):
        p = "blk.%d." % i
        tq, tk, tv, to, tg, tu, td = layer_types[i]
        add(p + "attn_norm.weight", T_F32_, [n_embd], f32_vec(n_embd, rng))
        add(p + "ffn_norm.weight", T_F32_, [n_embd], f32_vec(n_embd, rng))
        weights(p + "attn_q.weight", tq, n_embd, n_embd)
        add(p + "attn_q.bias", T_F32_, [n_embd], f32_vec(n_embd, rng, 0.1))
        weights(p + "attn_k.weight", tk, kv_dim, n_embd)
        add(p + "attn_k.bias", T_F32_, [kv_dim], f32_vec(kv_dim, rng, 0.1))
        weights(p + "attn_v.weight", tv, kv_dim, n_embd)
        add(p + "attn_v.bias", T_F32_, [kv_dim], f32_vec(kv_dim, rng, 0.1))
        weights(p + "attn_output.weight", to, n_embd, n_embd)
        weights(p + "ffn_gate.weight", tg, n_ff, n_embd)
        weights(p + "ffn_up.weight", tu, n_ff, n_embd)
        weights(p + "ffn_down.weight", td, n_embd, n_ff)

    kvs = [
        ("general.architecture", T_STR, "qwen2"),
        ("general.name", T_STR, "tiny-qwen2-all-quants"),
        ("general.quantization_version", T_U32, 2),
        ("qwen2.block_count", T_U32, n_layer),
        ("qwen2.context_length", T_U32, 2048),
        ("qwen2.embedding_length", T_U32, n_embd),
        ("qwen2.feed_forward_length", T_U32, n_ff),
        ("qwen2.attention.head_count", T_U32, n_head),
        ("qwen2.attention.head_count_kv", T_U32, n_head_kv),
        ("qwen2.attention.layer_norm_rms_epsilon", T_F32, 1e-6),
        ("qwen2.rope.freq_base", T_F32, 1e6),
        ("tokenizer.ggml.model", T_STR, "gpt2"),
        ("tokenizer.ggml.pre", T_STR, "qwen2"),
        ("tokenizer.ggml.tokens", T_ARR, (T_STR, tokens)),
        ("tokenizer.ggml.token_type", T_ARR, (T_I32, [int(x) for x in types])),
        ("tokenizer.ggml.merges", T_ARR, (T_STR, merges)),
        ("tokenizer.ggml.bos_token_id", T_U32, int(meta.get("tokenizer.ggml.bos_token_id", 151643))),
        ("tokenizer.ggml.eos_token_id", T_U32, int(meta.get("tokenizer.ggml.eos_token_id", 151645))),
        ("tokenizer.ggml.padding_token_id", T_U32, int(meta.get("tokenizer.ggml.padding_token_id", 151643))),
        ("tokenizer.ggml.add_bos_token", T_BOOL, False),
        ("tokenizer.ggml.add_eos_token", T_BOOL, False),
    ]
    alignment = 32
    hdr = bytearray()
    hdr += GGUF_MAGIC + struct.pack("<I", 3)
    hdr += struct.pack("<Q", len(tensors)) + struct.pack("<Q", len(kvs))
    for key, typ, val in kvs:
        hdr += enc_kv(key, typ, val)
    offset = 0
    infos = bytearray()
    for t in tensors:
        offset = (offset + alignment - 1) // alignment * alignment
        t["offset"] = offset
        offset += len(t["data"])
        infos += enc_str(t["name"])
        infos += struct.pack("<I", len(t["dims"]))
        for d in t["dims"]:
            infos += struct.pack("<Q", d)
        infos += struct.pack("<I", t["type"])
        infos += struct.pack("<Q", t["offset"])
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(hdr)
        f.write(infos)
        f.write(b"\x00" * ((alignment - (len(hdr) + len(infos)) % alignment) % alignment))
        cur = 0
        for t in tensors:
            gap = t["offset"] - cur
            if gap:
                f.write(b"\x00" * gap)
                cur += gap
            f.write(t["data"])
            cur += len(t["data"])
    print("[quant-test] wrote %s (%.1f MB)" % (out_path, os.path.getsize(out_path) / 1e6))


# ---------------------------------------------------------------------------
# llama-server oracle
# ---------------------------------------------------------------------------
class Server:
    def __init__(self, model, port):
        self.port = port
        self.log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "quant-test-server.log")
        self.log = open(self.log_path, "wb")
        env = dict(os.environ)
        env["PATH"] = BACKEND_DIR + os.pathsep + env.get("PATH", "")
        self.proc = subprocess.Popen(
            [LLAMA_SERVER, "-m", model, "--port", str(port), "--host", "127.0.0.1",
             "-c", "1024", "-t", "4", "--no-webui"],
            cwd=BACKEND_DIR, stdout=self.log, stderr=self.log, env=env)
        t0 = time.time()
        while time.time() - t0 < 120:
            if self.proc.poll() is not None:
                raise SystemExit("llama-server exited early; see " + self.log_path)
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=2) as r:
                    if r.status == 200:
                        return
            except Exception:
                time.sleep(0.3)
        raise SystemExit("llama-server did not become ready")

    def post(self, path, obj, timeout=120):
        req = urllib.request.Request(
            "http://127.0.0.1:%d%s" % (self.port, path),
            data=json.dumps(obj).encode("utf-8"),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def close(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        self.log.close()


def run_selftest(exe, args):
    p = subprocess.run([exe] + args, capture_output=True)
    if p.returncode != 0:
        raise SystemExit("ai-selftest failed: %s" % p.stderr.decode("utf-8", "replace")[-600:])
    return json.loads(p.stdout.decode("utf-8", "replace").strip())


PROMPTS = [
    [151644, 100, 200, 300, 400, 151645, 151644],
    [151644, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 151645, 151644, 42],
    [151644] + list(range(100, 133)) + [151645, 151644],
]


def compare_one(srv, exe, model, ids, tol):
    r = srv.post("/completion", {"prompt": ids, "n_predict": 8, "temperature": 0.0,
                                 "top_k": 1, "cache_prompt": False, "n_probs": 10})
    probs = r.get("completion_probabilities") or []
    ref_top = [(int(t["id"]), float(t["logprob"])) for t in probs[0]["top_logprobs"]]
    ref_gen = [int(p["id"]) for p in probs]
    ours = run_selftest(exe, ["logits", model, ",".join(map(str, ids))])["topk"]
    ours_norm = [(x["id"], x["logit"] - ours[0]["logit"]) for x in ours]
    ref_norm = [(i, lp - ref_top[0][1]) for i, lp in ref_top]
    ref_map = dict(ref_norm)
    max_delta = max((abs(d - ref_map[i]) for i, d in ours_norm if i in ref_map), default=99.0)
    gen = run_selftest(exe, ["generate", model, "--ids", ",".join(map(str, ids)),
                             "8", "--no-newline-stop"])["tokens"]
    top1_ok = ref_top[0][0] == ours_norm[0][0]
    ids_ok = [i for i, _ in ref_top] == [i for i, _ in ours_norm]
    gen_ok = gen == ref_gen[:len(gen)] and len(gen) == len(ref_gen)
    ok = top1_ok and gen_ok and ids_ok and max_delta < tol
    return ok, top1_ok, ids_ok, gen_ok, max_delta, ref_gen, gen, ref_norm[:5], ours_norm[:5]


def run_suite(exe, model, port, prompts, tol, label):
    ok_all = True
    srv = Server(model, port)
    try:
        for ids in prompts:
            ok, top1, ids_ok, gen_ok, delta, ref_gen, gen, rtop, otop = compare_one(
                srv, exe, model, ids, tol)
            if not ok:
                ok_all = False
            print("[%s] %-14s len=%-3d top1=%s top10=%s gen=%s max_delta=%.4f %s" %
                  (label, "prompt", len(ids), "ok" if top1 else "DIFF",
                   "ok" if ids_ok else "DIFF", "ok" if gen_ok else "DIFF", delta,
                   "PASS" if ok else "FAIL"))
            if not ok:
                print("   ref_gen:", ref_gen, "\n   our_gen:", gen)
                print("   ref top5:", rtop, "\n   our top5:", otop)
    finally:
        srv.close()
    return ok_all


ISOLATE_TYPES = [("F16", T_F16_), ("BF16", T_BF16_), ("Q8_0", T_Q8_0_), ("Q4_0", T_Q4_0_),
                 ("Q4_1", T_Q4_1_), ("Q5_0", T_Q5_0_), ("Q5_1", T_Q5_1_),
                 ("Q4_K", T_Q4_K_), ("Q5_K", T_Q5_K_), ("Q6_K", T_Q6_K_)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--real", required=True, help="real Qwen2.5 GGUF to copy tokenizer metadata from")
    ap.add_argument("--exe", required=True)
    ap.add_argument("--port", type=int, default=25392)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                  "..", "build-ai", "quant-test", "tiny-all-quants.gguf"))
    ap.add_argument("--isolate", action="store_true",
                    help="build one model per quant type (all weights of that type) and compare")
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    ok_all = True
    if a.isolate:
        for name, tid in ISOLATE_TYPES:
            path = out.replace(".gguf", "-%s.gguf" % name)
            build(a.real, path, override_type=tid)
            try:
                ok = run_suite(a.exe, path, a.port, PROMPTS[:2], 0.05, "isolated " + name)
            except SystemExit as e:
                print("[isolated %s] llama-server failed: %s" % (name, e))
                ok = False
            print("[isolated %s] %s" % (name, "PASS" if ok else "FAIL"))
            ok_all = ok_all and ok
    else:
        build(a.real, out)
        ok_all = run_suite(a.exe, out, a.port, PROMPTS, 0.30, "mixed")
        print("[mixed all-quant model] %s" % ("PASS" if ok_all else "FAIL"))
    print("RESULT:", "PASS" if ok_all else "FAIL")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
