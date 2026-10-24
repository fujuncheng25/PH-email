#!/usr/bin/env python3
"""node-ai-verify-quant.py — Q4_K/Q6_K/Q8_0/F16/BF16 反量化的独立（numpy）对照工具。

用途：把 JS 引擎（source/electron/gguf.js）的反量化结果与 numpy 参考实现逐值比较，
定位量化解码 bug；并可用 --twin 生成“同一模型但全部张量为 F32”的孪生 GGUF，
交给 llama-server 作为 oracle 交叉验证（llama(F32 孪生) 与 llama(Q4_K 原模型) 的 logits
应几乎一致，说明 numpy 反量化正确；再与 JS 对比即可判定 JS 是否正确）。

用法：
  # 逐值比较（不需要 llama-server）
  python node-ai-verify-quant.py compare <model.gguf> [--tensors NAME1,NAME2] [--rows 0,1] [--count 16]

  # 生成 F32 孪生 GGUF（用于 llama-server oracle 交叉验证）
  python node-ai-verify-quant.py twin <model.gguf> <out.gguf>

参考实现直接对应 llama.cpp ggml-quants.c：
  dequantize_row_q4_K / dequantize_row_q6_K / dequantize_row_q8_0 / dequantize_row_q5_0 ...
"""
import argparse
import json
import os
import struct
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = r"C:\Users\splay\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
SELFTEST = os.path.join(HERE, "node-ai-selftest.js")

GGUF_MAGIC = b"GGUF"
T_U8, T_I8, T_U16, T_I16, T_U32, T_I32, T_F32, T_BOOL, T_STR, T_ARR, T_U64, T_I64, T_F64 = range(13)
GGML_F32, GGML_F16, GGML_Q4_0, GGML_Q4_1, GGML_Q5_0, GGML_Q5_1, GGML_Q8_0 = 0, 1, 2, 3, 6, 7, 8
GGML_Q4_K, GGML_Q5_K, GGML_Q6_K = 12, 13, 14
GGML_BF16 = 30

TYPE_INFO = {
    GGML_F32: ("F32", 1, 4), GGML_F16: ("F16", 1, 2), GGML_BF16: ("BF16", 1, 2),
    GGML_Q4_0: ("Q4_0", 32, 18), GGML_Q4_1: ("Q4_1", 32, 20),
    GGML_Q5_0: ("Q5_0", 32, 22), GGML_Q5_1: ("Q5_1", 32, 24),
    GGML_Q8_0: ("Q8_0", 32, 34), GGML_Q4_K: ("Q4_K", 256, 144),
    GGML_Q5_K: ("Q5_K", 256, 176), GGML_Q6_K: ("Q6_K", 256, 210),
}


