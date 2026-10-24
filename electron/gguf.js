'use strict';
/**
 * Email Chatter 2.0 — 纯 JS 的 GGUF v2/v3 解析 + Qwen2 tokenizer/前向推理引擎。
 *
 * 无第三方依赖（只用 Buffer/Float32Array 等内置能力）。为 Node worker 线程设计：
 *  - parseGGUF()/loadModel() 一次把整个模型文件读入内存（Buffer），张量保持量化格式；
 *  - 前向推理时按行按块即时反量化（Q4_K/Q6_K/Q8_0/F16/BF16/F32），内存占用 ≈ 模型文件大小；
 *  - 支持 Qwen2 结构：RMSNorm / QKV+bias / RoPE / GQA / KV cache / SwiGLU / lm_head（tied 输出兼容）。
 *
 * 主要导出：
 *   parseGGUF(source) -> gguf 对象
 *   loadModel(filePath, opts) -> { gguf, tokenizer, model }
 *   Tokenizer, Qwen2Model
 *   buildPrompt(text), postProcessTitle(raw, text), truncateChars(text, n)
 *   TENSOR_TYPE / TYPE_INFO
 */
const fs = require('fs');

// ============================================================ 常量 / 张量类型

const GGUF_MAGIC = 0x46554747; // 'GGUF' 以小端 u32 读

const TENSOR_TYPE = {
  F32: 0, F16: 1, Q4_0: 2, Q4_1: 3, Q5_0: 6, Q5_1: 7, Q8_0: 8, Q8_1: 9,
  Q2_K: 10, Q3_K: 11, Q4_K: 12, Q5_K: 13, Q6_K: 14, Q8_K: 15,
  IQ2_XXS: 16, IQ2_XS: 17, IQ3_XXS: 18, IQ1_S: 19, IQ4_NL: 20, IQ3_S: 21,
  IQ2_S: 22, IQ4_XS: 23, I8: 24, I16: 25, I32: 26, I64: 27, F64: 28,
  IQ1_M: 29, BF16: 30, TQ1_0: 34, TQ2_0: 35,
};

/** block=一个量化块包含的元素数；bytes=该块字节数。 */
const TYPE_INFO = {
  [TENSOR_TYPE.F32]: { name: 'F32', block: 1, bytes: 4 },
  [TENSOR_TYPE.F16]: { name: 'F16', block: 1, bytes: 2 },
  [TENSOR_TYPE.Q4_0]: { name: 'Q4_0', block: 32, bytes: 18 },
  [TENSOR_TYPE.Q4_1]: { name: 'Q4_1', block: 32, bytes: 20 },
  [TENSOR_TYPE.Q5_0]: { name: 'Q5_0', block: 32, bytes: 22 },
  [TENSOR_TYPE.Q5_1]: { name: 'Q5_1', block: 32, bytes: 24 },
  [TENSOR_TYPE.Q8_0]: { name: 'Q8_0', block: 32, bytes: 34 },
  [TENSOR_TYPE.Q4_K]: { name: 'Q4_K', block: 256, bytes: 144 },
  [TENSOR_TYPE.Q5_K]: { name: 'Q5_K', block: 256, bytes: 176 },
  [TENSOR_TYPE.Q6_K]: { name: 'Q6_K', block: 256, bytes: 210 },
  [TENSOR_TYPE.BF16]: { name: 'BF16', block: 1, bytes: 2 },
};

const QT = {
  F32: 0, F16: 1, Q4_0: 2, Q4_1: 3, Q5_0: 6, Q5_1: 7, Q8_0: 8,
  Q4_K: 12, Q5_K: 13, Q6_K: 14, BF16: 30,
};

// ============================================================ f16 -> f32 查表

const F16_TABLE = new Float32Array(65536);
(function buildF16Table() {
  const conv = new ArrayBuffer(4);
  const f32 = new Float32Array(conv);
  const u32 = new Uint32Array(conv);
  for (let i = 0; i < 65536; i++) {
    const s = (i & 0x8000) ? -1 : 1;
    const e = (i >> 10) & 0x1f;
    const m = i & 0x3ff;
    let v;
    if (e === 0) v = s * Math.pow(2, -14) * (m / 1024);
    else if (e === 0x1f) v = m ? NaN : s * Infinity;
    else v = s * Math.pow(2, e - 15) * (1 + m / 1024);
    f32[0] = v; // 转成 float32，保证与 GGML_FP16_TO_FP32 一致
    F16_TABLE[i] = f32[0];
  }
})();

const CONV_BUF = new ArrayBuffer(4);
const CONV_F32 = new Float32Array(CONV_BUF);
const CONV_U32 = new Uint32Array(CONV_BUF);
function f32FromBits(u32) {
  CONV_U32[0] = u32 >>> 0;
  return CONV_F32[0];
}
function f16At(u8, off) {
  return F16_TABLE[u8[off] | (u8[off + 1] << 8)];
}

// ============================================================ Reader

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this.u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  }
  seek(p) { this.pos = p; }
  u8v() { return this.u8[this.pos++]; }
  i8v() { const v = this.u8[this.pos++]; return v < 128 ? v : v - 256; }
  u16() { const p = this.pos; this.pos += 2; return this.u8[p] | (this.u8[p + 1] << 8); }
  i16() { const v = this.u16(); return v < 32768 ? v : v - 65536; }
  u32() {
    const p = this.pos; this.pos += 4;
    return (this.u8[p] | (this.u8[p + 1] << 8) | (this.u8[p + 2] << 16) | (this.u8[p + 3] << 24)) >>> 0;
  }
  i32() { return this.u32() | 0; }
  u64() {
    const p = this.pos; this.pos += 8;
    const lo = (this.u8[p] | (this.u8[p + 1] << 8) | (this.u8[p + 2] << 16) | (this.u8[p + 3] << 24)) >>> 0;
    const hi = (this.u8[p + 4] | (this.u8[p + 5] << 8) | (this.u8[p + 6] << 16) | (this.u8[p + 7] << 24)) >>> 0;
    const v = hi * 4294967296 + lo;
    if (!Number.isSafeInteger(v)) throw new Error('GGUF: u64 超出安全整数范围');
    return v;
  }
  i64() {
    // 仅元数据使用；负值极少见（这里按补码处理）
    const p = this.pos;
    const v = this.u64();
    const signed = v >= 9223372036854775808;
    return signed ? v - 18446744073709551616 : v;
  }
  f32() {
    const p = this.pos; this.pos += 4;
    CONV_U32[0] = (this.u8[p] | (this.u8[p + 1] << 8) | (this.u8[p + 2] << 16) | (this.u8[p + 3] << 24)) >>> 0;
    return CONV_F32[0];
  }
  f64() {
    const p = this.pos; this.pos += 8;
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + p, 8);
    return dv.getFloat64(0, true);
  }
  string() {
    const n = this.u64();
    const p = this.pos;
    if (p + n > this.buf.length) throw new Error('GGUF: 字符串越界');
    this.pos = p + n;
    return this.buf.toString('utf8', p, p + n);
  }
  bytes(n) {
    const p = this.pos;
    if (p + n > this.buf.length) throw new Error('GGUF: 数据越界');
    this.pos = p + n;
    return this.buf.subarray(p, p + n);
  }
}

