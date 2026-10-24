#!/usr/bin/env python3
"""Exact dequantisation cross-check for the C++ GGUF reader.

For every quant type present in a GGUF, dumps a tensor row with
`ai-selftest dumprow` and compares it against an independent NumPy
implementation of the ggml reference dequantisers (ggml-quants.c layout).

Usage:
  python ai_dequant_test.py --exe build-ai/Release/ai-selftest.exe --model <a.gguf> [--model <b.gguf> ...]
"""
import argparse
import json
import struct
import subprocess
import sys

import numpy as np

T_F32, T_F16, T_Q4_0, T_Q4_1, T_Q5_0, T_Q5_1, T_Q8_0, T_Q4_K, T_Q5_K, T_Q6_K, T_BF16 = (
    0, 1, 2, 3, 6, 7, 8, 12, 13, 14, 30)
TYPE_NAME = {T_F32: "F32", T_F16: "F16", T_BF16: "BF16", T_Q4_0: "Q4_0", T_Q4_1: "Q4_1",
             T_Q5_0: "Q5_0", T_Q5_1: "Q5_1", T_Q8_0: "Q8_0", T_Q4_K: "Q4_K", T_Q5_K: "Q5_K",
             T_Q6_K: "Q6_K"}
LAYOUT = {  # (block elems, block bytes)
    T_F32: (1, 4), T_F16: (1, 2), T_BF16: (1, 2), T_Q4_0: (32, 18), T_Q4_1: (32, 20),
    T_Q5_0: (32, 22), T_Q5_1: (32, 24), T_Q8_0: (32, 34), T_Q4_K: (256, 144),
    T_Q5_K: (256, 176), T_Q6_K: (256, 210),
}


def _patch_str(s):
    return s.decode("utf-8", "surrogateescape")


def read_gguf(path):
    """Return (metadata dict, tensor list [{name,type,dims,offset}], data_start)."""
    with open(path, "rb") as f:
        assert f.read(4) == b"GGUF", "not GGUF"
        version = struct.unpack("<I", f.read(4))[0]
        n_tensors = struct.unpack("<Q", f.read(8))[0]
        n_kv = struct.unpack("<Q", f.read(8))[0]

        def rstr():
            n = struct.unpack("<Q", f.read(8))[0]
            return _patch_str(f.read(n))

        def rval(t, keep=False):
            if t in (0,):
                v = struct.unpack("<B", f.read(1))[0]
            elif t == 1:
                v = struct.unpack("<b", f.read(1))[0]
            elif t == 2:
                v = struct.unpack("<H", f.read(2))[0]
            elif t == 3:
                v = struct.unpack("<h", f.read(2))[0]
            elif t == 4:
                v = struct.unpack("<I", f.read(4))[0]
            elif t == 5:
                v = struct.unpack("<i", f.read(4))[0]
            elif t == 6:
                v = struct.unpack("<f", f.read(4))[0]
            elif t == 7:
                v = struct.unpack("<?", f.read(1))[0]
            elif t == 8:
                v = rstr()
            elif t == 9:
                et = struct.unpack("<I", f.read(4))[0]
                n = struct.unpack("<Q", f.read(8))[0]
                v = [rval(et) for _ in range(n)] if keep else _skip_array(f, et, n)
            elif t == 10:
                v = struct.unpack("<Q", f.read(8))[0]
            elif t == 11:
                v = struct.unpack("<q", f.read(8))[0]
            elif t == 12:
                v = struct.unpack("<d", f.read(8))[0]
            else:
                raise ValueError("kv type %d" % t)
            return v

        meta = {}
        for _ in range(n_kv):
            k = rstr()
            t = struct.unpack("<I", f.read(4))[0]
            keep = k in ("general.alignment",)
            meta[k] = rval(t, keep)
        tensors = []
        for _ in range(n_tensors):
            name = rstr()
            nd = struct.unpack("<I", f.read(4))[0]
            dims = [struct.unpack("<Q", f.read(8))[0] for _ in range(nd)]
            ttype = struct.unpack("<I", f.read(4))[0]
            off = struct.unpack("<Q", f.read(8))[0]
            tensors.append({"name": name, "type": ttype, "dims": dims, "offset": off})
        align = int(meta.get("general.alignment", 32) or 32)
        data_start = (f.tell() + align - 1) // align * align
    return meta, tensors, data_start


def _skip_array(f, et, n):
    size = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}.get(et)
    if size is not None:
        f.seek(size * n, 1)
        return None
    if et == 8:
        for _ in range(n):
            ln = struct.unpack("<Q", f.read(8))[0]
            f.seek(ln, 1)
        return None
    raise ValueError("unsupported array elem type %d" % et)


# ---------------------------------------------------------------------------
# ggml reference dequantisers (vectorised per block)
# ---------------------------------------------------------------------------
def _f16(b):
    return np.frombuffer(b, dtype=np.float16).astype(np.float32)


