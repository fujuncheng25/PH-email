#!/usr/bin/env python3
"""node-ai-build-tiny.py — 构造小型 Qwen2 GGUF 测试模型（仅用于量化解码/前向验证）。

小词表（默认 512），可选张量类型组合，用于把“Q4_K/Q6_K 解码是否正确”从
“llama.cpp 量化矩阵乘的近似误差”中隔离出来：
  - 生成模型 m.gguf（例如全部 F32 / 只有 output 是 Q6_K / 全部 Q4_K）
  - 生成对应的 F32 孪生 m.twin.gguf（反量化结果，用 node-ai-verify-quant.py twin）
  - llama-server(m) 与 llama-server(m.twin) 的 logits 应几乎一致（只差量化 matmul 近似）；
    若差异巨大，说明 m 的量化张量被 llama.cpp 解释得与我们的反量化不同。

用法：
  python node-ai-build-tiny.py build <out.gguf> --quant q4k|q6k|f32 --which all|out --seed 1
"""
import argparse
import os
import struct

import numpy as np

GGUF_MAGIC = b"GGUF"
T_U8, T_I8, T_U16, T_I16, T_U32, T_I32, T_F32, T_BOOL, T_STR, T_ARR, T_U64 = range(11)
GGML_F32, GGML_Q4_K, GGML_Q6_K = 0, 12, 14
ALIGN = 32


def rng_for(seed):
    return np.random.default_rng(seed)