// GGUF 元数据值类型
const GGUF_META = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6,
  BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
};

function readMetaValue(r, type) {
  switch (type) {
    case GGUF_META.UINT8: return r.u8v();
    case GGUF_META.INT8: return r.i8v();
    case GGUF_META.UINT16: return r.u16();
    case GGUF_META.INT16: return r.i16();
    case GGUF_META.UINT32: return r.u32();
    case GGUF_META.INT32: return r.i32();
    case GGUF_META.FLOAT32: return r.f32();
    case GGUF_META.BOOL: return r.u8v() !== 0;
    case GGUF_META.STRING: return r.string();
    case GGUF_META.UINT64: return r.u64();
    case GGUF_META.INT64: return r.i64();
    case GGUF_META.FLOAT64: return r.f64();
    case GGUF_META.ARRAY: {
      const et = r.u32();
      const n = r.u64();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readMetaValue(r, et);
      return out;
    }
    default:
      throw new Error('GGUF: 未知元数据类型 ' + type);
  }
}

function alignUp(n, a) { return Math.ceil(n / a) * a; }

/**
 * 解析 GGUF（v2/v3）。
 * @param {Buffer} buf 整个文件内容
 * @returns {{buffer:Buffer, version:number, metadata:Object, tensors:Array, tensorMap:Map,
 *            alignment:number, dataStart:number, tensorCount:number, size:number}}
 */
function parseGGUF(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('parseGGUF 需要 Buffer');
  if (buf.length < 24) throw new Error('GGUF 文件过小');
  const r = new Reader(buf);
  const magic = r.u32();
  if (magic !== GGUF_MAGIC) {
    throw new Error('不是 GGUF 文件（magic=' + magic.toString(16) + '）');
  }
  const version = r.u32();
  if (version < 2 || version > 3) throw new Error('不支持的 GGUF 版本 ' + version + '（仅支持 v2/v3）');
  const tensorCount = r.u64();
  const kvCount = r.u64();
  const metadata = Object.create(null);
  for (let i = 0; i < kvCount; i++) {
    const key = r.string();
    const type = r.u32();
    metadata[key] = readMetaValue(r, type);
  }
  const alignment = Math.max(1, (metadata['general.alignment'] | 0) || 32);

  const tensors = new Array(tensorCount);
  const tensorMap = new Map();
  for (let i = 0; i < tensorCount; i++) {
    const name = r.string();
    const nDims = r.u32();
    const dims = new Array(nDims);
    let elems = 1;
    for (let d = 0; d < nDims; d++) { dims[d] = r.u64(); elems *= dims[d]; }
    const type = r.u32();
    const offset = r.u64();
    const info = TYPE_INFO[type];
    if (!info) throw new Error('不支持的张量类型 ' + type + '（张量 ' + name + '）');
    if (elems % info.block !== 0) {
      throw new Error('张量 ' + name + ' 元素数 ' + elems + ' 不是块大小 ' + info.block + ' 的整数倍');
    }
    const nbytes = (elems / info.block) * info.bytes;
    if (nDims > 0 && dims[0] % info.block !== 0) {
      // ggml 要求 ne[0] 是块大小的整数倍，否则无法按行反量化
      throw new Error('张量 ' + name + ' 的 ne[0]=' + dims[0] + ' 不是块大小 ' + info.block + ' 的整数倍');
    }
    const rowLen = nDims > 0 ? dims[0] : 1;
    const rows = nDims > 1 ? elems / rowLen : 1;
    const t = {
      name, dims, type, offset, nbytes, elems, rowLen, rows,
      dataOffset: 0, // 由下面的 dataStart 填充
      typeName: info.name,
      block: info.block,
      blockBytes: info.bytes,
    };
    tensors[i] = t;
    tensorMap.set(name, t);
  }
  // 数据区在 tensor info 之后按 general.alignment 对齐（必须先读完所有 tensor info！）
  const dataStart = alignUp(r.pos, alignment);
  for (const t of tensors) {
    t.dataOffset = dataStart + t.offset;
    if (t.dataOffset + t.nbytes > buf.length) {
      throw new Error('张量 ' + t.name + ' 数据越界（offset=' + t.offset + ', nbytes=' + t.nbytes + '）');
    }
  }
  return { buffer: buf, version, metadata, tensors, tensorMap, alignment, dataStart, tensorCount, size: buf.length };
}

function parseGGUFFile(filePath) {
  const st = fs.statSync(filePath);
  const buf = fs.readFileSync(filePath);
  if (buf.length !== st.size) throw new Error('模型文件读取不完整');
  const gguf = parseGGUF(buf);
  gguf.filePath = filePath;
  return gguf;
}

// ============================================================ 视图 & 反量化

function makeViews(buf) {
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  const i8 = new Int8Array(buf.buffer, buf.byteOffset, buf.length);
  let f32 = null;
  if ((buf.byteOffset & 3) === 0) {
    f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  }
  return { buf, u8, i8, f32 };
}

/** Q4_K 的 6-bit 比例/最小值解包（arr 为整个文件的 u8，base 为 scales[12] 起始偏移，j=0..7） */
function getScaleMinK4(arr, base, j) {
  if (j < 4) return [arr[base + j] & 63, arr[base + j + 4] & 63];
  return [
    (arr[base + j + 4] & 0xf) | ((arr[base + j - 4] >> 6) << 4),
    (arr[base + j + 4] >> 4) | ((arr[base + j - 4] >> 6) << 4),
  ];
}

/**
 * 把一行（rowLen 个元素）反量化到 out（Float32Array，长度 >= rowLen）。
 * base = 该行第一个字节的绝对偏移。
 */