# ---------------------------------------------------------------- GGUF 读
def read_gguf(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != GGUF_MAGIC:
        raise SystemExit("not a GGUF file: " + path)
    pos = 4

    def u32():
        nonlocal pos
        v = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        return v

    def u64():
        nonlocal pos
        v = struct.unpack_from("<Q", data, pos)[0]
        pos += 8
        return v

    def rstr():
        nonlocal pos
        n = u64()
        s = data[pos:pos + n]
        pos += n
        return s.decode("utf-8", "surrogateescape")

    def rval(t):
        nonlocal pos
        fmt = {T_U8: "<B", T_I8: "<b", T_U16: "<H", T_I16: "<h", T_U32: "<I", T_I32: "<i",
               T_F32: "<f", T_BOOL: "<?", T_U64: "<Q", T_I64: "<q", T_F64: "<d"}.get(t)
        if t == T_STR:
            return rstr()
        if t == T_ARR:
            et = u32()
            n = u64()
            return [rval(et) for _ in range(n)]
        if fmt is None:
            raise ValueError("bad kv type %d" % t)
        sz = struct.calcsize(fmt)
        v = struct.unpack_from(fmt, data, pos)[0]
        pos += sz
        return v

    version = u32()
    n_tensors = u64()
    n_kv = u64()
    meta = {}
    meta_types = {}
    meta_elem_types = {}
    for _ in range(n_kv):
        k = rstr()
        t = u32()
        if t == T_ARR:
            et = u32()
            n = u64()
            meta_elem_types[k] = et
            meta[k] = [rval(et) for _ in range(n)]
        else:
            meta[k] = rval(t)
        meta_types[k] = t
    tensors = []
    for _ in range(n_tensors):
        name = rstr()
        nd = u32()
        dims = [u64() for _ in range(nd)]
        ttype = u32()
        off = u64()
        tensors.append({"name": name, "dims": dims, "type": ttype, "offset": off})
    alignment = int(meta.get("general.alignment", 32) or 32)
    data_start = (pos + alignment - 1) // alignment * alignment
    for t in tensors:
        info = TYPE_INFO[t["type"]]
        t["block"], t["block_bytes"] = info[1], info[2]
        elems = int(np.prod(t["dims"])) if t["dims"] else 1
        t["elems"] = elems
        t["nbytes"] = elems // t["block"] * t["block_bytes"]
        t["rowLen"] = t["dims"][0] if t["dims"] else 1
        t["rows"] = elems // t["rowLen"] if t["dims"] else 1
        t["abs"] = data_start + t["offset"]
    return {"data": data, "meta": meta, "meta_types": meta_types,
            "meta_elem_types": meta_elem_types, "tensors": tensors, "version": version,
            "alignment": alignment, "data_start": data_start}


# ---------------------------------------------------------------- 反量化（llama.cpp 参考）
def get_scale_min_k4(scales, j):
    if j < 4:
        return int(scales[j]) & 63, int(scales[j + 4]) & 63
    d = (int(scales[j + 4]) & 0xF) | ((int(scales[j - 4]) >> 6) << 4)
    m = (int(scales[j + 4]) >> 4) | ((int(scales[j - 4]) >> 6) << 4)
    return d, m


def half_to_float(h):
    return float(np.frombuffer(np.uint16(h).tobytes(), dtype="<f2")[0])


def dequant_row(buf, abs_off, ttype, row_len):
    y = np.zeros(row_len, dtype=np.float32)
    if ttype == GGML_F32:
        return np.frombuffer(buf, dtype="<f4", count=row_len, offset=abs_off).copy()
    if ttype == GGML_F16:
        return np.frombuffer(buf, dtype="<f2", count=row_len, offset=abs_off).astype(np.float32)
    if ttype == GGML_BF16:
        u = np.frombuffer(buf, dtype="<u2", count=row_len, offset=abs_off).astype(np.uint32)
        return (u << 16).view(np.float32)
    if ttype == GGML_Q8_0:
        o = abs_off
        for b in range(0, row_len, 32):
            d = half_to_float(struct.unpack_from("<H", buf, o)[0])
            q = np.frombuffer(buf, dtype=np.int8, count=32, offset=o + 2).astype(np.float32)
            y[b:b + 32] = d * q
            o += 34
        return y
    if ttype == GGML_Q4_0:
        o = abs_off
        for b in range(0, row_len, 32):
            d = half_to_float(struct.unpack_from("<H", buf, o)[0])
            qs = np.frombuffer(buf, dtype=np.uint8, count=16, offset=o + 2)
            y[b:b + 16] = d * ((qs & 0xF).astype(np.float32) - 8)
            y[b + 16:b + 32] = d * ((qs >> 4).astype(np.float32) - 8)
            o += 18
        return y
    if ttype == GGML_Q4_K:
        o = abs_off
        for b in range(0, row_len, 256):
            d = half_to_float(struct.unpack_from("<H", buf, o)[0])
            dmin = half_to_float(struct.unpack_from("<H", buf, o + 2)[0])
            scales = np.frombuffer(buf, dtype=np.uint8, count=12, offset=o + 4)
            qs = np.frombuffer(buf, dtype=np.uint8, count=128, offset=o + 16)
            qoff = 0
            is_ = 0
            for j in range(0, 256, 64):
                sc, m = get_scale_min_k4(scales, is_)
                d1, m1 = d * sc, dmin * m
                sc, m = get_scale_min_k4(scales, is_ + 1)
                d2, m2 = d * sc, dmin * m
                y[b + j:b + j + 32] = d1 * (qs[qoff:qoff + 32] & 0xF).astype(np.float32) - m1
                y[b + j + 32:b + j + 64] = d2 * (qs[qoff:qoff + 32] >> 4).astype(np.float32) - m2
                qoff += 32
                is_ += 2
            o += 144
        return y
    if ttype == GGML_Q6_K:
        o = abs_off
        for b in range(0, row_len, 256):
            ql = np.frombuffer(buf, dtype=np.uint8, count=128, offset=o)
            qh = np.frombuffer(buf, dtype=np.uint8, count=64, offset=o + 128)
            sc = np.frombuffer(buf, dtype=np.int8, count=16, offset=o + 192)
            d = half_to_float(struct.unpack_from("<H", buf, o + 208)[0])
            for n in (0, 128):
                qlb = (n // 128) * 64
                qhb = (n // 128) * 32
                scb = (n // 128) * 8
                for l in range(32):
                    is_ = l // 16
                    q1 = ((int(ql[qlb + l]) & 0xF) | (((int(qh[qhb + l]) >> 0) & 3) << 4)) - 32
                    q2 = ((int(ql[qlb + l + 32]) & 0xF) | (((int(qh[qhb + l]) >> 2) & 3) << 4)) - 32
                    q3 = ((int(ql[qlb + l]) >> 4) | (((int(qh[qhb + l]) >> 4) & 3) << 4)) - 32
                    q4 = ((int(ql[qlb + l + 32]) >> 4) | (((int(qh[qhb + l]) >> 6) & 3) << 4)) - 32
                    y[b + n + l] = d * int(sc[scb + is_]) * q1
                    y[b + n + l + 32] = d * int(sc[scb + is_ + 2]) * q2
                    y[b + n + l + 64] = d * int(sc[scb + is_ + 4]) * q3
                    y[b + n + l + 96] = d * int(sc[scb + is_ + 6]) * q4
            o += 210
        return y
    raise SystemExit("unsupported type %d" % ttype)


# ---------------------------------------------------------------- 写 GGUF（F32 孪生）
def enc_str(s):
    b = s.encode("utf-8", "surrogateescape") if isinstance(s, str) else s
    return struct.pack("<Q", len(b)) + b


def enc_kv(key, val, typ, elem_type=None):
    """按原始 GGUF 类型写回 KV（类型必须一致，否则 llama.cpp 拒绝加载）。"""
    def enc_val():
        if typ == T_BOOL:
            return struct.pack("<?", bool(val))
        if typ in (T_U8, T_I8):
            return struct.pack("<B" if typ == T_U8 else "<b", int(val))
        if typ in (T_U16, T_I16):
            return struct.pack("<H" if typ == T_U16 else "<h", int(val))
        if typ in (T_U32, T_I32):
            return struct.pack("<I" if typ == T_U32 else "<i", int(val))
        if typ in (T_U64, T_I64):
            return struct.pack("<Q" if typ == T_U64 else "<q", int(val))
        if typ == T_F32:
            return struct.pack("<f", float(val))
        if typ == T_F64:
            return struct.pack("<d", float(val))
        if typ == T_STR:
            return enc_str(val)
        if typ == T_ARR:
            et = elem_type
            out = struct.pack("<I", et) + struct.pack("<Q", len(val))
            for it in val:
                if et == T_STR:
                    out += enc_str(it)
                elif et in (T_I32, T_U32):
                    out += struct.pack("<i" if et == T_I32 else "<I", int(it))
                elif et in (T_U8, T_I8):
                    out += struct.pack("<B" if et == T_U8 else "<b", int(it))
                elif et in (T_I16, T_U16):
                    out += struct.pack("<h" if et == T_I16 else "<H", int(it))
                else:
                    raise ValueError("unsupported array elem type %r" % et)
            return out
        raise ValueError("unsupported kv type %r for %s" % (typ, key))

    return enc_str(key) + struct.pack("<I", typ) + enc_val()


def write_twin(src_path, out_path):
    g = read_gguf(src_path)
    data = g["data"]
    alignment = g["alignment"]
    # 反量化所有张量
    tensors = []
    for t in g["tensors"]:
        arr = np.zeros(t["elems"], dtype=np.float32)
        row_bytes = t["rowLen"] // t["block"] * t["block_bytes"]
        for r in range(t["rows"]):
            arr[r * t["rowLen"]:(r + 1) * t["rowLen"]] = dequant_row(
                data, t["abs"] + r * row_bytes, t["type"], t["rowLen"])
        tensors.append({"name": t["name"], "dims": t["dims"], "data": arr.tobytes()})

    hdr = bytearray(GGUF_MAGIC + struct.pack("<I", 3))
    hdr += struct.pack("<Q", len(tensors)) + struct.pack("<Q", len(g["meta"]))
    for k, v in g["meta"].items():
        hdr += enc_kv(k, v, g["meta_types"][k], g["meta_elem_types"].get(k))
    infos = bytearray()
    offset = 0
    for t in tensors:
        offset = (offset + alignment - 1) // alignment * alignment
        t["offset"] = offset
        offset += len(t["data"])
        infos += enc_str(t["name"])
        infos += struct.pack("<I", len(t["dims"]))
        for d in t["dims"]:
            infos += struct.pack("<Q", d)
        infos += struct.pack("<I", GGML_F32) + struct.pack("<Q", t["offset"])
    pad = (alignment - (len(hdr) + len(infos)) % alignment) % alignment
    with open(out_path, "wb") as f:
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
    print("wrote", out_path, "%.1f MB" % (os.path.getsize(out_path) / 1e6))
    return out_path


# ---------------------------------------------------------------- 与 JS 对比
def js_dequant_row(model, tensor, row, count):
    r = subprocess.run(
        [NODE, SELFTEST, "dequant", model, tensor, str(row), str(count)],
        capture_output=True, text=True, encoding="utf-8")
    out = r.stdout.strip()
    if r.returncode != 0 or not out:
        raise SystemExit("node selftest failed: " + (r.stderr or r.stdout))
    return json.loads(out)


def cmd_compare(args):
    g = read_gguf(args.model)
    tmap = {t["name"]: t for t in g["tensors"]}
    if args.tensors:
        names = [s.strip() for s in args.tensors.split(",") if s.strip()]
    else:
        # 选每类第一个张量
        seen = set()
        names = []
        for t in g["tensors"]:
            if t["type"] not in seen:
                seen.add(t["type"])
                names.append(t["name"])
    rows = [int(x) for x in args.rows.split(",")] if args.rows else [0]
    count = args.count
    report = []
    all_ok = True
    for name in names:
        t = tmap.get(name)
        if t is None:
            report.append({"tensor": name, "ok": False, "error": "not found"})
            all_ok = False
            continue
        info = TYPE_INFO[t["type"]]
        row_bytes = t["rowLen"] // t["block"] * t["block_bytes"]
        for row in rows:
            if row >= t["rows"]:
                continue
            ref = dequant_row(g["data"], t["abs"] + row * row_bytes, t["type"], t["rowLen"])
            js = js_dequant_row(args.model, name, row, min(count, t["rowLen"]))
            js_vals = np.array(js["values"], dtype=np.float64)
            ref_vals = ref[:len(js_vals)].astype(np.float64)
            diff = np.abs(js_vals - ref_vals)
            denom = np.maximum(np.abs(ref_vals), 1e-8)
            rel = diff / denom
            ok = bool(diff.max() <= 1e-6 or rel.max() <= 1e-5) if len(diff) else True
            all_ok = all_ok and ok
            report.append({
                "tensor": name, "type": info[0], "row": row, "count": len(js_vals),
                "ok": ok, "max_abs_diff": float(diff.max()) if len(diff) else 0.0,
                "max_rel_diff": float(rel.max()) if len(diff) else 0.0,
                "js_head": js_vals[:4].tolist(), "ref_head": ref_vals[:4].tolist(),
            })
            print(("PASS " if ok else "FAIL ") + "%s [%s] row=%d max_abs=%.3e max_rel=%.3e" % (
                name, info[0], row,
                report[-1]["max_abs_diff"], report[-1]["max_rel_diff"]))
            if not ok:
                print("   js ", js_vals[:8].tolist())
                print("   ref", ref_vals[:8].tolist())
    print("\n%s" % ("ALL OK" if all_ok else "MISMATCH FOUND"))
    print(json.dumps({"ok": all_ok, "results": report}))
    return 0 if all_ok else 1


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("compare")
    c.add_argument("model")
    c.add_argument("--tensors", default="")
    c.add_argument("--rows", default="")
    c.add_argument("--count", type=int, default=16)
    tw = sub.add_parser("twin")
    tw.add_argument("model")
    tw.add_argument("out")
    a = ap.parse_args()
    if a.cmd == "compare":
        sys.exit(cmd_compare(a))
    if a.cmd == "twin":
        write_twin(a.model, a.out)


if __name__ == "__main__":
    main()