def random_blocks(rng, n_weights, kind):
    if kind == "q4k":
        assert n_weights % 256 == 0
        parts = []
        for _ in range(n_weights // 256):
            d = struct.pack("<e", 5e-5)
            dmin = struct.pack("<e", 1e-5)
            scales = rng.integers(0, 64, size=12, dtype=np.uint8).tobytes()
            qs = rng.integers(0, 256, size=128, dtype=np.uint8).tobytes()
            parts.append(d + dmin + scales + qs)
        return b"".join(parts)
    if kind == "q6k":
        assert n_weights % 256 == 0
        parts = []
        for _ in range(n_weights // 256):
            ql = rng.integers(0, 256, size=128, dtype=np.uint8).tobytes()
            qh = rng.integers(0, 256, size=64, dtype=np.uint8).tobytes()
            sc = rng.integers(-64, 65, size=16, dtype=np.int8).tobytes()
            d = struct.pack("<e", 1e-5)
            parts.append(ql + qh + sc + d)
        return b"".join(parts)
    raise ValueError(kind)


def build(out, quant, which, seed, vocab=512, n_layer=1, n_embd=256, n_ff=512, n_head=8, n_head_kv=2):
    rng = rng_for(seed)
    kv_dim = n_head_kv * (n_embd // n_head)

    def mat(count, use_quant):
        if not use_quant:
            return struct.pack("%df" % count, *rng.normal(0, 0.02, count).astype(np.float32))
        if quant == "q4k":
            return random_blocks(rng, count, "q4k")
        return random_blocks(rng, count, "q6k")

    tensors = []

    def add(name, ttype, dims, data):
        tensors.append({"name": name, "type": ttype, "dims": dims, "data": data})

    def q_type():
        return GGML_Q4_K if quant == "q4k" else GGML_Q6_K

    def want(name):
        if which == "all":
            return True
        # which == "out"：只有 output.weight 用量化
        return name == "output.weight"

    def f32(v):
        return struct.pack("%df" % len(v), *np.asarray(v, dtype=np.float32).astype(np.float32))

    # embedding：只有 which=all 且 quant 时量化（避免 vocab 太大导致行不是 256 倍数）
    emb_quant = (which == "all")
    add("token_embd.weight", q_type() if emb_quant else GGML_F32, [n_embd, vocab],
        mat(n_embd * vocab, emb_quant))
    out_quant = (which == "all") or (which == "out")
    add("output.weight", q_type() if out_quant else GGML_F32, [n_embd, vocab],
        mat(n_embd * vocab, out_quant))
    add("output_norm.weight", GGML_F32, [n_embd], f32(np.ones(n_embd)))
    for i in range(n_layer):
        pre = "blk.%d." % i
        add(pre + "attn_norm.weight", GGML_F32, [n_embd], f32(np.ones(n_embd)))
        add(pre + "ffn_norm.weight", GGML_F32, [n_embd], f32(np.ones(n_embd)))
        for nm, dims in [
            ("attn_q.weight", [n_embd, n_embd]),
            ("attn_k.weight", [n_embd, kv_dim]),
            ("attn_v.weight", [n_embd, kv_dim]),
            ("attn_output.weight", [n_embd, n_embd]),
            ("ffn_gate.weight", [n_embd, n_ff]),
            ("ffn_up.weight", [n_embd, n_ff]),
            ("ffn_down.weight", [n_ff, n_embd]),
        ]:
            use_q = (which == "all")
            add(pre + nm, q_type() if use_q else GGML_F32, dims, mat(dims[0] * dims[1], use_q))
        add(pre + "attn_q.bias", GGML_F32, [n_embd], f32(rng.normal(0, 0.1, n_embd)))
        add(pre + "attn_k.bias", GGML_F32, [kv_dim], f32(rng.normal(0, 0.1, kv_dim)))
        add(pre + "attn_v.bias", GGML_F32, [kv_dim], f32(rng.normal(0, 0.1, kv_dim)))

    tokens = ["<|endoftext|>"] + ["<t%d>" % i for i in range(1, vocab)]
    token_types = [3] + [1] * (vocab - 1)

    def enc_str(s):
        b = s.encode("utf-8")
        return struct.pack("<Q", len(b)) + b

    def kv_str(key, val):
        return enc_str(key) + struct.pack("<I", T_STR) + enc_str(val)

    def kv_u32(key, val):
        return enc_str(key) + struct.pack("<I", T_U32) + struct.pack("<I", int(val))

    def kv_f32(key, val):
        return enc_str(key) + struct.pack("<I", T_F32) + struct.pack("<f", float(val))

    def kv_bool(key, val):
        return enc_str(key) + struct.pack("<I", T_BOOL) + struct.pack("<?", bool(val))

    def kv_arr_str(key, arr):
        out = enc_str(key) + struct.pack("<I", T_ARR) + struct.pack("<I", T_STR) + struct.pack("<Q", len(arr))
        for s in arr:
            out += enc_str(s)
        return out

    def kv_arr_i32(key, arr):
        out = enc_str(key) + struct.pack("<I", T_ARR) + struct.pack("<I", T_I32) + struct.pack("<Q", len(arr))
        for s in arr:
            out += struct.pack("<i", int(s))
        return out

    kvs = [
        kv_str("general.architecture", "qwen2"),
        kv_str("general.name", "tiny-%s-%s" % (quant, which)),
        kv_u32("general.quantization_version", 2),
        kv_u32("qwen2.block_count", n_layer),
        kv_u32("qwen2.context_length", 2048),
        kv_u32("qwen2.embedding_length", n_embd),
        kv_u32("qwen2.feed_forward_length", n_ff),
        kv_u32("qwen2.attention.head_count", n_head),
        kv_u32("qwen2.attention.head_count_kv", n_head_kv),
        kv_f32("qwen2.attention.layer_norm_rms_epsilon", 1e-6),
        kv_f32("qwen2.rope.freq_base", 1e6),
        kv_str("tokenizer.ggml.model", "gpt2"),
        kv_str("tokenizer.ggml.pre", "qwen2"),
        kv_arr_str("tokenizer.ggml.tokens", tokens),
        kv_arr_i32("tokenizer.ggml.token_type", token_types),
        kv_arr_str("tokenizer.ggml.merges", []),
        kv_u32("tokenizer.ggml.bos_token_id", 0),
        kv_u32("tokenizer.ggml.eos_token_id", 0),
        kv_u32("tokenizer.ggml.padding_token_id", 0),
        kv_bool("tokenizer.ggml.add_bos_token", False),
        kv_bool("tokenizer.ggml.add_eos_token", False),
    ]

    hdr = bytearray(GGUF_MAGIC + struct.pack("<I", 3))
    hdr += struct.pack("<Q", len(tensors)) + struct.pack("<Q", len(kvs))
    for k in kvs:
        hdr += k
    infos = bytearray()
    offset = 0
    for t in tensors:
        offset = (offset + ALIGN - 1) // ALIGN * ALIGN
        t["offset"] = offset
        offset += len(t["data"])
        infos += enc_str(t["name"])
        infos += struct.pack("<I", len(t["dims"]))
        for d in t["dims"]:
            infos += struct.pack("<Q", d)
        infos += struct.pack("<I", t["type"]) + struct.pack("<Q", t["offset"])
    pad = (ALIGN - (len(hdr) + len(infos)) % ALIGN) % ALIGN
    with open(out, "wb") as f:
        f.write(hdr)
        f.write(infos)
        f.write(b"\x00" * pad)
        cur = 0
        for t in tensors:
            if t["offset"] > cur:
                f.write(b"\x00" * (t["offset"] - cur))
                cur = t["offset"]
            f.write(t["data"])
            cur += len(t["data"])
    print("wrote %s (%.2f MB) quant=%s which=%s seed=%d" % (out, os.path.getsize(out) / 1e6, quant, which, seed))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("out")
    b.add_argument("--quant", choices=["q4k", "q6k", "f32"], default="f32")
    b.add_argument("--which", choices=["all", "out"], default="all")
    b.add_argument("--seed", type=int, default=1)
    b.add_argument("--vocab", type=int, default=512)
    a = ap.parse_args()
    if a.cmd == "build":
        if a.quant == "f32":
            # f32 模型：quant 参数仅用于命名，实际全 F32
            build(a.out, "f32", a.which, a.seed, vocab=a.vocab)
        else:
            build(a.out, a.quant, a.which, a.seed, vocab=a.vocab)


if __name__ == "__main__":
    main()