function dequantRow(views, type, base, rowLen, out) {
  const u8 = views.u8;
  switch (type) {
    case QT.F32: {
      if (views.f32 && (base & 3) === 0) {
        const s = base >> 2;
        const f = views.f32;
        for (let j = 0; j < rowLen; j++) out[j] = f[s + j];
      } else {
        const p = views.buf.byteOffset + base;
        const dv = new DataView(views.buf.buffer);
        for (let j = 0; j < rowLen; j++) out[j] = dv.getFloat32(p + j * 4, true);
      }
      return;
    }
    case QT.F16: {
      let o = base;
      for (let j = 0; j < rowLen; j++, o += 2) out[j] = F16_TABLE[u8[o] | (u8[o + 1] << 8)];
      return;
    }
    case QT.BF16: {
      let o = base;
      for (let j = 0; j < rowLen; j++, o += 2) out[j] = f32FromBits(((u8[o] | (u8[o + 1] << 8)) << 16) >>> 0);
      return;
    }
    case QT.Q8_0: {
      const i8 = views.i8;
      let o = base;
      for (let b = 0; b < rowLen; b += 32) {
        const d = F16_TABLE[u8[o] | (u8[o + 1] << 8)];
        const qo = o + 2;
        for (let j = 0; j < 32; j++) out[b + j] = d * i8[qo + j];
        o += 34;
      }
      return;
    }
    case QT.Q4_0: {
      let o = base;
      for (let b = 0; b < rowLen; b += 32) {
        const d = F16_TABLE[u8[o] | (u8[o + 1] << 8)];
        const qo = o + 2;
        for (let j = 0; j < 16; j++) {
          out[b + j] = d * ((u8[qo + j] & 0xf) - 8);
          out[b + j + 16] = d * ((u8[qo + j] >> 4) - 8);
        }
        o += 18;
      }
      return;
    }
    case QT.Q4_1: {
      let o = base;
      for (let b = 0; b < rowLen; b += 32) {
        const d = F16_TABLE[u8[o] | (u8[o + 1] << 8)];
        const m = F16_TABLE[u8[o + 2] | (u8[o + 3] << 8)];
        const qo = o + 4;
        for (let j = 0; j < 16; j++) {
          out[b + j] = d * (u8[qo + j] & 0xf) + m;
          out[b + j + 16] = d * (u8[qo + j] >> 4) + m;
        }
        o += 20;
      }
      return;
    }
    case QT.Q5_0: {
      const qh = (o16) => u8[o16] | (u8[o16 + 1] << 8) | (u8[o16 + 2] << 16) | (u8[o16 + 3] << 24);
      let o = base;
      for (let b = 0; b < rowLen; b += 32) {
        const d = F16_TABLE[u8[o] | (u8[o + 1] << 8)];
        const qhv = qh(o + 2) >>> 0;
        const qo = o + 6;
        for (let j = 0; j < 16; j++) {
          const xh0 = ((qhv >> j) << 4) & 0x10;
          const xh1 = (qhv >> (j + 12)) & 0x10;
          out[b + j] = d * (((u8[qo + j] & 0xf) | xh0) - 16);
          out[b + j + 16] = d * (((u8[qo + j] >> 4) | xh1) - 16);
        }
        o += 22;
      }
      return;
    }
    case QT.Q5_1: {
      const qh = (o16) => u8[o16] | (u8[o16 + 1] << 8) | (u8[o16 + 2] << 16) | (u8[o16 + 3] << 24);
      let o = base;
      for (let b = 0; b < rowLen; b += 32) {
        const d = F16_TABLE[u8[o] | (u8[o + 1] << 8)];
        const m = F16_TABLE[u8[o + 2] | (u8[o + 3] << 8)];
        const qhv = qh(o + 4) >>> 0;
        const qo = o + 8;
        for (let j = 0; j < 16; j++) {
          const xh0 = ((qhv >> j) << 4) & 0x10;
          const xh1 = (qhv >> (j + 12)) & 0x10;
          out[b + j] = d * (((u8[qo + j] & 0xf) | xh0) - 16) + m;
          out[b + j + 16] = d * (((u8[qo + j] >> 4) | xh1) - 16) + m;
        }
        o += 24;
      }
      return;
    }
    case QT.Q4_K: {
      let o = base;
      for (let b = 0; b < rowLen; b += 256) {
        const d = F16_TABLE[u8[o] | (u8[o + 1] << 8)];
        const dmin = F16_TABLE[u8[o + 2] | (u8[o + 3] << 8)];
        const sc = o + 4;            // scales[12]
        let q = o + 16;              // qs[128]
        let is = 0;
        for (let j = 0; j < 256; j += 64) {
          const s0 = getScaleMinK4(u8, sc, is);
          const s1 = getScaleMinK4(u8, sc, is + 1);
          const d1 = d * s0[0], m1 = dmin * s0[1];
          const d2 = d * s1[0], m2 = dmin * s1[1];
          for (let l = 0; l < 32; l++) out[b + j + l] = d1 * (u8[q + l] & 0xf) - m1;
          for (let l = 0; l < 32; l++) out[b + j + 32 + l] = d2 * (u8[q + l] >> 4) - m2;
          q += 32;
          is += 2;
        }
        o += 144;
      }
      return;
    }
    case QT.Q6_K: {
      const i8 = views.i8;
      let o = base;
      for (let b = 0; b < rowLen; b += 256) {
        const ql = o;              // 128
        const qh = o + 128;        // 64
        const sc = o + 192;        // 16 (int8)
        const d = F16_TABLE[u8[o + 208] | (u8[o + 209] << 8)];
        for (let n = 0; n < 256; n += 128) {
          const scBase = sc + (n >> 7) * 8;
          const qlBase = ql + (n >> 7) * 64;   // 每 128 个元素 ql 前进 64 字节
          const qhBase = qh + (n >> 7) * 32;   // qh 前进 32 字节
          const outBase = b + n;
          for (let l = 0; l < 32; l++) {
            const is = l >> 4;
            const q1 = ((u8[qlBase + l] & 0xf) | (((u8[qhBase + l] >> 0) & 3) << 4)) - 32;
            const q2 = ((u8[qlBase + l + 32] & 0xf) | (((u8[qhBase + l] >> 2) & 3) << 4)) - 32;
            const q3 = ((u8[qlBase + l] >> 4) | (((u8[qhBase + l] >> 4) & 3) << 4)) - 32;
            const q4 = ((u8[qlBase + l + 32] >> 4) | (((u8[qhBase + l] >> 6) & 3) << 4)) - 32;
            out[outBase + l] = d * i8[scBase + is] * q1;
            out[outBase + l + 32] = d * i8[scBase + is + 2] * q2;
            out[outBase + l + 64] = d * i8[scBase + is + 4] * q3;
            out[outBase + l + 96] = d * i8[scBase + is + 6] * q4;
          }
        }
        o += 210;
      }
      return;
    }
    default:
      throw new Error('dequantRow 不支持的张量类型 ' + type);
  }
}