def dequant(type_id, raw, cols):
    blk, bytes_ = LAYOUT[type_id]
    nb = cols // blk
    out = np.zeros(cols, dtype=np.float32)
    if type_id == T_F32:
        return np.frombuffer(raw, dtype=np.float32).copy()
    if type_id == T_F16:
        return np.frombuffer(raw, dtype=np.float16).astype(np.float32)
    if type_id == T_BF16:
        u = np.frombuffer(raw, dtype=np.uint16).astype(np.uint32) << 16
        return u.view(np.float32).copy()
    if type_id == T_Q8_0:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(nb, 34)
        d = b[:, 0:2].copy().view(np.float16).astype(np.float32).reshape(nb)
        q = b[:, 2:34].copy().view(np.int8).astype(np.float32)
        return (d[:, None] * q).reshape(cols)
    if type_id == T_Q4_0:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(nb, 18)
        d = b[:, 0:2].copy().view(np.float16).astype(np.float32).reshape(nb)
        q = b[:, 2:18]
        lo = (q & 0x0F).astype(np.float32) - 8.0
        hi = (q >> 4).astype(np.float32) - 8.0
        y = np.empty((nb, 32), dtype=np.float32)
        y[:, :16] = lo
        y[:, 16:] = hi
        return (d[:, None] * y).reshape(cols)
    if type_id == T_Q4_1:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(nb, 20)
        d = b[:, 0:2].copy().view(np.float16).astype(np.float32).reshape(nb)
        m = b[:, 2:4].copy().view(np.float16).astype(np.float32).reshape(nb)
        q = b[:, 4:20]
        y = np.empty((nb, 32), dtype=np.float32)
        y[:, :16] = (q & 0x0F).astype(np.float32) * d[:, None] + m[:, None]
        y[:, 16:] = (q >> 4).astype(np.float32) * d[:, None] + m[:, None]
        return y.reshape(cols)
    if type_id in (T_Q5_0, T_Q5_1):
        b = np.frombuffer(raw, dtype=np.uint8).reshape(nb, bytes_)
        d = b[:, 0:2].copy().view(np.float16).astype(np.float32).reshape(nb)
        if type_id == T_Q5_0:
            qh = b[:, 2:6].copy().view(np.uint32).reshape(nb)
            q = b[:, 6:22]
            m = np.zeros(nb, dtype=np.float32)
        else:
            m = b[:, 2:4].copy().view(np.float16).astype(np.float32).reshape(nb)
            qh = b[:, 4:8].copy().view(np.uint32).reshape(nb)
            q = b[:, 8:24]
        y = np.empty((nb, 32), dtype=np.float32)
        for j in range(16):
            xh0 = ((qh >> j) << 4) & 0x10
            xh1 = (qh >> (j + 12)) & 0x10
            q0 = (q[:, j].astype(np.uint32) & 0x0F) | xh0
            q1 = (q[:, j].astype(np.uint32) >> 4) | xh1
            if type_id == T_Q5_0:
                y[:, j] = (q0.astype(np.float32) - 16.0) * d + m
                y[:, j + 16] = (q1.astype(np.float32) - 16.0) * d + m
            else:
                y[:, j] = q0.astype(np.float32) * d + m
                y[:, j + 16] = q1.astype(np.float32) * d + m
        return y.reshape(cols)
    if type_id == T_Q4_K:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(nb, 144)
        d = b[:, 0:2].copy().view(np.float16).astype(np.float32).reshape(nb)
        dmin = b[:, 2:4].copy().view(np.float16).astype(np.float32).reshape(nb)
        scales = b[:, 4:16]
        qs = b[:, 16:144]
        y = np.zeros((nb, 256), dtype=np.float32)
        for half in range(4):
            for sub in range(2):
                j = half * 2 + sub
                if j < 4:
                    sc = scales[:, j] & 63
                    mn = scales[:, j + 4] & 63
                else:
                    sc = (scales[:, j + 4] & 0x0F) | ((scales[:, j - 4] >> 6) << 4)
                    mn = (scales[:, j + 4] >> 4) | ((scales[:, j] >> 6) << 4)
                d1 = d * sc.astype(np.float32)
                m1 = dmin * mn.astype(np.float32)
                q = qs[:, half * 32:(half + 1) * 32]
                base = half * 64 + sub * 32
                if sub == 0:
                    vals = (q & 0x0F).astype(np.float32)
                else:
                    vals = (q >> 4).astype(np.float32)
                y[:, base:base + 32] = d1[:, None] * vals - m1[:, None]
        return y.reshape(cols)
    if type_id == T_Q5_K:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(nb, 176)
        d = b[:, 0:2].copy().view(np.float16).astype(np.float32).reshape(nb)
        dmin = b[:, 2:4].copy().view(np.float16).astype(np.float32).reshape(nb)
        scales = b[:, 4:16]
        qh = b[:, 16:48]   # 32 字节：qh[l] 的 bit(2g) / bit(2g+1) 是第 g 个 64 元素组的高位
        qs = b[:, 48:176]
        y = np.zeros((nb, 256), dtype=np.float32)
        for g in range(4):
            q = qs[:, g * 32:(g + 1) * 32]
            mask1 = 1 << (2 * g)
            mask2 = 1 << (2 * g + 1)
            for sub in range(2):
                j = g * 2 + sub
                if j < 4:
                    sc = scales[:, j] & 63
                    mn = scales[:, j + 4] & 63
                else:
                    sc = (scales[:, j + 4] & 0x0F) | ((scales[:, j - 4] >> 6) << 4)
                    mn = (scales[:, j + 4] >> 4) | ((scales[:, j] >> 6) << 4)
                d1 = d * sc.astype(np.float32)
                m1 = dmin * mn.astype(np.float32)
                mask = mask1 if sub == 0 else mask2
                bits = np.empty((32, nb), dtype=np.float32)
                for l in range(32):
                    bits[l] = np.where((qh[:, l].astype(np.uint32) & mask) != 0, 16.0, 0.0)
                if sub == 0:
                    vals = (q & 0x0F).astype(np.float32)
                else:
                    vals = (q >> 4).astype(np.float32)
                vals = vals + bits.T
                base = g * 64 + sub * 32
                y[:, base:base + 32] = d1[:, None] * vals - m1[:, None]
        return y.reshape(cols)
    if type_id == T_Q6_K:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(nb, 210)
        d = b[:, 208:210].copy().view(np.float16).astype(np.float32).reshape(nb)
        ql = b[:, 0:128]
        qh = b[:, 128:192]
        sc_all = b[:, 192:208].copy().view(np.int8).astype(np.float32)
        y = np.zeros((nb, 256), dtype=np.float32)
        for nb2 in range(2):
            ql2 = ql[:, nb2 * 64:(nb2 + 1) * 64]
            qh2 = qh[:, nb2 * 32:(nb2 + 1) * 32]
            sc = sc_all[:, nb2 * 8:(nb2 + 1) * 8]
            for l in range(32):
                is_ = l // 16
                q1 = ((ql2[:, l].astype(np.int32) & 0x0F) | (((qh2[:, l] >> 0) & 3) << 4)) - 32
                q2 = ((ql2[:, l + 32].astype(np.int32) & 0x0F) | (((qh2[:, l] >> 2) & 3) << 4)) - 32
                q3 = ((ql2[:, l].astype(np.int32) >> 4) | (((qh2[:, l] >> 4) & 3) << 4)) - 32
                q4 = ((ql2[:, l + 32].astype(np.int32) >> 4) | (((qh2[:, l] >> 6) & 3) << 4)) - 32
                base = nb2 * 128 + l
                y[:, base + 0] = d * sc[:, is_ + 0] * q1
                y[:, base + 32] = d * sc[:, is_ + 2] * q2
                y[:, base + 64] = d * sc[:, is_ + 4] * q3
                y[:, base + 96] = d * sc[:, is_ + 6] * q4
        return y.reshape(cols)
    raise ValueError("type %d" % type_id)