/** 点积（4 路展开，对 V8 友好） */
function dot(a, b, n) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  let i = 0;
  const end = n - 3;
  for (; i < end; i += 4) {
    s0 += a[i] * b[i];
    s1 += a[i + 1] * b[i + 1];
    s2 += a[i + 2] * b[i + 2];
    s3 += a[i + 3] * b[i + 3];
  }
  let s = (s0 + s1) + (s2 + s3);
  for (; i < n; i++) s += a[i] * b[i];
  return s;
}

/** 从 a[off] 开始的点积（避免 subarray 分配） */
function dotAt(a, off, b, n) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  let i = 0;
  const end = n - 3;
  for (; i < end; i += 4) {
    s0 += a[off + i] * b[i];
    s1 += a[off + i + 1] * b[i + 1];
    s2 += a[off + i + 2] * b[i + 2];
    s3 += a[off + i + 3] * b[i + 3];
  }
  let s = (s0 + s1) + (s2 + s3);
  for (; i < n; i++) s += a[off + i] * b[i];
  return s;
}

/**
 * y[r] = Σ_c W[r*rowLen + c] * x[c]，W 为量化张量（按行反量化到 scratch）。
 * out 长度 >= rows。
 */
function matVec(views, t, x, out, scratch) {
  const rows = t.rows;
  const rowLen = t.rowLen;
  const type = t.type;
  const base = t.dataOffset;
  switch (type) {
    case QT.F32: {
      const f = views.f32;
      if (f && (base & 3) === 0) {
        let s = base >> 2;
        for (let r = 0; r < rows; r++, s += rowLen) out[r] = dotAt(f, s, x, rowLen);
      } else {
        const scratch2 = scratch;
        const rowBytes = rowLen * 4;
        for (let r = 0; r < rows; r++) {
          dequantRow(views, type, base + r * rowBytes, rowLen, scratch2);
          out[r] = dot(scratch2, x, rowLen);
        }
      }
      return;
    }
    case QT.Q8_0: {
      const u8 = views.u8;
      const i8 = views.i8;
      const blocks = rowLen / 32;
      let o = base;
      for (let r = 0; r < rows; r++) {
        let total = 0;
        let bo = o;
        for (let b = 0; b < blocks; b++) {
          const d = F16_TABLE[u8[bo] | (u8[bo + 1] << 8)];
          const qo = bo + 2;
          let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
          let xo = b * 32;
          for (let j = 0; j < 32; j += 4) {
            s0 += i8[qo + j] * x[xo + j];
            s1 += i8[qo + j + 1] * x[xo + j + 1];
            s2 += i8[qo + j + 2] * x[xo + j + 2];
            s3 += i8[qo + j + 3] * x[xo + j + 3];
          }
          total += d * ((s0 + s1) + (s2 + s3));
          bo += 34;
        }
        out[r] = total;
        o += blocks * 34;
      }
      return;
    }
    case QT.F16: {
      let o = base;
      for (let r = 0; r < rows; r++) {
        let s0 = 0, s1 = 0;
        for (let c = 0; c < rowLen; c++, o += 2) {
          const v = F16_TABLE[views.u8[o] | (views.u8[o + 1] << 8)] * x[c];
          if (c & 1) s1 += v; else s0 += v;
        }
        out[r] = s0 + s1;
      }
      return;
    }
    case QT.BF16: {
      let o = base;
      for (let r = 0; r < rows; r++) {
        let s = 0;
        for (let c = 0; c < rowLen; c++, o += 2) {
          s += f32FromBits(((views.u8[o] | (views.u8[o + 1] << 8)) << 16) >>> 0) * x[c];
        }
        out[r] = s;
      }
      return;
    }
    default: {
      // Q4_K / Q6_K / Q4_0 等：逐行反量化后点积
      const rowBytes = (rowLen / t.block) * t.blockBytes;
      let o = base;
      for (let r = 0; r < rows; r++) {
        dequantRow(views, type, o, rowLen, scratch);
        out[r] = dot(scratch, x, rowLen);
        o += rowBytes;
      }
    }
  }
}

function tensorRowBytes(t) {
  return (t.rowLen / t.block) * t.blockBytes;
}

// ============================================================ GPT-2 byte-level 映射

function buildByteUnicodeMaps() {
  const bs = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (bs.indexOf(b) < 0) { bs.push(b); cs.push(256 + n); n++; }
  }
  const byteToChar = new Array(256);
  const charToByte = new Map();
  for (let i = 0; i < bs.length; i++) {
    const ch = String.fromCodePoint(cs[i]);
    byteToChar[bs[i]] = ch;
    charToByte.set(ch, bs[i]);
  }
  return { byteToChar, charToByte };
}

const BYTE_MAPS = buildByteUnicodeMaps();

// Qwen 预切分正则（与 tokenizer.json 一致；JS 不支持内联 (?i:)，用 i 标志替代）
const QWEN_PRETOKEN = /(?:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu;

// ============================================================ Tokenizer

/** token_type: 1 NORMAL, 2 UNKNOWN, 3 CONTROL, 4 USER_DEFINED, 5 UNUSED, 6 BYTE */
class Tokenizer {
  constructor(gguf) {
    const md = gguf.metadata;
    const model = md['tokenizer.ggml.model'];
    if (model !== 'gpt2') {
      throw new Error('不支持的 tokenizer 模型 "' + model + '"（仅支持 gpt2 byte-level BPE）');
    }
    this.pre = md['tokenizer.ggml.pre'] || '';
    const toks = md['tokenizer.ggml.tokens'];
    if (!Array.isArray(toks)) throw new Error('GGUF 缺少 tokenizer.ggml.tokens');
    const merges = md['tokenizer.ggml.merges'] || [];
    const types = md['tokenizer.ggml.token_type'] || null;
    this.tokens = toks;
    this.tokenTypes = types;
    this.nVocab = toks.length;
    this.unkId = typeof md['tokenizer.ggml.unknown_token_id'] === 'number' ? md['tokenizer.ggml.unknown_token_id'] : 0;
    this.eosId = typeof md['tokenizer.ggml.eos_token_id'] === 'number' ? md['tokenizer.ggml.eos_token_id'] : 151645;
    this.bosId = typeof md['tokenizer.ggml.bos_token_id'] === 'number' ? md['tokenizer.ggml.bos_token_id'] : -1;
    this.addBos = md['tokenizer.ggml.add_bos_token'] === true;
    this.vocab = new Map();
    for (let i = 0; i < toks.length; i++) {
      const s = toks[i];
      if (!this.vocab.has(s)) this.vocab.set(s, i);
    }
    this.mergeRanks = new Map();
    for (let i = 0; i < merges.length; i++) {
      const m = merges[i]; // 格式 "<左侧符号> <右侧符号>"，符号里不含空格
      if (m.indexOf(' ') < 0) continue;
      this.mergeRanks.set(m, i);
    }
    this.byteToChar = BYTE_MAPS.byteToChar;
    this.charToByte = BYTE_MAPS.charToByte;
    this._cache = new Map();
    this._buildSpecials(md);
  }

  _buildSpecials(md) {
    const types = this.tokenTypes;
    const list = [];
    for (let i = 0; i < this.tokens.length; i++) {
      const s = this.tokens[i];
      if (!s) continue;
      let isSpecial = false;
      if (Array.isArray(types)) {
        const t = types[i];
        if (t === 3 || t === 4) isSpecial = true;
      } else if (/^<\|[\s\S]*\|>$/.test(s) || s === '<s>' || s === '</s>') {
        isSpecial = true;
      }
      if (isSpecial) list.push(s);
    }
    // 去重 + 按长度降序（最长匹配优先）
    const seen = new Set();
    const uniq = [];
    for (const s of list) {
      if (!seen.has(s)) { seen.add(s); uniq.push(s); }
    }
    uniq.sort((a, b) => b.length - a.length);
    this.specialTokens = uniq;
    this.specialIds = new Map();
    for (const s of uniq) this.specialIds.set(s, this.vocab.get(s));
    if (uniq.length) {
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      this._specialRe = new RegExp(uniq.map(esc).join('|'), 'gu');
    } else {
      this._specialRe = null;
    }
  }

  _bpe(piece) {
    const cached = this._cache.get(piece);
    if (cached) return cached;
    const bytes = Buffer.from(piece, 'utf8');
    if (bytes.length === 0) { this._cache.set(piece, []); return []; }
    let parts = new Array(bytes.length);
    const b2c = this.byteToChar;
    for (let i = 0; i < bytes.length; i++) parts[i] = b2c[bytes[i]];
    const ranks = this.mergeRanks;
    while (parts.length > 1) {
      let bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = ranks.get(parts[i] + ' ' + parts[i + 1]);
        if (r !== undefined && r < bestRank) bestRank = r;
      }
      if (bestRank === Infinity) break;
      const next = [];
      for (let i = 0; i < parts.length; i++) {
        if (i + 1 < parts.length && ranks.get(parts[i] + ' ' + parts[i + 1]) === bestRank) {
          next.push(parts[i] + parts[i + 1]);
          i++;
        } else {
          next.push(parts[i]);
        }
      }
      parts = next;
    }
    const ids = [];
    const vocab = this.vocab;
    for (const s of parts) {
      const id = vocab.get(s);
      if (id !== undefined) { ids.push(id); continue; }
      // 兜底：按单字符（byte token）切分
      for (const ch of Array.from(s)) {
        const cid = vocab.get(ch);
        ids.push(cid !== undefined ? cid : this.unkId);
      }
    }
    if (this._cache.size > 8192) this._cache.clear();
    this._cache.set(piece, ids);
    return ids;
  }

  _encodePlain(text, out) {
    const re = QWEN_PRETOKEN;
    re.lastIndex = 0;
    let m;
    let consumed = 0;
    while ((m = re.exec(text))) {
      if (m.index > consumed) {
        // 理论上正则覆盖全部字符，兜底防止丢字符
        const gap = text.slice(consumed, m.index);
        for (const id of this._bpe(gap)) out.push(id);
      }
      for (const id of this._bpe(m[0])) out.push(id);
      consumed = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (consumed < text.length) {
      for (const id of this._bpe(text.slice(consumed))) out.push(id);
    }
  }

  /**
   * 文本 -> token ids。
   * opts.parseSpecial：是否把 <|im_start|> 等特殊 token 当作整体（默认 true）
   */
  encode(text, opts) {
    const s = String(text == null ? '' : text);
    const ids = [];
    const parseSpecial = !opts || opts.parseSpecial !== false;
    if (!parseSpecial || !this._specialRe) {
      this._encodePlain(s, ids);
      return ids;
    }
    const re = this._specialRe;
    re.lastIndex = 0;
    let m;
    let consumed = 0;
    while ((m = re.exec(s))) {
      if (m.index > consumed) this._encodePlain(s.slice(consumed, m.index), ids);
      const sid = this.specialIds.get(m[0]);
      if (sid !== undefined) ids.push(sid);
      else this._encodePlain(m[0], ids);
      consumed = m.index + m[0].length;
    }
    if (consumed < s.length) this._encodePlain(s.slice(consumed), ids);
    return ids;
  }

  /** token ids -> 文本（按字节还原 UTF-8） */
  decode(ids) {
    const bytes = [];
    for (const id of ids) {
      if (id < 0 || id >= this.tokens.length) continue;
      const s = this.tokens[id];
      if (!s) continue;
      for (const ch of s) {
        const b = this.charToByte.get(ch);
        if (b === undefined) {
          const eb = Buffer.from(ch, 'utf8');
          for (const x of eb) bytes.push(x);
        } else {
          bytes.push(b);
        }
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }

  tokenText(id) {
    return id >= 0 && id < this.tokens.length ? this.tokens[id] : '';
  }
}

// ============================================================ Qwen2 前向

/**
 * 从 metadata 读取 Qwen2 结构参数。
 * 兼容 tiny 模型：全部来自 metadata。
 */
function qwen2Params(md) {
  const get = (k, def) => (typeof md[k] === 'number' ? md[k] : def);
  const arch = md['general.architecture'] || '';
  const p = {
    arch,
    nLayer: get('qwen2.block_count', 0),
    nEmbd: get('qwen2.embedding_length', 0),
    nFF: get('qwen2.feed_forward_length', 0),
    nHead: get('qwen2.attention.head_count', 0),
    nHeadKv: get('qwen2.attention.head_count_kv', get('qwen2.attention.head_count', 0)),
    eps: get('qwen2.attention.layer_norm_rms_epsilon', 1e-6),
    ropeBase: get('qwen2.rope.freq_base', 1e6),
    nCtxModel: get('qwen2.context_length', 32768),
  };
  if (!p.nLayer || !p.nEmbd || !p.nHead) throw new Error('GGUF 缺少 Qwen2 结构参数（block_count/embedding_length/head_count）');
  if (p.nEmbd % p.nHead !== 0) throw new Error('embedding_length 不能被 head_count 整除');
  p.headDim = p.nEmbd / p.nHead;
  if (p.nHead % p.nHeadKv !== 0) throw new Error('head_count 不能被 head_count_kv 整除');
  p.kvGroup = p.nHead / p.nHeadKv;
  if (!p.nFF) p.nFF = Math.floor(4 * p.nEmbd);
  return p;
}

// RoPE 布局：'norm' = 前后半对（GGML NORM，与 HF rotate_half 一致）；
//           'neox' = 相邻成对（GGML NEOX）。
// 真实 Qwen2 的 GGUF 用 NORM；可用环境变量 EMAIL_CHATTER_AI_ROPE=neox 覆盖做对比测试。
const ROPE_MODE = (process.env.EMAIL_CHATTER_AI_ROPE || 'norm').toLowerCase() === 'neox' ? 'neox' : 'norm';

class Qwen2Model {
  constructor(gguf, opts) {
    this.gguf = gguf;
    this.views = makeViews(gguf.buffer);
    this.p = qwen2Params(gguf.metadata);
    const p = this.p;
    const tm = gguf.tensorMap;
    const need = (name) => {
      const t = tm.get(name);
      if (!t) throw new Error('GGUF 缺少张量 ' + name);
      return t;
    };
    this.embd = need('token_embd.weight');
    if (this.embd.rowLen !== p.nEmbd) {
      throw new Error('token_embd.weight 形状不匹配: rowLen=' + this.embd.rowLen + ' nEmbd=' + p.nEmbd);
    }
    this.nVocab = this.embd.rows;
    this.outW = tm.get('output.weight') || null;
    if (this.outW && (this.outW.rowLen !== p.nEmbd || this.outW.rows !== this.nVocab)) {
      throw new Error('output.weight 形状不匹配');
    }
    this.outNorm = tm.get('output_norm.weight') || null;
    this.layers = [];
    for (let i = 0; i < p.nLayer; i++) {
      const pre = 'blk.' + i + '.';
      const L = {
        attnNorm: need(pre + 'attn_norm.weight'),
        wq: need(pre + 'attn_q.weight'),
        bq: tm.get(pre + 'attn_q.bias') || null,
        wk: need(pre + 'attn_k.weight'),
        bk: tm.get(pre + 'attn_k.bias') || null,
        wv: need(pre + 'attn_v.weight'),
        bv: tm.get(pre + 'attn_v.bias') || null,
        wo: need(pre + 'attn_output.weight'),
        ffnNorm: need(pre + 'ffn_norm.weight'),
        wg: need(pre + 'ffn_gate.weight'),
        wu: need(pre + 'ffn_up.weight'),
        wd: need(pre + 'ffn_down.weight'),
      };
      this.layers.push(L);
    }
    // KV cache
    const nCtx = Math.max(64, Math.min(opts && opts.nCtx ? opts.nCtx : 1024, p.nCtxModel || 1024));
    this.nCtx = nCtx;
    this.kv = [];
    for (let i = 0; i < p.nLayer; i++) {
      this.kv.push({
        k: new Float32Array(nCtx * p.nHeadKv * p.headDim),
        v: new Float32Array(nCtx * p.nHeadKv * p.headDim),
      });
    }
    // RoPE 逆频率（每 token 只算一次 cos/sin，所有层共用）
    this.invFreq = new Float32Array(p.headDim / 2);
    for (let j = 0; j < this.invFreq.length; j++) this.invFreq[j] = Math.pow(p.ropeBase, -2 * j / p.headDim);
    this._cos = new Float32Array(p.headDim / 2);
    this._sin = new Float32Array(p.headDim / 2);
    this._ropePos = -1;
    // 工作区
    this.x = new Float32Array(p.nEmbd);
    this.h = new Float32Array(p.nEmbd);
    this.tmp = new Float32Array(p.nEmbd);
    this.q = new Float32Array(p.nEmbd);
    this.k = new Float32Array(p.nHeadKv * p.headDim);
    this.v = new Float32Array(p.nHeadKv * p.headDim);
    this.attnOut = new Float32Array(p.nEmbd);
    this.gate = new Float32Array(p.nFF);
    this.up = new Float32Array(p.nFF);
    this.act = new Float32Array(p.nFF);
    this.logits = new Float32Array(this.nVocab);
    this.scores = new Float32Array(nCtx);
    this.rowScratch = new Float32Array(Math.max(p.nEmbd, p.nFF));
    this.pos = 0;
    this._forwardCount = 0;
  }

  resetCache() { this.pos = 0; }

  _rmsNorm(out, x, w) {
    const n = x.length;
    let ss = 0;
    for (let i = 0; i < n; i++) ss += x[i] * x[i];
    const inv = 1 / Math.sqrt(ss / n + this.p.eps);
    if (!w) {
      for (let i = 0; i < n; i++) out[i] = x[i] * inv;
      return;
    }
    const u8 = this.views.u8;
    const t = w;
    // 权重通常是 F32，直接读
    if (t.type === QT.F32 && this.views.f32 && (t.dataOffset & 3) === 0) {
      const f = this.views.f32;
      const s = t.dataOffset >> 2;
      for (let i = 0; i < n; i++) out[i] = x[i] * inv * f[s + i];
    } else if (t.type === QT.F16) {
      let o = t.dataOffset;
      for (let i = 0; i < n; i++, o += 2) out[i] = x[i] * inv * F16_TABLE[u8[o] | (u8[o + 1] << 8)];
    } else {
      const sc = this.rowScratch;
      dequantRow(this.views, t.type, t.dataOffset, n, sc);
      for (let i = 0; i < n; i++) out[i] = x[i] * inv * sc[i];
    }
  }

  _addBias(out, bias) {
    if (!bias) return;
    const sc = this.rowScratch;
    const n = out.length;
    dequantRow(this.views, bias.type, bias.dataOffset, n, sc);
    for (let i = 0; i < n; i++) out[i] += sc[i];
  }

  /** 预计算当前位置的 cos/sin（每 token 一次） */
  _prepareRope(pos) {
    if (this._ropePos === pos) return;
    this._ropePos = pos;
    const half = this.invFreq.length;
    const cos = this._cos, sin = this._sin, inv = this.invFreq;
    for (let j = 0; j < half; j++) {
      const ang = pos * inv[j];
      cos[j] = Math.cos(ang);
      sin[j] = Math.sin(ang);
    }
  }

  _rope(v, nHeads, headDim, pos) {
    this._prepareRope(pos);
    const half = headDim >> 1;
    const cos = this._cos, sin = this._sin;
    if (ROPE_MODE === 'neox') {
      for (let h = 0; h < nHeads; h++) {
        const base = h * headDim;
        for (let j = 0; j < half; j++) {
          const i0 = base + 2 * j, i1 = i0 + 1;
          const x0 = v[i0], x1 = v[i1];
          const c = cos[j], s = sin[j];
          v[i0] = x0 * c - x1 * s;
          v[i1] = x0 * s + x1 * c;
        }
      }
    } else {
      for (let h = 0; h < nHeads; h++) {
        const base = h * headDim;
        for (let j = 0; j < half; j++) {
          const i0 = base + j, i1 = i0 + half;
          const x0 = v[i0], x1 = v[i1];
          const c = cos[j], s = sin[j];
          v[i0] = x0 * c - x1 * s;
          v[i1] = x0 * s + x1 * c;
        }
      }
    }
  }

  _attention(layer, pos) {
    const p = this.p;
    const hd = p.headDim;
    const nH = p.nHead;
    const nKv = p.nHeadKv;
    const group = p.kvGroup;
    const scale = 1 / Math.sqrt(hd);
    const ctxLen = pos + 1;
    const scores = this.scores;
    const q = this.q, attnOut = this.attnOut;
    const K = this.kv[layer].k, V = this.kv[layer].v;
    for (let h = 0; h < nH; h++) {
      const kvh = (h / group) | 0;
      const qbase = h * hd;
      const kbase = kvh * hd;
      let maxv = -Infinity;
      for (let t = 0; t < ctxLen; t++) {
        const off = t * nKv * hd + kbase;
        let s = 0;
        for (let d = 0; d < hd; d++) s += q[qbase + d] * K[off + d];
        s *= scale;
        scores[t] = s;
        if (s > maxv) maxv = s;
      }
      let sum = 0;
      for (let t = 0; t < ctxLen; t++) {
        const e = Math.exp(scores[t] - maxv);
        scores[t] = e;
        sum += e;
      }
      const inv = 1 / sum;
      const ob = h * hd;
      for (let d = 0; d < hd; d++) attnOut[ob + d] = 0;
      for (let t = 0; t < ctxLen; t++) {
        const w = scores[t] * inv;
        if (w === 0) continue;
        const off = t * nKv * hd + kbase;
        for (let d = 0; d < hd; d++) attnOut[ob + d] += w * V[off + d];
      }
    }
  }

  /**
   * 单 token 前向。pos 从 0 开始（调用者维护）。
   * @returns Float32Array logits（needLogits=true）或 null
   */
  forward(tokenId, pos, needLogits) {
    const p = this.p;
    const nE = p.nEmbd;
    if (pos >= this.nCtx) throw new Error('超出上下文长度 ' + this.nCtx);
    if (tokenId < 0 || tokenId >= this.nVocab) throw new Error('token id 越界: ' + tokenId);
    const x = this.x;
    // 1) embedding 行
    const rowBytes = tensorRowBytes(this.embd);
    dequantRow(this.views, this.embd.type, this.embd.dataOffset + tokenId * rowBytes, nE, x);
    this._forwardCount++;
    const kv = this.kv;
    for (let L = 0; L < p.nLayer; L++) {
      const l = this.layers[L];
      // 2) attention norm
      this._rmsNorm(this.h, x, l.attnNorm);
      // 3) QKV
      matVec(this.views, l.wq, this.h, this.q, this.rowScratch);
      this._addBias(this.q, l.bq);
      matVec(this.views, l.wk, this.h, this.k, this.rowScratch);
      this._addBias(this.k, l.bk);
      matVec(this.views, l.wv, this.h, this.v, this.rowScratch);
      this._addBias(this.v, l.bv);
      // 4) RoPE
      this._rope(this.q, p.nHead, p.headDim, pos);
      this._rope(this.k, p.nHeadKv, p.headDim, pos);
      // 5) 写入 KV cache
      const kcache = kv[L].k, vcache = kv[L].v;
      const stride = p.nHeadKv * p.headDim;
      kcache.set(this.k, pos * stride);
      vcache.set(this.v, pos * stride);
      // 6) attention（使用当前层 KV cache）
      this._attention(L, pos);
      // 7) 输出投影 + 残差
      matVec(this.views, l.wo, this.attnOut, this.tmp, this.rowScratch);
      for (let i = 0; i < nE; i++) x[i] += this.tmp[i];
      // 8) FFN
      this._rmsNorm(this.h, x, l.ffnNorm);
      matVec(this.views, l.wg, this.h, this.gate, this.rowScratch);
      matVec(this.views, l.wu, this.h, this.up, this.rowScratch);
      const gate = this.gate, up = this.up, act = this.act;
      const nFF = p.nFF;
      for (let i = 0; i < nFF; i++) {
        const g = gate[i];
        act[i] = (g / (1 + Math.exp(-g))) * up[i];
      }
      matVec(this.views, l.wd, act, this.tmp, this.rowScratch);
      for (let i = 0; i < nE; i++) x[i] += this.tmp[i];
    }
    if (!needLogits) return null;
    // 9) 末层 norm + lm_head
    this._rmsNorm(this.h, x, this.outNorm);
    const w = this.outW || this.embd;
    matVec(this.views, w, this.h, this.logits, this.rowScratch);
    return this.logits;
  }

  /** 对整串 token 做前向，返回最后一个位置的 logits（拷贝）。 */
  logitsFor(ids) {
    if (!ids.length) throw new Error('logitsFor 需要至少一个 token');
    this.resetCache();
    for (let i = 0; i < ids.length; i++) {
      const need = i === ids.length - 1;
      const r = this.forward(ids[i], i, need);
      if (need) return Float32Array.from(r);
    }
    throw new Error('unreachable');
  }

  /**
   * 贪心生成。
   * @param {number[]} promptIds
   * @param {number} maxTokens
   * @param {object} opts {eosId, stopOnNewline, onToken}
   * @returns {{tokens:number[], tokenIds:number[], text:string}}
   */
  generateGreedy(promptIds, maxTokens, opts) {
    opts = opts || {};
    const eosId = typeof opts.eosId === 'number' ? opts.eosId : -1;
    const stopOnNewline = opts.stopOnNewline !== false;
    this.resetCache();
    let pos = 0;
    let logits = null;
    const ids = promptIds.slice();
    for (let i = 0; i < ids.length; i++) {
      const need = i === ids.length - 1;
      logits = this.forward(ids[i], pos++, need);
    }
    const out = [];
    let text = '';
    for (let i = 0; i < maxTokens; i++) {
      if (pos >= this.nCtx) break;
      // argmax
      let best = -Infinity, bestId = -1;
      const lg = logits;
      for (let v = 0; v < lg.length; v++) {
        if (lg[v] > best) { best = lg[v]; bestId = v; }
      }
      if (bestId < 0 || bestId === eosId) break;
      out.push(bestId);
      const tokText = opts.tokenizer ? opts.tokenizer.tokenText(bestId) : '';
      if (tokText) text += tokText;
      if (opts.onToken) opts.onToken(bestId, i);
      if (stopOnNewline && (tokText.indexOf('\n') >= 0 || tokText.indexOf('\r') >= 0)) break;
      logits = this.forward(bestId, pos++, true);
    }
    return { tokens: out, tokenIds: out, text: opts.tokenizer ? opts.tokenizer.decode(out) : text };
  }
}

// ============================================================ 提示词 / 后处理

const SYSTEM_PROMPT =
  '你是一个邮件主题生成助手。根据用户消息生成一个简洁、准确、不夸张的中文邮件主题，不超过20个字；' +
  '只输出主题本身，不要引号、不要"标题："前缀、不要解释、不要句号。';

function truncateChars(text, n) {
  const arr = Array.from(String(text == null ? '' : text));
  return arr.length > n ? arr.slice(0, n).join('') : arr.join('');
}

/** §6.3 标题提示词（chat 模板）；消息正文 UTF-8 截断到 600 字符 */
function buildPrompt(text) {
  const user = truncateChars(text, 600);
  return '<|im_start|>system\n' + SYSTEM_PROMPT + '<|im_end|>\n' +
    '<|im_start|>user\n' + user + '<|im_end|>\n' +
    '<|im_start|>assistant\n';
}

/** §6.3 后处理：trim → 去前缀 → 去包裹引号 → 去尾部标点 → 换行并空格 → 截断 40 字符 */
function postProcessTitle(raw, text) {
  let t = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim();
  t = t.replace(/^\s*标题\s*[:：]\s*/, '').trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(/^["“”'「」『』]+/, '').replace(/["“”'「」『』]+$/, '').trim();
    if (t === before) break;
  }
  t = t.replace(/([。．.!！?？]+)$/g, '').trim();
  t = t.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const chars = Array.from(t);
  if (chars.length > 40) t = chars.slice(0, 40).join('');
  if (!t) return heuristicTitle(text);
  return t;
}

/** §6.3 启发式标题（与 ai.js 保持一致；gguf.js 内保留一份供 worker 使用） */
function heuristicTitle(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  let line = '';
  for (const raw of s.split('\n')) {
    if (String(raw).trim()) { line = String(raw).trim(); break; }
  }
  if (!line) return '无主题';
  let t = line
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/`+/g, '')
    .replace(/[*_~]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return '无主题';
  const chars = Array.from(t);
  if (chars.length > 30) return chars.slice(0, 30).join('') + '…';
  return t;
}

// ============================================================ 加载 & 生成入口

/**
 * 加载模型：解析 GGUF、构造 tokenizer 与 Qwen2 模型。
 * @param {string} filePath
 * @param {object} opts {nCtx}
 */
function loadModel(filePath, opts) {
  const gguf = parseGGUFFile(filePath);
  const tokenizer = new Tokenizer(gguf);
  const model = new Qwen2Model(gguf, opts || {});
  return { gguf, tokenizer, model, path: filePath };
}

const DEFAULT_EOS = 151645; // <|im_end|>

/**
 * 生成标题（加载后的模型）：构建 §6.3 提示词 → 贪心生成 → 后处理。
 * @returns {{title:string, raw:string, promptTokens:number, genTokens:number, elapsedMs:number}}
 */
function generateTitleWithModel(loaded, text, opts) {
  const { tokenizer, model } = loaded;
  const t0 = Date.now();
  const prompt = buildPrompt(text);
  const promptIds = tokenizer.encode(prompt);
  if (!promptIds.length) {
    return { title: heuristicTitle(text), raw: '', promptTokens: 0, genTokens: 0, elapsedMs: Date.now() - t0 };
  }
  const maxTokens = (opts && opts.maxTokens) || 24;
  const res = model.generateGreedy(promptIds, maxTokens, {
    eosId: tokenizer.eosId >= 0 ? tokenizer.eosId : DEFAULT_EOS,
    stopOnNewline: true,
    tokenizer,
  });
  const raw = tokenizer.decode(res.tokens);
  const title = postProcessTitle(raw, text);
  return {
    title,
    raw,
    promptTokens: promptIds.length,
    genTokens: res.tokens.length,
    genTokenIds: res.tokens,
    elapsedMs: Date.now() - t0,
  };
}

module.exports = {
  // 解析 / 加载
  GGUF_MAGIC,
  TENSOR_TYPE,
  TYPE_INFO,
  QT,
  ROPE_MODE,
  parseGGUF,
  parseGGUFFile,
  loadModel,
  // 量化
  dequantRow,
  matVec,
  tensorRowBytes,
  // tokenizer / 模型
  Tokenizer,
  Qwen2Model,
  // 提示词 / 后处理
  SYSTEM_PROMPT,
  buildPrompt,
  postProcessTitle,
  heuristicTitle,
  truncateChars,
  generateTitleWithModel,
  // 内部（测试用）
  _internal: { F16_TABLE, makeViews, dot, getScaleMinK4, qwen2Params },
};