def check_model(exe, path, verbose=False):
    meta, tensors, data_start = read_gguf(path)
    with open(path, "rb") as f:
        f.seek(data_start)
        blob = f.read()
    by_type = {}
    for t in tensors:
        if t["type"] not in LAYOUT or t["type"] == T_F32:
            continue
        by_type.setdefault(t["type"], []).append(t)
    total = 0
    ok = 0
    for tid, ts in sorted(by_type.items()):
        for t in ts[:2]:
            cols = t["dims"][0]
            rows = t["dims"][1] if len(t["dims"]) > 1 else 1
            blk, bytes_ = LAYOUT[tid]
            row_bytes = (cols // blk) * bytes_
            for row in sorted(set([0, min(1, rows - 1)])):
                raw = blob[t["offset"] + row * row_bytes:
                           t["offset"] + row * row_bytes + row_bytes]
                ref = dequant(tid, raw, cols)
                p = subprocess.run([exe, "dumprow", path, t["name"], str(row)],
                                   capture_output=True)
                res = json.loads(p.stdout.decode("utf-8", "replace"))
                ours = np.asarray(res["values"], dtype=np.float32)
                diff = np.abs(ours - ref)
                tol = 2e-6 + 2e-6 * np.abs(ref)
                good = bool(np.all(diff <= tol))
                worst = float(np.max(diff / np.maximum(np.abs(ref), 1e-6)))
                total += 1
                if good:
                    ok += 1
                print("  [%s] %-32s %-5s row=%-3d n=%-4d max_rel=%.2e" %
                      ("PASS" if good else "FAIL", t["name"], TYPE_NAME[tid], row, cols, worst))
    print("[dequant] %s: %d/%d rows match reference" % (path, ok, total))
    return ok == total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--model", action="append", required=True)
    a = ap.parse_args()
    all_ok = True
    for m in a.model:
        all_ok = check_model(a.exe, m) and all_ok
    print("RESULT:", "PASS" if all_ok else "FAIL")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
