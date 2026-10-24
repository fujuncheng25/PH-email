'use strict';
/*
 * Email Chatter - Node backend for the Electron build.
 * Pure Node.js (zero npm runtime dependencies): HTTP server + SMTP/POP3/IMAP
 * over net/tls + MIME parsing. Exposes the same REST API as the C++ build,
 * so web/ UI is shared 1:1.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

// ============================== small utils ==============================

function lower(s) { return String(s || '').toLowerCase(); }
function trim(s) { return String(s || '').trim(); }

/*
 * 清洗用户输入的主机名：去掉 https:// 等协议头、路径、查询串、userinfo、空格；
 * 若形如 host:port 且端口合法，则用其覆盖端口。返回 { host, port }。
 */
function normalizeHost(raw, port) {
  let s = trim(raw);
  if (!s) return { host: '', port };
  s = s.replace(/^[a-z0-9+.-]+:\/\//i, '');
  const cut = s.search(/[/?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  s = s.replace(/\s+/g, '');
  if (!s) return { host: '', port };
  if (s.startsWith('[')) {                       // IPv6 字面量
    const rb = s.indexOf(']');
    if (rb < 0) return { host: s, port };
    const rest = s.slice(rb + 1);
    const m = rest.match(/^:(\d{1,5})$/);
    if (m) { const p = parseInt(m[1], 10); if (p > 0 && p < 65536) port = p; }
    return { host: s.slice(0, rb + 1), port };
  }
  const m = s.match(/^(.+):(\d{1,5})$/);
  if (m) {
    const p = parseInt(m[2], 10);
    if (p > 0 && p < 65536) return { host: m[1], port: p };
  }
  return { host: s, port };
}

function normalizeServer(base, incoming, defaultPort) {
  const merged = Object.assign({ host: '', port: defaultPort, ssl: true }, base, incoming);
  const n = normalizeHost(merged.host, merged.port);
  merged.host = n.host;
  merged.port = n.port;
  return merged;
}
function now() { return Math.floor(Date.now() / 1000); }
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function jsonOk() { return JSON.stringify({ ok: true }); }
function jsonErr(msg) { return JSON.stringify({ ok: false, error: String(msg) }); }

function truncate(s, n) {
  let t = String(s || '');
  if (t.length <= n) return t;
  let cut = n;
  while (cut > 0 && (t.charCodeAt(cut) & 0xC0) === 0x80) cut--;
  return t.slice(0, cut);
}

// 附件 / 请求体大小上限（与 C++ 版、FEATURE-SPEC §3.2 §7 一致）
const MAX_ATTACHMENT = 16 * 1024 * 1024;         // 单附件 16MB
const MAX_ATTACHMENTS_TOTAL = 24 * 1024 * 1024;  // 单封邮件附件合计 24MB
const MAX_HTTP_BODY = 32 * 1024 * 1024;          // HTTP 请求体 32MB

// 按字符截断文件名但保留扩展名（避免截断掉 .png/.docx 导致 Content-Type 变 octet-stream，L4）
function truncateNameKeepExt(s, maxChars) {
  const chars = Array.from(s);
  if (chars.length <= maxChars) return s;
  const dot = s.lastIndexOf('.');
  let ext = '';
  if (dot > 0) {
    const e = s.slice(dot);
    if (Array.from(e).length <= 12) ext = e;
  }
  const keep = Math.max(1, maxChars - Array.from(ext).length);
  return chars.slice(0, keep).join('') + ext;
}

// 文件名清洗（与 C++ mime::sanitize_filename 一致）：
// 去掉路径分隔符/控制字符，去首尾点与空格，空则用 fallback，按 UTF-8 字符截断（保留扩展名）。
function sanitizeDisplayName(name, maxChars, fallback) {
  let s = String(name == null ? '' : name).replace(/[\u0000-\u001f/\\]/g, '').trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) s = fallback || 'file';
  if (maxChars > 0) s = truncateNameKeepExt(s, maxChars);
  return s;
}

// data/attachments 下文件名的安全分量（与 C++ sanitize_stored_component 一致）：
// 只保留 [A-Za-z0-9._-] 与中文（≥0x80），其它替换为 _，去掉开头点，≤60 字符（保留扩展名）。
function sanitizeStoredComponent(name) {
  let out = '';
  for (const ch of Array.from(String(name == null ? '' : name).trim())) {
    const c = ch.codePointAt(0);
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
        ch === '.' || ch === '_' || ch === '-' || c >= 0x80) {
      out += ch;
    } else {
      out += '_';
    }
  }
  while (out.startsWith('.')) out = out.slice(1);
  if (!out) out = 'file';
  return truncateNameKeepExt(out, 60);
}

// 与 C++ http::content_type_for 对齐（附件/上传的 mime 推断；未知回落 octet-stream）
const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

function mimeFromName(name) {
  return MIME_BY_EXT[lower(path.extname(String(name || '')))] || '';
}

// 去掉 mime 参数（charset 等），非法回落 application/octet-stream（C++ base_mime）
function baseMime(mime) {
  const m = lower(trim(String(mime || ''))).split(';')[0].trim();
  if (!m || m.indexOf('/') < 0) return 'application/octet-stream';
  return m;
}

// 图片 mime 判定（与规格 §3.2 的 image/png|jpeg|gif|webp|bmp 一致）
function isImageMime(mime) {
  return /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(String(mime || '').split(';')[0].trim());
}

function wrapBase64(buf) {
  const data = Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(String(buf || ''), 'utf8').toString('base64');
  let out = '';
  for (let i = 0; i < data.length; i += 76) out += data.slice(i, i + 76) + '\r\n';
  return out;
}

// 给可能很慢的 AI 调用加超时；超时后走启发式标题，避免 HTTP 请求永久挂住
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('AI 生成超时（' + Math.round(ms / 1000) + 's）'));
    }, ms);
    if (timer.unref) timer.unref();
    Promise.resolve(promise).then((v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    }, (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

// 启发式标题（规格 §6.3；ai.js 可用时优先用其实现，保证 C++/Node 一致）
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

// 解析地址列表（逗号/分号/空白分隔，去空、去重、去尖括号、必须含 @，最多 maxCount 个；
// 非法项静默丢弃，与 C++ parse_addr_list 一致）
function parseAddrList(raw, maxCount) {
  const out = [];
  if (raw === null || raw === undefined || raw === '') return out;
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  for (const piece of text.split(/[,;，；\s]+/)) {
    let e = lower(trim(piece));
    if (!e) continue;
    if (out.length >= maxCount) break;
    if (e.length >= 2 && e[0] === '<' && e[e.length - 1] === '>') e = e.slice(1, -1);
    if (e.indexOf('@') < 0) continue;
    if (out.includes(e)) continue;
    out.push(e);
  }
  return out;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  if (d.toDateString() === n.toDateString()) return p(d.getHours()) + ':' + p(d.getMinutes());
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function rfc5322Now() {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (x) => String(x).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function parseDate(s) {
  if (!s) return 0;
  const t = Date.parse(String(s).trim());
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

function charsetToUtf8(buf, charset) {
  const cs = lower(charset).replace(/[ "]/g, '');
  if (!cs || cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
    return buf.toString('utf8');
  }
  if (cs === 'iso-8859-1' || cs === 'latin1') return buf.toString('latin1');
  try {
    return new TextDecoder(cs).decode(buf);
  } catch (e) {
    return buf.toString('utf8');
  }
}

function qpDecodeHex(x) {
  if (x >= 0x30 && x <= 0x39) return x - 0x30;
  if (x >= 0x61 && x <= 0x66) return x - 0x57;
  if (x >= 0x41 && x <= 0x46) return x - 0x37;
  return -1;
}

// quoted-printable 解码：预分配输出缓冲 + 游标写入，O(n)。
// 旧实现每字节 Buffer.concat 是 O(n²)（400KB 邮件约 9s，会阻塞事件循环），见 code review H2。
function qpDecode(buf) {
  const out = Buffer.allocUnsafe(buf.length);  // 解码后长度一定 <= 输入长度
  let n = 0;
  for (let i = 0; i < buf.length;) {
    const c = buf[i];
    if (c === 0x3d) { // '='
      if (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) { i += 3; continue; }  // 软换行 CRLF
      if (buf[i + 1] === 0x0a) { i += 2; continue; }                        // 软换行 LF
      if (i + 2 < buf.length) {
        const a = qpDecodeHex(buf[i + 1]);
        const b = qpDecodeHex(buf[i + 2]);
        if (a >= 0 && b >= 0) { out[n++] = (a << 4) | b; i += 3; continue; }
      }
      out[n++] = c; i++;
    } else {
      out[n++] = c; i++;
    }
  }
  return out.subarray(0, n);
}

// ============================== MIME ==============================

function parseHeaders(headStr) {
  const out = {};
  const lines = [];
  for (const rawLine of headStr.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += ' ' + line.trim();
    } else {
      lines.push(line);
    }
  }
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = lower(line.slice(0, idx)).trim();
    if (name && !(name in out)) out[name] = line.slice(idx + 1).trim();
  }
  return out;
}

function contentTypeOf(value) {
  const ct = { type: 'text/plain', params: {} };
  const semi = String(value || '').indexOf(';');
  const t = trim(semi >= 0 ? value.slice(0, semi) : value);
  if (t) ct.type = lower(t);
  let s = semi >= 0 ? value : '';
  const re = /(^|;)\s*([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^;]*))/g;
  let m;
  while ((m = re.exec(s))) {
    const k = lower(m[2]);
    const v = trim(m[3] !== undefined ? m[3] : m[4]);
    if (k) ct.params[k] = v;
  }
  return ct;
}

function decodeEncodedWords(s) {
  const re = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  return String(s).replace(re, (full, charset, enc, data) => {
    try {
      if (enc === 'B' || enc === 'b') {
        return charsetToUtf8(Buffer.from(data, 'base64'), charset);
      }
      const q = data.replace(/_/g, ' ');
      return charsetToUtf8(qpDecode(Buffer.from(q, 'latin1')), charset);
    } catch (e) {
      return full;
    }
  });
}

function extractAddr(fromHeader) {
  const h = String(fromHeader || '');
  const lt = h.indexOf('<');
  if (lt >= 0) {
    const gt = h.indexOf('>', lt);
    if (gt >= 0) return lower(trim(h.slice(lt + 1, gt)));
  }
  const at = h.indexOf('@');
  if (at < 0) return lower(trim(h));
  let b = at, e = at;
  while (b > 0 && !/\s|\(|"|,|:/.test(h[b - 1])) b--;
  while (e < h.length && !/\s|\)|>|,|"/.test(h[e])) e++;
  return lower(trim(h.slice(b, e)));
}

function stripHtml(html) {
  let s = String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(br|p|div|li|tr|h[1-6]|table|ul|ol|hr|blockquote|pre|section|article)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d));
  return s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

function splitMultipart(body, boundary) {
  const parts = [];
  const delim = Buffer.from('--' + boundary, 'latin1');
  let pos = 0;
  for (;;) {
    const b = body.indexOf(delim, pos);
    if (b < 0) break;
    const after = b + delim.length;
    if (body[after] === 0x2d && body[after + 1] === 0x2d) break;
    const lineEnd = body.indexOf(0x0a, after);
    if (lineEnd < 0) break;
    let partStart = lineEnd + 1;
    let next = body.indexOf(delim, partStart);
    if (next < 0) { parts.push(body.subarray(partStart)); break; }
    let partEnd = next;
    if (partEnd > partStart && body[partEnd - 1] === 0x0a) partEnd--;
    if (partEnd > partStart && body[partEnd - 1] === 0x0d) partEnd--;
    parts.push(body.subarray(partStart, partEnd));
    pos = next;
  }
  return parts;
}

// 拆出 MIME 段头/正文（兼容 CRLF / LF）
function splitHeadBody(part) {
  let sep = part.indexOf(Buffer.from('\r\n\r\n'));
  let seplen = 4;
  if (sep < 0) { sep = part.indexOf(Buffer.from('\n\n')); seplen = 2; }
  if (sep < 0) return { head: parseHeaders(part.toString('latin1')), body: Buffer.alloc(0) };
  return {
    head: parseHeaders(part.subarray(0, sep).toString('latin1')),
    body: part.subarray(sep + seplen),
  };
}

function decodeTransfer(body, cte) {
  const e = lower(cte);
  if (e === 'base64') {
    const s = body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(s, 'base64');
  }
  if (e === 'quoted-printable') return qpDecode(body);
  return body;
}

// MIME 参数中的文件名（RFC2047 编码词 / RFC2231 filename* 都处理）；无文件名返回空串
function partFileName(h, ct) {
  const cdisp = contentTypeOf(h['content-disposition'] || '');
  let n = cdisp.params.filename || ct.params.name || '';
  const star = cdisp.params['filename*'] || ct.params['name*'] || '';
  if (star) n = star;  // C++：filename* 优先
  if (!n) return '';
  if (n.indexOf("'") >= 0) {
    // RFC2231：charset'lang'percent-encoded
    try {
      const m = n.match(/^([^']*)'([^']*)'(.*)$/);
      if (m) {
        const charset = m[1] || 'utf-8';
        const bytes = Buffer.from(m[3].replace(/%([0-9a-fA-F]{2})/g, (x, hh) => String.fromCharCode(parseInt(hh, 16))), 'latin1');
        n = /^utf-?8$/i.test(charset) ? bytes.toString('utf8') : charsetToUtf8(bytes, charset);
      }
    } catch (e) { /* keep */ }
  }
  return decodeEncodedWords(String(n).replace(/[\r\n\0]/g, ' ').trim());
}

/*
 * 递归收集正文文本与附件（支持普通邮箱发来的嵌套 multipart）：
 *  - text/plain 优先作为正文，text/html 兜底（去标签）；
 *  - 带 filename（或 Content-Disposition: attachment、非文本 mime）的段作为附件；
 *  - 单附件 >16MB / 合计 >24MB 时跳过该附件（消息仍写入，见规格 §3.2）。
 */
function collectFromPart(h, body, ctx, depth) {
  if (depth > 12) return;
  const ct = contentTypeOf(h['content-type']);
  if (ct.type.startsWith('multipart/')) {
    const boundary = ct.params.boundary;
    if (!boundary) return;
    for (const p of splitMultipart(body, boundary)) {
      const sb = splitHeadBody(p);
      collectFromPart(sb.head, sb.body, ctx, depth + 1);
    }
    return;
  }
  if (ct.type.startsWith('message/')) return;  // 嵌套邮件不展开（非目标）
  const disp = contentTypeOf(h['content-disposition'] || '');
  const rawName = partFileName(h, ct);
  const isText = ct.type === 'text/plain' || ct.type === 'text/html';
  const forcedAttachment = !!rawName || lower(trim(disp.type)).startsWith('attachment');
  const decoded = decodeTransfer(body, h['content-transfer-encoding']);
  if (isText && !forcedAttachment) {
    const text = charsetToUtf8(decoded, ct.params.charset || '');
    if (ct.type === 'text/plain') ctx.texts.push({ text, type: 'text/plain' });
    else ctx.texts.push({ text: stripHtml(text), type: 'text/html' });
    return;
  }
  const size = decoded.length;
  if (size > MAX_ATTACHMENT || ctx.attachmentBytes + size > MAX_ATTACHMENTS_TOTAL) {
    ctx.skippedAttachments++;
    return;
  }
  ctx.attachmentBytes += size;
  ctx.attachments.push({
    name: sanitizeDisplayName(rawName, 0, 'attachment'),
    mime: ct.type || 'application/octet-stream',
    size,
    data: decoded,
  });
}

function parseMessage(rawBuf) {
  const raw = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(String(rawBuf), 'latin1');
  const sb = splitHeadBody(raw);
  const h = sb.head;
  const from = decodeEncodedWords(h['from'] || '');
  const out = {
    from,
    from_addr: extractAddr(from),
    subject: decodeEncodedWords(h['subject'] || ''),
    body_text: '',
    message_id: trim(h['message-id'] || ''),
    date_raw: trim(h['date'] || ''),
    date_epoch: 0,
    kind: 'chat',
    quote: null,
    recall_mid: '',
    attachments: [],
  };
  out.date_epoch = parseDate(out.date_raw) || now();
  // 自定义头：kind / quote / recall（规格 §3.1）
  const kindRaw = lower(trim(h['x-email-chatter-kind'] || ''));
  if (kindRaw === 'email' || kindRaw === 'recall') out.kind = kindRaw;
  const recallRaw = trim(h['x-email-chatter-recall'] || '');
  if (recallRaw) out.recall_mid = recallRaw;
  const quoteRaw = h['x-email-chatter-quote'];
  if (quoteRaw) {
    try {
      const json = Buffer.from(String(quoteRaw).replace(/\s+/g, ''), 'base64').toString('utf8');
      const q = JSON.parse(json);
      if (q && typeof q === 'object') {
        out.quote = {
          text: truncate(String(q.text == null ? '' : q.text), 500),
          from: String(q.from == null ? '' : q.from),
          ts: parseInt(q.ts, 10) || 0,
          mid: String(q.mid == null ? '' : q.mid),
        };
      }
    } catch (e) { out.quote = null; }
  }
  const ctx = { texts: [], attachments: [], attachmentBytes: 0, skippedAttachments: 0 };
  collectFromPart(h, sb.body, ctx, 0);
  let text = '';
  for (const p of ctx.texts) if (p.type === 'text/plain') { text = p.text; break; }
  if (!trim(text)) for (const p of ctx.texts) if (p.type === 'text/html') { text = p.text; break; }
  // 仅当完全没有任何 part（纯单段正文）时才回落原始正文；
  // 有 part 但没有文本段（如只有附件的邮件）正文保持空串，避免把原始 MIME 当正文（review M1）
  if (!text && !ctx.texts.length && !ctx.attachments.length && sb.body.length) {
    text = sb.body.toString('latin1');
  }
  if (out.quote) {
    // 有引用头时剥离正文引用块，避免前端重复显示（规格 §2/§3.1）
    let idx = text.indexOf('\r\n\r\n--- 引用 ---\r\n');
    if (idx >= 0) text = text.slice(0, idx);
    else {
      idx = text.indexOf('\n\n--- 引用 ---\n');
      if (idx >= 0) text = text.slice(0, idx);
    }
  }
  out.body_text = trim(text);
  out.attachments = ctx.attachments;
  return out;
}

function sanitizeHeader(s) {
  // 头部字段注入防护：CR / LF / NUL 替换为空格
  return String(s || '').replace(/[\r\n\0]/g, ' ');
}

function encodeHeader(s) {
  s = sanitizeHeader(s);
  return /[^\x00-\x7f]/.test(s) ? '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=' : s;
}

const crypto = require('crypto');

function genMsgId() {
  // 原实现用了未播种的 Math.random + 秒级时间戳，同一秒内发出的两封邮件 Message-ID 可能相同。
  // 改为 crypto.randomBytes（加密级随机）+ 纳秒时间，保证唯一性。
  return `<${Date.now()}.${process.hrtime.bigint().toString()}.${crypto.randomBytes(8).toString('hex')}@email-chatter.local>`;
}

// MIME 头里的文件名参数：非 ASCII 用 RFC2047 B 编码（规格 §3.2）
function fileNameParam(name) {
  const s = sanitizeHeader(trim(name) || 'attachment');
  if (/[^\x20-\x7e]/.test(s)) return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// 引用正文块（普通邮箱用户可读，规格 §3.1；每行末尾都有 \n，与 C++ 一致）
function fmtQuoteTime(ts) {
  const n = parseInt(ts, 10) || 0;
  if (!n) return '';
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, '0');
  const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return s.length > 16 ? s.slice(0, 16) : s;
}

function quoteBodyBlock(quote) {
  let out = '\n\n--- 引用 ---\n';
  out += '> 发件人：' + (quote.from ? quote.from : '未知') + '\n';
  out += '> 时间：' + fmtQuoteTime(quote.ts) + '\n';
  let lines = String(quote.text || '').split('\n');
  if (!lines.length) lines = [''];
  for (const raw of lines) {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    out += '> ' + l + '\n';
  }
  return out;
}

let boundarySeq = 0;

// 2.1 reply 语义：合法 Message-ID 为 <...>、无 CR/LF、长度 ≤320；否则返回空（不伪造线程）
function validMessageId(mid) {
  const s = String(mid == null ? '' : mid).trim();
  if (!s || s.length > 320) return '';
  if (/[\r\n\0]/.test(s)) return '';
  return /^<[^<>]+>$/.test(s) ? s : '';
}

// 主题加 "Re: "（不区分大小写判断，已有 Re: 前缀则不重复加）
function withRePrefix(subject) {
  const s = String(subject == null ? '' : subject);
  return /^\s*re\s*:\s*/i.test(s) ? s : 'Re: ' + s;
}

/**
 * 组装一封完整邮件（规格 §3）。
 * opts: { fromDisplay, fromAddr, to:[], cc:[], subject, kind, body, quote, recallMid, attachments:[{name,mime,data}] }
 * 返回 { raw, msgId }：raw 是可直接交给 SMTP DATA 的字符串（CRLF 行尾），msgId 是生成的 Message-ID。
 */
function buildRawMessage(opts) {
  const o = opts || {};
  const kind = o.kind === 'email' ? 'email' : o.kind === 'recall' ? 'recall' : 'chat';
  const fromAddr = sanitizeHeader(o.fromAddr || '');
  const fromDisplay = String(o.fromDisplay || '');
  const fromHdr = fromDisplay ? `${encodeHeader(fromDisplay)} <${fromAddr}>` : fromAddr;
  const toList = (Array.isArray(o.to) ? o.to : [o.to]).map((x) => sanitizeHeader(x)).filter(Boolean);
  const ccList = (Array.isArray(o.cc) ? o.cc : []).map((x) => sanitizeHeader(x)).filter(Boolean);
  const quoteObj = o.quote && typeof o.quote === 'object' ? o.quote : null;
  // 引用 = reply：quote.mid 合法时加 In-Reply-To/References 与 Re: 前缀（2.1 规格 D）
  const replyMid = quoteObj ? validMessageId(quoteObj.mid) : '';
  let subject = sanitizeHeader(o.subject || '');
  if (replyMid) subject = withRePrefix(subject);
  const msgId = o.msgId || genMsgId();
  const headers = [];
  headers.push(`From: ${fromHdr}`);
  headers.push(`To: ${toList.length ? '<' + toList[0] + '>' : 'undisclosed-recipients:;'}`);
  // C++ 的 Cc 头是地址列表（无尖括号）
  if (ccList.length) headers.push(`Cc: ${ccList.join(', ')}`);
  headers.push(`Subject: ${encodeHeader(subject)}`);
  headers.push(`Date: ${rfc5322Now()}`);
  headers.push(`Message-ID: ${msgId}`);
  if (replyMid) {
    headers.push(`In-Reply-To: ${replyMid}`);
    headers.push(`References: ${replyMid}`);
  }
  headers.push('MIME-Version: 1.0');
  headers.push('X-Email-Chatter: 1');
  headers.push(`X-Email-Chatter-Kind: ${kind}`);
  if (quoteObj) {
    const raw = Buffer.from(JSON.stringify({
      text: String(quoteObj.text || ''),
      from: String(quoteObj.from || ''),
      ts: parseInt(quoteObj.ts, 10) || 0,
      mid: String(quoteObj.mid || ''),
    }), 'utf8').toString('base64');
    // 76 字符折行，续行以单个空格开头（规格 §3.1）
    let folded = `X-Email-Chatter-Quote: ${raw.slice(0, 76)}\r\n`;
    for (let i = 76; i < raw.length; i += 76) folded += ' ' + raw.slice(i, i + 76) + '\r\n';
    if (raw.length <= 76) folded = `X-Email-Chatter-Quote: ${raw}\r\n`;
    headers.push(folded.replace(/\r\n$/, ''));
  }
  if (o.recallMid) headers.push(`X-Email-Chatter-Recall: ${sanitizeHeader(o.recallMid)}`);
  let bodyText = String(o.body == null ? '' : o.body);
  if (kind === 'recall') bodyText = bodyText || '对方撤回了一条消息';
  else if (quoteObj) bodyText += quoteBodyBlock(quoteObj);
  const atts = Array.isArray(o.attachments) ? o.attachments : [];
  let payload;
  if (!atts.length) {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: base64');
    payload = wrapBase64(Buffer.from(bodyText, 'utf8'));
  } else {
    const boundary = '=ec_' + crypto.randomBytes(6).toString('hex') + '_' + (++boundarySeq);
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    let p = `--${boundary}\r\n` +
      'Content-Type: text/plain; charset=UTF-8\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      wrapBase64(Buffer.from(bodyText, 'utf8')) + '\r\n';
    for (const a of atts) {
      const name = fileNameParam(a.name || 'attachment');
      const mime = String(a.mime || mimeFromName(a.name) || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
      p += `--${boundary}\r\n` +
        `Content-Type: ${mime}; name="${name}"\r\n` +
        `Content-Disposition: attachment; filename="${name}"\r\n` +
        'Content-Transfer-Encoding: base64\r\n\r\n' +
        wrapBase64(Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data || '')) + '\r\n';
    }
    p += `--${boundary}--\r\n`;
    payload = p;
  }
  return { raw: headers.join('\r\n') + '\r\n\r\n' + payload, msgId };
}

// 旧接口保留（测试/兼容）：返回原始邮件字符串。
// 第 6 个参数 opts 可选，用于扩展 kind/subject/cc/quote/attachment/recall（规格 §3）。
function buildMessage(fromDisplay, fromAddr, toAddr, subject, body, opts) {
  const o = opts && typeof opts === 'object' ? opts : null;
  if (o) {
    const to = Array.isArray(o.to) ? o.to : (Array.isArray(toAddr) ? toAddr : [toAddr]);
    return buildRawMessage(Object.assign({}, o, {
      fromDisplay: o.fromDisplay !== undefined ? o.fromDisplay : fromDisplay,
      fromAddr: o.fromAddr !== undefined ? o.fromAddr : fromAddr,
      to,
      subject: o.subject !== undefined ? o.subject : subject,
      kind: o.kind || 'chat',
      body: o.body !== undefined ? o.body : body,
    })).raw;
  }
  return buildRawMessage({
    fromDisplay, fromAddr, to: Array.isArray(toAddr) ? toAddr : [toAddr], subject, kind: 'chat', body,
  }).raw;
}

// ============================== sockets ==============================

function nextChunk(sock) {
  return new Promise((resolve) => {
    const onData = (d) => { cleanup(); resolve(d); };
    const onTerm = () => { cleanup(); resolve(null); };
    function cleanup() {
      sock.removeListener('data', onData);
      sock.removeListener('end', onTerm);
      sock.removeListener('error', onTerm);
      sock.removeListener('timeout', onTerm);
    }
    sock.once('data', onData);
    sock.once('end', onTerm);
    sock.once('error', onTerm);
    sock.once('timeout', onTerm);
  });
}

class Conn {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    // 永久吞掉 socket error：连接被对端重置/超时/关闭后，若没有常驻 error 监听，
    // Node 会把 'error' 当未捕获异常抛出并结束整个进程（远程可触发的 DoS）。
    sock.on('error', () => {});
  }

  static async connect(host, port, useTls, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let sock;
      let settled = false;
      const onErr = (e) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch (err) {}
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      // servername 只对域名设置（SNI）；IP 直连不设置，避免 Node 弃用警告
      const servername = net.isIP(host) ? undefined : host;
      if (useTls) sock = tls.connect({ host, port, servername, rejectUnauthorized: true });
      else sock = net.connect({ host, port });
      sock.setTimeout(timeoutMs);
      // 原实现只监听 error：SYN 被防火墙 DROP / 黑洞路由时不会报 error，
      // timeout 事件无人处理 → promise 永不 resolve（probe 按钮永远转圈）。
      // 这里把 timeout 也当作失败，并显式 reject，保证任何路径都有结果。
      sock.once('timeout', () => onErr(new Error(`连接超时（${timeoutMs}ms 未建立连接）`)));
      sock.once('error', onErr);
      const onReady = () => {
        if (settled) return;
        settled = true;
        sock.removeListener('error', onErr);
        sock.removeListener('timeout', onErr);
        sock.setTimeout(20000);
        resolve(new Conn(sock));
      };
      if (useTls) sock.once('secureConnect', onReady); else sock.once('connect', onReady);
    });
  }

  // 尝试从当前连接升级到 TLS（SMTP STARTTLS / POP3 STLS / IMAP STARTTLS）。
  // 复用同一 socket，握手失败时抛出错误。
  async starttls(host) {
    return new Promise((resolve, reject) => {
      const servername = net.isIP(host) ? undefined : host;
      const tlsSock = tls.connect({ host, socket: this.sock, servername, rejectUnauthorized: true });
      let done = false;
      const onErr = (e) => { if (!done) { done = true; reject(e instanceof Error ? e : new Error(String(e))); } };
      tlsSock.once('error', onErr);
      tlsSock.once('secureConnect', () => {
        if (done) return;
        done = true;
        tlsSock.removeListener('error', onErr);
        tlsSock.setTimeout(20000);
        resolve(new Conn(tlsSock));
      });
    });
  }

  write(s) {
    return new Promise((resolve, reject) => {
      this.sock.write(s, (e) => (e ? reject(new Error('write: ' + e.message)) : resolve()));
    });
  }

  async readLine() {
    for (;;) {
      const i = this.buf.indexOf(0x0a);
      if (i >= 0) {
        let line = this.buf.subarray(0, i);
        this.buf = this.buf.subarray(i + 1);
        if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        return line.toString('latin1');
      }
      const c = await nextChunk(this.sock);
      if (c === null) return null;
      this.buf = Buffer.concat([this.buf, c]);
    }
  }

  async readExact(n) {
    while (this.buf.length < n) {
      const c = await nextChunk(this.sock);
      if (c === null) return null;
      this.buf = Buffer.concat([this.buf, c]);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  end() { try { this.sock.end(); } catch (e) {} }
  destroy() { try { this.sock.destroy(); } catch (e) {} }
}

// ============================== SMTP ==============================

async function smtpResponse(conn) {
  let line = await conn.readLine();
  if (line === null) throw new Error('SMTP 无响应');
  const code = parseInt(line.slice(0, 3), 10) || 0;
  let text = line;
  while (line.length >= 4 && line[3] === '-') {
    line = await conn.readLine();
    if (line === null) break;
    text += '\n' + line;
  }
  return { code, text };
}

// TLS 失败原因判断：Node 的 tls 错误带 ERR_SSL_*/CERT_* 等 code，
// 网络层失败带 ECONNREFUSED/ETIMEDOUT 等。只有 TLS 层失败才值得回退明文。
function tlsLayerFailure(e) {
  const c = e && e.code || '';
  const msg = String(e && e.message || '');
  if (/^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNRESET|EPIPE|EADDRNOTAVAIL)$/.test(c)) return false;
  if (/^(ERR_SSL|ERR_TLS|CERT|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH|UNABLE_TO_VERIFY|ERR_OSSL)/.test(c)) return true;
  return /ssl|tls|certificate|handshake|wrong version|self signed/i.test(msg);
}

// 建立 SMTP 连接；配置成 SSL 但握手失败时（典型：587 明文端口误勾 SSL）
// 自动回退明文连接，由 STARTTLS 升级，保证功能可用且不降安全。
async function smtpConn(cfg, timeoutMs = 20000) {
  const effective = Object.assign({}, cfg);
  try {
    const conn = await Conn.connect(cfg.host, cfg.port, !!cfg.ssl, timeoutMs);
    return { conn, effective };
  } catch (e) {
    if (cfg.ssl && tlsLayerFailure(e)) {
      effective.ssl = false;
      const conn = await Conn.connect(cfg.host, cfg.port, false, timeoutMs);
      return { conn, effective };
    }
    throw e;
  }
}

async function smtpHandshake(cfg, conn) {
  const g = await conn.readLine();
  if (g === null || !g.startsWith('220')) throw new Error('SMTP 问候失败: ' + g);
  await conn.write('EHLO email-chatter.local\r\n');
  let r = await smtpResponse(conn);
  if (r.code !== 250) throw new Error('SMTP EHLO 失败');
  // SSL 未启用（直连或回退）时：若服务器通告 STARTTLS 则升级加密后再认证
  if (!cfg.ssl && /STARTTLS/i.test(r.text)) {
    await conn.write('STARTTLS\r\n');
    r = await smtpResponse(conn);
    if (r.code === 220) conn = await conn.starttls(cfg.host);
    // 升级成功后再 EHLO（RFC 3207：TLS 后必须重新 EHLO）
    if (r.code === 220) {
      await conn.write('EHLO email-chatter.local\r\n');
      r = await smtpResponse(conn);
      if (r.code !== 250) throw new Error('SMTP 升级 TLS 后的 EHLO 失败');
    }
  }
  await conn.write('AUTH LOGIN\r\n');
  r = await smtpResponse(conn);
  if (r.code === 334) {
    await conn.write(b64(cfg.user) + '\r\n');
    r = await smtpResponse(conn);
    if (r.code === 334) {
      await conn.write(b64(cfg.pass) + '\r\n');
      r = await smtpResponse(conn);
    }
  }
  if (r.code !== 235) {
    await conn.write('AUTH PLAIN ' + b64('\0' + cfg.user + '\0' + cfg.pass) + '\r\n');
    r = await smtpResponse(conn);
  }
  if (r.code !== 235) throw new Error('SMTP 认证失败（请检查邮箱地址与客户端授权密码）');
}

// 发送任意原始邮件到多个收件人（规格 §3.3）：信封收件人可为 to+cc+bcc。
async function smtpSendRaw(cfg, rcpts, raw) {
  if (!cfg.host) throw new Error('SMTP 服务器未配置');
  const list = (Array.isArray(rcpts) ? rcpts : [rcpts]).map((x) => trim(x)).filter(Boolean);
  if (!list.length) throw new Error('收件人为空');
  const { conn, effective } = await smtpConn(cfg);
  try {
    await smtpHandshake(effective, conn);
    const from = cfg.from_addr || cfg.user;
    await conn.write(`MAIL FROM:<${sanitizeHeader(from)}>\r\n`);
    let r = await smtpResponse(conn);
    if (r.code !== 250) throw new Error('SMTP MAIL FROM 被拒绝');
    for (const rcpt of list) {
      await conn.write(`RCPT TO:<${sanitizeHeader(rcpt)}>\r\n`);
      r = await smtpResponse(conn);
      if (r.code !== 250 && r.code !== 251) throw new Error('SMTP RCPT TO 被拒绝: ' + rcpt);
    }
    await conn.write('DATA\r\n');
    r = await smtpResponse(conn);
    if (r.code !== 354) throw new Error('SMTP DATA 未接受');
    const msg = String(raw || '');
    let data = '';
    for (const line of msg.split('\n')) {
      let l = line.replace(/\r$/, '');
      if (l.startsWith('.')) l = '.' + l;
      data += l + '\r\n';
    }
    data += '.\r\n';
    await conn.write(data);
    r = await smtpResponse(conn);
    if (r.code !== 250) throw new Error('SMTP 邮件未被服务器接受: ' + r.text.replace(/\n/g, ' / '));
  } finally {
    conn.end();
  }
}

// 旧接口保留：单收件人 + 旧固定格式正文
async function smtpSend(cfg, toAddr, subject, body) {
  const raw = buildMessage(cfg.display_name, cfg.from_addr || cfg.user, toAddr, subject, body);
  await smtpSendRaw(cfg, [toAddr], raw);
}

async function smtpTest(cfg) {
  if (!cfg.host) throw new Error('SMTP 服务器未配置');
  const { conn, effective } = await smtpConn(cfg, 15000);
  try {
    await smtpHandshake(effective, conn);
  } finally {
    conn.end();
  }
}

// ============================== POP3 ==============================

async function pop3Ok(conn) {
  const line = await conn.readLine();
  if (line === null || !line.startsWith('+OK')) throw new Error('POP3 认证失败（请检查邮箱地址与客户端授权密码）');
  return line;
}

async function pop3Conn(cfg, timeoutMs = 20000) {
  const effective = Object.assign({}, cfg);
  try {
    const conn = await Conn.connect(cfg.host, cfg.port, !!cfg.ssl, timeoutMs);
    return { conn, effective };
  } catch (e) {
    if (cfg.ssl && tlsLayerFailure(e)) {
      effective.ssl = false;
      const conn = await Conn.connect(cfg.host, cfg.port, false, timeoutMs);
      return { conn, effective };
    }
    throw e;
  }
}

// POP3 STLS：服务器通告后升级加密（110 端口常用）
async function pop3MaybeStartTls(conn, effective) {
  if (effective.ssl) return conn;
  await conn.write('CAPA\r\n');
  const first = await conn.readLine();
  if (first !== null && first.startsWith('+OK')) {
    let hasStls = false;
    for (;;) {
      const l = await conn.readLine();
      if (l === null) break;
      if (l === '.') break;
      if (/^STLS\b/i.test(l)) hasStls = true;
    }
    if (hasStls) {
      await conn.write('STLS\r\n');
      const l = await conn.readLine();
      if (l !== null && l.startsWith('+OK')) {
        return await conn.starttls(effective.host);
      }
    }
  }
  return conn;
}

// 单封邮件解析上限 50MB（与 IMAP / C++ 语义一致）：超过则跳过解析，避免内存/CPU 炸弹
const MAX_MAIL_BYTES = 50 * 1024 * 1024;

async function pop3Fetch(cfg, seen, maxNew = 300) {
  if (!cfg.host) throw new Error('POP3 服务器未配置');
  const res = { messages: [], newKeys: [] };
  const { conn: c0, effective } = await pop3Conn(cfg);
  let conn = c0;
  try {
    await pop3Ok(conn);
    conn = await pop3MaybeStartTls(conn, effective);
    await conn.write('USER ' + sanitizeHeader(effective.user) + '\r\n');
    await pop3Ok(conn);
    await conn.write('PASS ' + sanitizeHeader(effective.pass) + '\r\n');
    await pop3Ok(conn);
    await conn.write('UIDL\r\n');
    const first = await conn.readLine();
    if (first === null || !first.startsWith('+OK')) throw new Error('POP3 不支持 UIDL');
    const uidl = [];
    for (;;) {
      const line = await conn.readLine();
      if (line === null) throw new Error('POP3 UIDL 读取中断');
      if (line === '.') break;
      const p = line.split(' ');
      if (p.length >= 2) uidl.push([p[0], p[1]]);
    }
    for (const [idx, uid] of uidl) {
      if (seen.has(uid)) continue;
      if (res.messages.length >= maxNew) break;  // 单轮上限，剩余的下一轮再取
      await conn.write('RETR ' + idx + '\r\n');
      const line = await conn.readLine();
      if (line === null || !line.startsWith('+OK')) continue;
      // 逐行收集到数组，最后一次性 concat（旧实现每行 Buffer.concat 是 O(n²)：4MB 邮件 ~33s，review H3）
      const chunks = [];
      let total = 0;
      let tooLarge = false;
      for (;;) {
        const l = await conn.readLine();
        if (l === null) throw new Error('POP3 RETR 读取中断');
        if (l === '.') break;
        const line2 = l.startsWith('.') ? l.slice(1) : l;  // 去点转义
        total += line2.length + 2;
        if (tooLarge) continue;  // 继续消费余下行直到结束标记，保持协议同步
        if (total > MAX_MAIL_BYTES) {
          tooLarge = true;
          chunks.length = 0;     // 释放已收集内存
          continue;
        }
        chunks.push(Buffer.from(line2 + '\r\n', 'latin1'));
      }
      if (tooLarge) {
        res.newKeys.push(uid);  // 跳过单封 >50MB 的邮件，但记 seen 防止每轮重复拉取
        continue;
      }
      res.messages.push(parseMessage(Buffer.concat(chunks)));
      res.newKeys.push(uid);
    }
  } finally {
    conn.end();
  }
  return res;
}

async function pop3Test(cfg) {
  if (!cfg.host) throw new Error('POP3 服务器未配置');
  const { conn: c0, effective } = await pop3Conn(cfg, 15000);
  let conn = c0;
  try {
    await pop3Ok(conn);
    conn = await pop3MaybeStartTls(conn, effective);
    await conn.write('USER ' + sanitizeHeader(effective.user) + '\r\n');
    await pop3Ok(conn);
    await conn.write('PASS ' + sanitizeHeader(effective.pass) + '\r\n');
    await pop3Ok(conn);
  } finally {
    conn.end();
  }
}

// ============================== IMAP ==============================

async function imapReadUntil(conn, tag) {
  const untagged = [];
  for (;;) {
    const line = await conn.readLine();
    if (line === null) return { status: 'FAIL', untagged };
    if (line.startsWith(tag + ' ')) {
      const p = line.split(' ');
      return { status: p[1] || 'OK', untagged };
    }
    untagged.push(line);
  }
}

async function imapConn(cfg, timeoutMs = 20000) {
  const effective = Object.assign({}, cfg);
  try {
    const conn = await Conn.connect(cfg.host, cfg.port, !!cfg.ssl, timeoutMs);
    return { conn, effective };
  } catch (e) {
    if (cfg.ssl && tlsLayerFailure(e)) {
      effective.ssl = false;
      const conn = await Conn.connect(cfg.host, cfg.port, false, timeoutMs);
      return { conn, effective };
    }
    throw e;
  }
}

// IMAP STARTTLS：明文连接（143 等）时若服务器通告 STARTTLS 则升级加密
async function imapMaybeStartTls(conn, effective) {
  if (effective.ssl) return conn;
  await conn.write('a0 CAPABILITY\r\n');
  const r = await imapReadUntil(conn, 'a0');
  const hasStartTls = r.untagged.some((l) => /STARTTLS\b/i.test(l));
  if (hasStartTls) {
    await conn.write('a0 STARTTLS\r\n');
    const r2 = await imapReadUntil(conn, 'a0');
    if (r2.status === 'OK') return await conn.starttls(effective.host);
  }
  return conn;
}

// 只读拉取：BODY.PEEK[] 不会让服务器自动置 \Seen（RFC822/BODY[] 会），见 2.1 规格 A.1
async function imapFetchOne(conn, tag, uid) {
  await conn.write(`${tag} UID FETCH ${uid} (BODY.PEEK[])\r\n`);
  let raw = null;
  let skipped = false;
  for (;;) {
    const line = await conn.readLine();
    if (line === null) return null;
    if (line.startsWith(tag + ' ')) {
      if (p1IsOk(line) && raw) return raw;
      if (skipped) return { skipped: true };  // 单封 >50MB：忽略正文但保持协议同步（绝不 STORE）
      return null;
    }
    // 兼容 BODY[]/{n} / BODY.PEEK[]/{n} / RFC822/{n} 的 literal 公告
    const m = line.match(/\{(\d+)\}/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n < MAX_MAIL_BYTES) {
        const buf = await conn.readExact(n);
        if (!buf) return null;
        raw = buf;
      } else if (n >= MAX_MAIL_BYTES) {
        skipped = true;  // 不读入内存，后续行被逐行消费直到 tagged OK
      }
    }
  }
}

function p1IsOk(line) {
  const p = line.split(' ');
  return p[1] === 'OK';
}

async function imapFetch(cfg, seen, maxNew = 300, markSeenUids) {
  if (!cfg.host) throw new Error('IMAP 服务器未配置');
  const res = { messages: [], newKeys: [] };
  const { conn: c0, effective } = await imapConn(cfg);
  let conn = c0;
  try {
    const g = await conn.readLine();
    if (g === null || !g.startsWith('* OK')) throw new Error('IMAP 问候失败');
    conn = await imapMaybeStartTls(conn, effective);
    await conn.write('a0 ID ("name" "email-chatter" "version" "1.0" "vendor" "email-chatter")\r\n');
    await imapReadUntil(conn, 'a0');
    await conn.write(`a1 LOGIN "${(effective.user || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" "${(effective.pass || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\r\n`);
    let r = await imapReadUntil(conn, 'a1');
    if (r.status !== 'OK') throw new Error('IMAP 认证失败（请检查邮箱地址与客户端授权密码）');
    await conn.write('a2 SELECT INBOX\r\n');
    r = await imapReadUntil(conn, 'a2');
    if (r.status !== 'OK') throw new Error('IMAP 打开收件箱失败');
    // 2.1：用户在聊天里打开过的会话，才把对应邮件批量标为已读（每 ~50 个 uid 一条 UID STORE）。
    // 成功才从 pending 移除；失败保留，下次轮询重试。非好友/超限邮件从不 STORE。
    if (markSeenUids && typeof markSeenUids.delete === 'function') {
      const pending = [];
      for (const u of markSeenUids) if (/^\d+$/.test(String(u))) pending.push(String(u));
      for (let i = 0; i < pending.length; i += 50) {
        const batch = pending.slice(i, i + 50);
        const tag = 's' + (i / 50);
        await conn.write(`${tag} UID STORE ${batch.join(',')} +FLAGS.SILENT (\\Seen)\r\n`);
        const sr = await imapReadUntil(conn, tag);
        if (sr.status === 'OK') { for (const u of batch) markSeenUids.delete(u); }
      }
    }
    // 用 UID SEARCH 而不是 SEARCH：返回稳定 UID，避免邮箱压缩后序号漂移导致误标/漏拉。
    // 注意不带 CHARSET 参数：网易 Coremail 对带 CHARSET 的 UID SEARCH 返回 BAD。
    await conn.write('a3 UID SEARCH UNSEEN\r\n');
    r = await imapReadUntil(conn, 'a3');
    if (r.status !== 'OK') throw new Error('IMAP 搜索未读邮件失败');
    const uids = [];
    for (const l of r.untagged) {
      if (l.startsWith('* SEARCH')) {
        for (const tok of l.split(' ').slice(2)) if (/^\d+$/.test(tok)) uids.push(parseInt(tok, 10));
      }
    }
    for (const uid of uids) {
      const key = String(uid);
      if (seen.has(key)) continue;
      if (res.messages.length >= maxNew) break;  // 单轮上限，剩余的下一轮再取
      const got = await imapFetchOne(conn, 'a4', uid);
      if (!got) continue;
      if (got.skipped) {
        // 单封 >50MB：跳过解析但本地记 seen，避免每轮重复拉取；不 STORE（邮箱保持未读）
        res.newKeys.push(key);
        continue;
      }
      const msg = parseMessage(got);
      msg.uid = key;  // 2.1：记录 IMAP UID（打开会话时用于批量标已读）
      res.messages.push(msg);
      res.newKeys.push(key);
    }
    await conn.write('a6 LOGOUT\r\n');
  } finally {
    conn.destroy();
  }
  return res;
}

async function imapTest(cfg) {
  if (!cfg.host) throw new Error('IMAP 服务器未配置');
  const { conn: c0, effective } = await imapConn(cfg, 15000);
  let conn = c0;
  try {
    const g = await conn.readLine();
    if (g === null || !g.startsWith('* OK')) throw new Error('IMAP 问候失败');
    conn = await imapMaybeStartTls(conn, effective);
    await conn.write('a0 ID ("name" "email-chatter" "version" "1.0" "vendor" "email-chatter")\r\n');
    await imapReadUntil(conn, 'a0');
    await conn.write(`a1 LOGIN "${(effective.user || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" "${(effective.pass || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\r\n`);
    const r = await imapReadUntil(conn, 'a1');
    if (r.status !== 'OK') throw new Error('IMAP 认证失败');
    await conn.write('a2 LOGOUT\r\n');
  } finally {
    conn.destroy();
  }
}

// 仅连接并读问候语（不登录），用于「自动检测服务器」
async function probeGreeting(host, port, useTls) {
  if (!host || !port) return { ok: false, error: '主机或端口为空' };
  let conn = null;
  try {
    conn = await Conn.connect(host, port, !!useTls, 6000);
    // 读问候语也加 6 秒上限：有些服务器连接后不说话（静默挂起），
    // 若只依赖 socket 级 20 秒超时，probe 会显得很慢。
    const line = await Promise.race([
      conn.readLine(),
      new Promise((res) => setTimeout(() => res(null), 6000)),
    ]);
    if (line === null) return { ok: false, error: '已连接但服务器无响应' };
    return { ok: true, greeting: line };
  } catch (e) {
    return { ok: false, error: '连接失败（端口不通 / 被防火墙拦截 / 主机名错误）：' + (e && e.message || e) };
  } finally {
    if (conn) conn.destroy();
  }
}

// ============================== Store ==============================

// AI 标题配置默认值（data/config.json 的 ai 对象；规格 §2.1）
const DEFAULT_AI = () => ({
  enabled: false,
  mirror: 'https://hf-mirror.com',
  model_url: '',
  model_file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
});

function normalizeAiConfig(raw) {
  const d = DEFAULT_AI();
  if (!raw || typeof raw !== 'object') return d;
  const modelFile = typeof raw.model_file === 'string' ? sanitizeDisplayName(raw.model_file, 120, '') : '';
  return {
    enabled: raw.enabled === true,
    mirror: typeof raw.mirror === 'string' && trim(raw.mirror) ? trim(raw.mirror) : d.mirror,
    model_url: typeof raw.model_url === 'string' ? trim(raw.model_url) : '',
    model_file: modelFile || d.model_file,
  };
}

const DEFAULT_ACCOUNT = () => ({
  email: '', display_name: '', password: '', mode: 'imap', poll_interval: 8, auto_poll: true,
  imap: { host: '', port: 993, ssl: true },
  pop3: { host: '', port: 995, ssl: true },
  smtp: { host: '', port: 465, ssl: true },
  ai: DEFAULT_AI(),
});

// /api/messages 返回的 message 对象（补默认值 + time/url，旧数据无新字段也能读）
function normalizeMessage(m) {
  const kind = m.kind === 'email' ? 'email' : 'chat';
  const ts = parseInt(m.ts, 10) || 0;
  const out = {
    id: m.id,
    dir: m.dir === 'out' ? 'out' : 'in',
    kind,
    text: String(m.text == null ? '' : m.text),
    ts,
    time: fmtTime(ts),
    recalled: m.recalled === true,
  };
  const subject = trim(m.subject || '');
  if (subject) out.subject = subject;
  const mid = trim(m.mid || '');
  if (mid) out.mid = mid;
  const uid = trim(m.uid || '');
  if (uid) out.uid = uid;  // 2.1：IMAP UID（POP3/旧数据缺省）
  if (m.quote && typeof m.quote === 'object') {
    out.quote = {
      text: truncate(String(m.quote.text || ''), 500),
      from: String(m.quote.from || ''),
      ts: parseInt(m.quote.ts, 10) || 0,
      mid: String(m.quote.mid || ''),
    };
  }
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  if (atts.length) {
    out.attachments = atts.map((a) => {
      const file = String(a.file || '');
      const mime = String(a.mime || mimeFromName(a.name) || 'application/octet-stream');
      return {
        name: String(a.name || ''),
        mime,
        size: parseInt(a.size, 10) || 0,
        file,
        url: file ? '/api/attachment?file=' + encodeURIComponent(file) : '',
        inline: a.inline !== undefined ? a.inline === true : isImageMime(mime),
      };
    });
  }
  return out;
}

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.cfgPath = path.join(dataDir, 'config.json');
    this.msgPath = path.join(dataDir, 'messages.json');
    this.account = DEFAULT_ACCOUNT();
    this.friends = [];
    this.conversations = {};
    this.unread = {};
    this.seenPop3 = new Set();
    this.seenImap = new Set();
    this.pendingRecalls = new Set();
    this.nextMsgId = 1;
  }

  load() {
    if (fs.existsSync(this.cfgPath)) {
      try {
        const c = JSON.parse(fs.readFileSync(this.cfgPath, 'utf8'));
        const a = this.account;
        a.email = lower(trim(c.email || ''));
        a.display_name = String(c.display_name || '');
        a.password = String(c.password || '');
        a.mode = c.mode === 'pop3' ? 'pop3' : 'imap';
        a.poll_interval = Math.max(3, parseInt(c.poll_interval, 10) || 8);
        a.auto_poll = c.auto_poll !== false;
        if (c.imap) a.imap = normalizeServer(a.imap, c.imap, 993);
        if (c.pop3) a.pop3 = normalizeServer(a.pop3, c.pop3, 995);
        if (c.smtp) a.smtp = normalizeServer(a.smtp, c.smtp, 465);
        a.ai = normalizeAiConfig(c.ai);
        if (Array.isArray(c.friends)) this.friends = c.friends.filter((f) => f && f.email);
        if (Array.isArray(c.seen_pop3)) this.seenPop3 = new Set(c.seen_pop3);
        if (Array.isArray(c.seen_imap)) this.seenImap = new Set(c.seen_imap);
        if (Array.isArray(c.pending_recalls)) {
          this.pendingRecalls = new Set(c.pending_recalls.filter((x) => typeof x === 'string' && x));
        }
        if (c.unread && typeof c.unread === 'object') this.unread = c.unread;
        this.nextMsgId = parseInt(c.next_msg_id, 10) || 1;
      } catch (e) {
        console.error('[email-chatter] config load error:', e.message);
      }
    }
    if (fs.existsSync(this.msgPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(this.msgPath, 'utf8'));
        if (m.conversations && typeof m.conversations === 'object') this.conversations = m.conversations;
      } catch (e) {
        console.error('[email-chatter] messages load error:', e.message);
      }
    }
  }

  saveConfig() {
    const c = {
      email: this.account.email,
      display_name: this.account.display_name,
      password: this.account.password,
      mode: this.account.mode,
      poll_interval: this.account.poll_interval,
      auto_poll: this.account.auto_poll !== false,
      imap: this.account.imap,
      pop3: this.account.pop3,
      smtp: this.account.smtp,
      ai: this.account.ai,
      friends: this.friends,
      seen_pop3: [...this.seenPop3],
      seen_imap: [...this.seenImap],
      pending_recalls: [...this.pendingRecalls],
      unread: this.unread,
      next_msg_id: this.nextMsgId,
    };
    this._write(this.cfgPath, JSON.stringify(c));
  }

  saveMessages() {
    this._write(this.msgPath, JSON.stringify({ conversations: this.conversations }));
  }

  _write(p, data) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, p);
    } catch (e) {
      console.error('[email-chatter] save failed:', p, e.message);
    }
  }

  isFriend(email) { return !!this.findFriend(email); }
  findFriend(email) {
    const e = lower(trim(email));
    return this.friends.find((f) => f.email === e);
  }
  friendName(email) {
    const f = this.findFriend(email);
    return f && f.name ? f.name : email;
  }
  addFriend(email, name, note) {
    const e = lower(trim(email));
    if (!e || e.indexOf('@') < 0) return false;
    const ex = this.findFriend(e);
    if (ex) {
      if (name) ex.name = name;
      if (note) ex.note = note;
      return true;
    }
    this.friends.push({ email: e, name: name || '', note: note || '', added_at: now() });
    return true;
  }
  removeFriend(email) {
    const e = lower(trim(email));
    const i = this.friends.findIndex((f) => f.email === e);
    if (i < 0) return false;
    this.friends.splice(i, 1);
    delete this.conversations[e];
    delete this.unread[e];
    return true;
  }

  /*
   * 追加消息。extra（可选）：{kind, subject, quote, attachments, recalled}
   *  - chat 正文上限 4000 字符，email 16000（按字符截断，规格 §2）；
   *  - 有附件时正文可为空串（不要用 "(空消息)" 覆盖附件消息）；
   *  - dir=in 时按 Message-ID 去重；撤回通知命中的邮件由 pollOnce 直接丢弃。
   * 返回写入的 message 对象；重复消息返回 false。
   */
  addMessage(peer, dir, text, ts, mid, extra) {
    const ex = extra || {};
    const kind = ex.kind === 'email' ? 'email' : 'chat';
    const limit = kind === 'email' ? 16000 : 4000;
    const atts = Array.isArray(ex.attachments) ? ex.attachments : [];
    const hasQuote = !!(ex.quote && typeof ex.quote === 'object' && (ex.quote.text || ex.quote.mid || ex.quote.from));
    // 收件按 Message-ID 去重：seen 表清空/损坏/换机重拉时，同一封邮件不重复进对话
    if (dir === 'in' && mid) {
      const conv0 = this.conversations[peer] || [];
      for (const m of conv0) if (m.dir === 'in' && m.mid === mid) return false;
      // 已被撤回：今后收到该 mid 的来信直接丢弃（规格 §4.4）
      if (this.pendingRecalls.has(String(mid))) return false;
    }
    let t = truncate(trim(text), limit);
    // 附件/引用消息允许正文为空（不要用 "(空消息)" 覆盖附件消息）
    if (!t && !atts.length && !hasQuote) t = '(空消息)';
    const msg = {
      id: this.nextMsgId++,
      dir,
      kind,
      text: t,
      ts: ts > 0 ? ts : now(),
      recalled: ex.recalled === true,
    };
    const subject = truncate(sanitizeHeader(ex.subject || ''), 200);
    if (subject) msg.subject = subject;
    if (mid) msg.mid = String(mid);
    // 2.1：IMAP 收件记录 UID（打开会话时用于批量标已读）
    if (ex.uid) msg.uid = String(ex.uid);
    if (hasQuote) {
      msg.quote = {
        text: truncate(String(ex.quote.text || ''), 500),
        from: String(ex.quote.from || ''),
        ts: parseInt(ex.quote.ts, 10) || 0,
        mid: String(ex.quote.mid || ''),
      };
    }
    if (atts.length) msg.attachments = atts;
    if (!this.conversations[peer]) this.conversations[peer] = [];
    const conv = this.conversations[peer];
    conv.push(msg);
    if (conv.length > 300) conv.splice(0, conv.length - 300);
    return msg;
  }

  // 好友列表预览（规格 §2 last_text 规则）
  lastText(peer) {
    const c = this.conversations[peer];
    if (!c || !c.length) return '';
    const m = c[c.length - 1];
    if (m.recalled) return '[已撤回]';
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    if (atts.some((a) => isImageMime(a.mime) || a.inline === true)) return '[图片]';
    if (atts.length) return '[文件] ' + (atts[0].name || '');
    if (m.kind === 'email') {
      const sub = trim(m.subject || '');
      if (sub) return sub;
    }
    const t = String(m.text || '');
    const first = t.split('\n')[0].trim();
    return first || t;
  }
  lastTs(peer) {
    const c = this.conversations[peer];
    return c && c.length ? c[c.length - 1].ts : 0;
  }
}

// ============================== App ==============================

/*
 * 懒加载 AI 模块（electron/ai.js，node-ai 提供，接口见规格 §6.5）。
 * 文件暂时缺失/写坏时返回 null，AI 相关接口优雅回落到启发式标题，不影响其余功能；
 * 每 5 秒重试一次，便于开发期热接入。
 */
let aiModuleCache;
let aiModuleNextTry = 0;
function getAiModule() {
  if (aiModuleCache) return aiModuleCache;
  const t = Date.now();
  if (t < aiModuleNextTry) return null;
  aiModuleNextTry = t + 5000;
  try {
    const m = require(path.join(__dirname, 'ai.js'));
    if (m && typeof m === 'object' && typeof m.status === 'function') aiModuleCache = m;
  } catch (e) {
    aiModuleCache = null;
  }
  return aiModuleCache || null;
}

class App {
  constructor(dataDir, webDir) {
    this.store = new Store(dataDir);
    this.webDir = webDir;
    this.pollStatus = { last_ts: 0, ok: false, error: '', fetched: 0, skipped: 0 };
    this.pollTimer = null;
    this.polling = false;
    this.forcePoll = false;
    this.running = false;
    this.uploads = new Map();  // /api/upload 暂存元数据（内存 map，规格 §4.2）
    // 2.1：待批量标已读的 IMAP UID（用户在聊天里打开会话时收集，下次轮询批量 UID STORE）
    this.pendingSeenImap = new Set();
    this.aiInited = false;
    this.aiSig = '';
  }

  // 启动时建目录（data/attachments、data/uploads、data/models）并清理过期暂存文件（规格 §7）
  initAssets() {
    const dir = this.store.dir;
    for (const sub of ['attachments', 'uploads', 'models']) {
      try { fs.mkdirSync(path.join(dir, sub), { recursive: true }); } catch (e) {
        console.error('[email-chatter] mkdir failed:', sub, e.message);
      }
    }
    this.cleanUploads();
    this.ensureAi();
  }

  cleanUploads() {
    const upDir = path.join(this.store.dir, 'uploads');
    let names = [];
    try { names = fs.readdirSync(upDir); } catch (e) { return; }
    const cutoff = now() - 24 * 3600;
    for (const n of names) {
      const p = path.join(upDir, n);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs / 1000 < cutoff) fs.unlinkSync(p);
      } catch (e) { /* ignore */ }
    }
  }

  // ---------------- AI（规格 §4.6 / §6.5）----------------

  ensureAi() {
    const m = getAiModule();
    if (!m) return null;
    const cfg = this.store.account.ai;
    if (!this.aiInited) {
      try { if (typeof m.init === 'function') m.init(this.store.dir); } catch (e) {
        console.error('[email-chatter] ai init failed:', e && e.message || e);
      }
      this.aiInited = true;
      this.aiSig = '';
    }
    const sig = JSON.stringify(cfg);
    if (this.aiSig !== sig) {
      try {
        if (typeof m.setConfig === 'function') {
          m.setConfig({
            enabled: !!cfg.enabled, mirror: cfg.mirror,
            model_url: cfg.model_url, model_file: cfg.model_file,
          });
        }
      } catch (e) {
        console.error('[email-chatter] ai setConfig failed:', e && e.message || e);
      }
      this.aiSig = sig;
    }
    return m;
  }

  // /api/state 顶层 ai、/api/ai/status 的 ai 字段（规格 §4.6，字段齐全）
  aiStatus() {
    const cfg = this.store.account.ai;
    const m = this.ensureAi();
    const out = {
      enabled: !!cfg.enabled,
      model_ready: false,
      downloading: false,
      downloaded_bytes: 0,
      total_bytes: 0,
      percent: 0,
      error: '',
      model_file: cfg.model_file,
      mirror: cfg.mirror,
      busy: false,
      engine: String(cfg.model_file || '').replace(/\.gguf$/i, ''),
    };
    if (m) {
      let s = null;
      try { s = m.status(); } catch (e) { out.error = String(e && e.message || e); }
      if (s && typeof s === 'object') {
        const keys = ['enabled', 'model_ready', 'downloading', 'downloaded_bytes', 'total_bytes',
          'percent', 'error', 'model_file', 'mirror', 'busy', 'engine'];
        for (const k of keys) if (s[k] !== undefined && s[k] !== null) out[k] = s[k];
      }
    }
    // 以 config.json 的 ai 配置为准（enabled/mirror/model_file 展示一致）
    out.enabled = !!cfg.enabled;
    out.mirror = cfg.mirror || out.mirror;
    out.model_file = cfg.model_file || out.model_file;
    if (!m) out.error = out.error || 'AI 模块不可用';
    const total = Number(out.total_bytes) || 0;
    const got = Number(out.downloaded_bytes) || 0;
    out.percent = total > 0 ? Math.max(0, Math.min(100, Math.round((got * 100) / total))) : (out.model_ready ? 100 : 0);
    return out;
  }

  // 启发式标题优先用 ai.js 的实现（C++/Node 一致），模块缺失时用本地等价实现
  heuristicTitle(text) {
    const m = getAiModule();
    if (m && typeof m.heuristicTitle === 'function') {
      try {
        const s = m.heuristicTitle(String(text || ''));
        if (typeof s === 'string' && s) return s;
      } catch (e) { /* fall through */ }
    }
    return heuristicTitle(text);
  }

  /*
   * 生成标题（供 /api/send 与 /api/ai/title 使用），永不抛错：
   * 返回 {title, source:'ai'|'heuristic', note, ai:boolean}。
   */
  async generateAiTitle(text) {
    const cfg = this.store.account.ai;
    const src = String(text == null ? '' : text);
    if (!trim(src)) return { title: '无主题', source: 'heuristic', note: '', ai: false };
    const st = this.aiStatus();
    const m = this.ensureAi();
    const canAi = !!cfg.enabled && !!st.model_ready && !!m && typeof m.generateTitle === 'function';
    if (!canAi) {
      let note = '';
      if (!cfg.enabled) note = 'AI 标题未启用';
      else if (!st.model_ready) note = st.error || 'AI 模型未下载';
      else note = 'AI 模块不可用';
      return { title: this.heuristicTitle(src), source: 'heuristic', note, ai: false };
    }
    try {
      const r = await withTimeout(Promise.resolve(m.generateTitle(truncate(src, 600))), 180000);
      if (typeof r === 'string') {
        const t = trim(r);
        return t ? { title: t, source: 'ai', note: '', ai: true } : { title: this.heuristicTitle(src), source: 'heuristic', note: 'AI 返回空标题', ai: false };
      }
      if (r && typeof r === 'object') {
        const title = trim(String(r.title || r.subject || ''));
        const source = r.source === 'heuristic' ? 'heuristic' : 'ai';
        const note = String(r.note || '');
        if (title) return { title, source, note, ai: source === 'ai' };
        return { title: this.heuristicTitle(src), source: 'heuristic', note: note || 'AI 返回空标题', ai: false };
      }
      return { title: this.heuristicTitle(src), source: 'heuristic', note: 'AI 无返回', ai: false };
    } catch (e) {
      return { title: this.heuristicTitle(src), source: 'heuristic', note: 'AI 生成失败: ' + (e && e.message || e), ai: false };
    }
  }

  start(port) {
    this.running = true;
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((e) => {
          console.error('[email-chatter] request failed:', e && e.message || e);
          if (!res.headersSent) this.sendJson(res, jsonErr('内部错误: ' + (e && e.message || e)), 500);
          else { try { res.end(); } catch (err) { /* ignore */ } }
        });
      });
      this.server.on('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        const p = this.server.address().port;
        this.port = p;
        this.schedulePoll();
        resolve(p);
      });
    });
  }

  stop() {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.server) this.server.close();
  }

  schedulePoll() {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const autoPoll = this.store.account.auto_poll !== false;
    const iv = Math.max(3, this.store.account.poll_interval || 8) * 1000;
    // 关闭自动收信时，不再定时轮询；只在本机「立即收信」触发后收一次
    if (!autoPoll) {
      this.pollTimer = null;
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.pollOnce().catch(() => {}).finally(() => this.schedulePoll());
    }, iv);
  }

  triggerPoll() {
    this.forcePoll = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.pollOnce().catch(() => {}).finally(() => this.schedulePoll());
    }, 100);
  }

  async pollOnce() {
    if (this.polling) return;
    this.polling = true;
    try {
      const s = this.store.account;
      const email = s.email;
      const pass = s.password;
      if (!email || !pass) {
        this.pollStatus = { last_ts: now(), ok: false, error: '尚未配置邮箱账户', fetched: 0, skipped: 0 };
        return;
      }
      const usePop3 = s.mode === 'pop3';
      if (usePop3 && !s.pop3.host) { this.pollStatus = { last_ts: now(), ok: false, error: '尚未配置 POP3 服务器', fetched: 0, skipped: 0 }; return; }
      if (!usePop3 && !s.imap.host) { this.pollStatus = { last_ts: now(), ok: false, error: '尚未配置 IMAP 服务器', fetched: 0, skipped: 0 }; return; }
      const seen = usePop3 ? this.store.seenPop3 : this.store.seenImap;
      const fr = usePop3
        ? await pop3Fetch(Object.assign({ user: email, pass }, s.pop3), seen)
        : await imapFetch(Object.assign({ user: email, pass }, s.imap), seen, 300, this.pendingSeenImap);
      let fetched = 0, skipped = 0, seenChanged = false, msgChanged = false, cfgChanged = false;
      let writeFailed = 0;
      for (const m of fr.messages) {
        if (!m.from_addr || m.from_addr === lower(email)) { skipped++; continue; }
        if (!this.store.isFriend(m.from_addr)) { skipped++; continue; }
        // 撤回通知：处理并丢弃，不生成聊天消息（规格 §4.4）
        if (m.recall_mid || m.kind === 'recall') {
          if (m.recall_mid) {
            const conv = this.store.conversations[m.from_addr] || [];
            const target = conv.find((x) => x.dir === 'in' && x.mid === m.recall_mid);
            if (target) {
              if (!target.recalled) { target.recalled = true; msgChanged = true; }
            } else if (!this.store.pendingRecalls.has(m.recall_mid)) {
              this.store.pendingRecalls.add(m.recall_mid);
              cfgChanged = true;
            }
          }
          skipped++;
          continue;
        }
        // pending_recalls 中的 mid：今后收到该来信直接丢弃（规格 §4.4）
        if (m.message_id && this.store.pendingRecalls.has(m.message_id)) { skipped++; continue; }
        // 附件先落盘再写消息；单封邮件超限的附件已在解析阶段被跳过（规格 §3.2/§7）
        const atts = [];
        for (const a of m.attachments || []) {
          const meta = this.saveAttachmentBuffer(a.data, a.name, a.mime);
          if (meta) atts.push(meta);
          else writeFailed++;
        }
        const saved = this.store.addMessage(m.from_addr, 'in', m.body_text, m.date_epoch, m.message_id, {
          kind: m.kind, subject: m.subject, quote: m.quote, attachments: atts, uid: m.uid,
        });
        if (saved) {
          this.store.unread[m.from_addr] = (this.store.unread[m.from_addr] || 0) + 1;
          fetched++;
        } else {
          for (const a of atts) this.removeAttachmentFile(a.file);
          skipped++;
        }
      }
      skipped += writeFailed;
      for (const k of fr.newKeys) { seen.add(k); seenChanged = true; }
      // seen 表超限时裁掉最旧一半而不是整体清空：整体清空会让 POP3 把历史邮件全部重拉
      while (seen.size > 5000) {
        const drop = Math.floor(seen.size / 2);
        const it = seen.values();
        for (let i = 0; i < drop; i++) { it.next(); }
        const cut = it.next().value;
        if (cut === undefined) break;
        for (const k of [...seen]) if (k < cut) seen.delete(k);
        seenChanged = true;
      }
      if (fetched > 0 || msgChanged) this.store.saveMessages();
      // 只在有变化时写配置，避免定时轮询反复无条件写盘
      if (seenChanged || fetched > 0 || cfgChanged) this.store.saveConfig();
      this.pollStatus = { last_ts: now(), ok: true, error: '', fetched, skipped };
    } catch (e) {
      this.pollStatus = { last_ts: now(), ok: false, error: String(e && e.message || e), fetched: 0, skipped: 0 };
    } finally {
      this.polling = false;
    }
  }

  // ---------------- API ----------------

  stateJson() {
    const s = this.store;
    const acc = s.account;
    const configured = !!(acc.email && acc.password);
    const friends = s.friends
      .map((f) => ({
        email: f.email,
        name: f.name || '',
        note: f.note || '',
        unread: s.unread[f.email] || 0,
        last_text: s.lastText(f.email),
        last_ts: s.lastTs(f.email),
      }))
      .sort((a, b) => b.last_ts - a.last_ts);
    return JSON.stringify({
      self: acc.email,
      configured,
      account: {
        email: acc.email, display_name: acc.display_name, password: acc.password,
        mode: acc.mode, poll_interval: acc.poll_interval, auto_poll: acc.auto_poll !== false,
        imap: acc.imap, pop3: acc.pop3, smtp: acc.smtp, ai: acc.ai,
      },
      poll: this.pollStatus,
      friends,
      ai: this.aiStatus(),
    });
  }

  messagesJson(peer) {
    const p = lower(trim(peer));
    const s = this.store;
    const f = s.findFriend(p);
    const msgs = (s.conversations[p] || []).map((m) => normalizeMessage(m));
    return JSON.stringify({
      peer: p,
      friend: f ? { email: f.email, name: f.name || '', note: f.note || '' } : undefined,
      messages: msgs,
    });
  }

  // POST /api/read（2.1）：本地未读清零 + 收集该会话 dir=in 的 IMAP uid 待批量标已读，
  // 然后 triggerPoll() 让下一次 IMAP 轮询执行 UID STORE（不阻塞 HTTP 响应）。
  apiRead(peer) {
    const p = lower(trim(peer || ''));
    const s = this.store;
    delete s.unread[p];
    const conv = s.conversations[p] || [];
    for (const m of conv) {
      if (m.dir === 'in' && m.uid) this.pendingSeenImap.add(String(m.uid));
    }
    s.saveConfig();
    this.triggerPoll();
    return jsonOk();
  }

  smtpConfig() {
    const a = this.store.account;
    return Object.assign({
      user: a.email,
      pass: a.password,
      from_addr: a.email,
      display_name: a.display_name || a.email,
    }, a.smtp);
  }

  // 附件落盘：data/attachments/<epoch>-<4hex>-<安全分量>，重名在末尾追加序号（与 C++ 一致）
  newAttachmentFileName(attDir, original) {
    const safe = sanitizeStoredComponent(original);
    const base = `${now()}-${crypto.randomBytes(2).toString('hex')}-${safe}`;
    let name = base;
    let n = 1;
    while (fs.existsSync(path.join(attDir, name))) name = base + '-' + (n++);
    return name;
  }

  saveAttachmentBuffer(data, name, mime) {
    const attDir = path.join(this.store.dir, 'attachments');
    const displayName = sanitizeDisplayName(name, 0, 'attachment');
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
    const file = this.newAttachmentFileName(attDir, displayName);
    try {
      fs.mkdirSync(attDir, { recursive: true });
      fs.writeFileSync(path.join(attDir, file), buf);
    } catch (e) {
      console.error('[email-chatter] save attachment failed:', e.message);
      return null;
    }
    const m = baseMime(mime || mimeFromName(displayName));
    return {
      name: displayName,
      mime: m,
      size: buf.length,
      file,
      inline: isImageMime(m),
    };
  }

  removeAttachmentFile(file) {
    if (!file) return;
    try { fs.unlinkSync(path.join(this.store.dir, 'attachments', path.basename(String(file)))); } catch (e) { /* ignore */ }
  }

  // 成功发送后不删除暂存件（C++ 语义：标记 consumed，启动清理 >24h；verifier K17 要求可复用）
  markUploadsConsumed(ids) {
    for (const id of ids || []) {
      const meta = this.uploads.get(id);
      if (meta) meta.consumed = true;
    }
  }

  // /api/send 的 attachments：[{id,name}] → 暂存文件内容 + mime + 大小校验
  collectUploadAttachments(reqList) {
    const out = { list: [], error: '' };
    if (reqList === null || reqList === undefined) return out;
    if (!Array.isArray(reqList)) return { list: [], error: '附件参数格式不正确' };
    if (reqList.length > 20) return { list: [], error: '附件数量过多（上限 20 个）' };
    const upDir = path.join(this.store.dir, 'uploads');
    let total = 0;
    for (const item of reqList) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || '');
      if (!/^u_[A-Za-z0-9_]+$/.test(id) || path.basename(id) !== id) {
        return { list: [], error: '附件已失效，请重新添加' };
      }
      const meta = this.uploads.get(id);
      if (!meta) return { list: [], error: '附件已失效，请重新添加' };
      const src = path.join(upDir, id);
      let st = null;
      try { st = fs.statSync(src); } catch (e) { st = null; }
      if (!st || !st.isFile()) {
        this.uploads.delete(id);
        return { list: [], error: '附件已失效，请重新添加' };
      }
      const displayName = sanitizeDisplayName(meta.name || String(item.name || ''), 0, 'file');
      const mime = baseMime(meta.mime || mimeFromName(displayName));
      const size = st.size;
      if (size > MAX_ATTACHMENT) return { list: [], error: '单个附件不能超过 16MB' };
      total += size;
      if (total > MAX_ATTACHMENTS_TOTAL) return { list: [], error: '附件总大小不能超过 24MB' };
      let data;
      try { data = fs.readFileSync(src); } catch (e) {
        return { list: [], error: '读取附件失败，请重新添加' };
      }
      out.list.push({ id, displayName, mime, size, data });
    }
    return out;
  }

  // POST /api/upload?name=<filename>（raw body ≤16MB，规格 §4.2）
  uploadJson(rawName, contentType, buf) {
    const body = Buffer.isBuffer(buf) ? buf : Buffer.alloc(0);
    if (body.length > MAX_ATTACHMENT) return jsonErr('附件不能超过 16MB');
    const displayName = sanitizeDisplayName(rawName || '', 120, 'file.bin');
    let mime = baseMime(mimeFromName(displayName));
    if (mime === 'application/octet-stream') {
      const ct = baseMime(contentType);
      if (ct !== 'application/octet-stream') mime = ct;
    }
    const id = 'u_' + now() + '_' + crypto.randomBytes(4).toString('hex');
    const upDir = path.join(this.store.dir, 'uploads');
    try {
      fs.mkdirSync(upDir, { recursive: true });
      fs.writeFileSync(path.join(upDir, id), body);
    } catch (e) {
      return jsonErr('保存上传文件失败');
    }
    this.uploads.set(id, { name: displayName, size: body.length, mime, ts: now(), consumed: false });
    // 顺手清理已消费的旧暂存（避免长时间运行磁盘累积，与 C++ 一致）
    if (this.uploads.size > 200) {
      for (const [k, v] of this.uploads) {
        if (k === id || !v.consumed) continue;
        try { fs.unlinkSync(path.join(upDir, k)); } catch (e) { /* ignore */ }
        this.uploads.delete(k);
      }
    }
    return JSON.stringify({ ok: true, id, name: displayName, size: body.length, mime });
  }

  // GET /api/attachment?file=<basename>（规格 §4.3）
  serveAttachment(req, res, u) {
    const raw = String(u.searchParams.get('file') || '');
    const base = path.basename(raw);
    if (!raw || raw !== base || base === '.' || base === '..' || /[\\/]/.test(raw) || raw.includes('..')) {
      return this.sendJson(res, jsonErr('附件不存在'), 404);
    }
    const attDir = path.join(this.store.dir, 'attachments');
    const file = path.join(attDir, base);
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) {
      return this.sendJson(res, jsonErr('附件不存在'), 404);
    }
    const mime = mimeFromName(base) || 'application/octet-stream';
    const enc = encodeURIComponent(base).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    const disposition = isImageMime(mime) ? 'inline' : `attachment; filename*=UTF-8''${enc}`;
    const headers = {
      'Content-Type': mime,
      'Content-Length': buf.length,
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    res.end(buf);
  }

  // POST /api/recall（规格 §4.4）
  async recallJson(body) {
    const s = this.store;
    const peer = lower(trim(body.with || body.peer || body.to || ''));
    const id = parseInt(body.id, 10);
    if (!s.isFriend(peer)) return jsonErr('对方不在好友白名单中，无法撤回');
    const conv = s.conversations[peer] || [];
    const msg = conv.find((m) => m.id === id && m.dir === 'out' && !m.recalled && m.mid);
    if (!msg) return jsonErr('该消息不支持撤回（缺少邮件标识或已撤回）');
    if (!s.account.email || !s.account.password) return jsonErr('请先在设置中填写邮箱账户与客户端授权密码');
    if (!s.account.smtp.host) return jsonErr('请先在设置中配置 SMTP 服务器');
    const built = buildRawMessage({
      fromDisplay: s.account.display_name || '',
      fromAddr: s.account.email,
      to: [peer],
      subject: '撤回了一条消息',
      kind: 'recall',
      body: '对方撤回了一条消息',
      recallMid: msg.mid,
    });
    try {
      await smtpSendRaw(this.smtpConfig(), [peer], built.raw);
    } catch (e) {
      return jsonErr(e && e.message ? e.message : '撤回通知发送失败');
    }
    msg.recalled = true;
    s.saveMessages();
    return jsonOk();
  }

  // ---------------- AI 接口（规格 §4.6）----------------

  aiStatusJson() {
    return JSON.stringify({ ok: true, ai: this.aiStatus() });
  }

  aiDownloadJson() {
    const m = this.ensureAi();
    const before = this.aiStatus();
    if (before.model_ready) return JSON.stringify({ ok: true, already: true, ai: before });
    if (before.downloading) return JSON.stringify({ ok: true, ai: before });  // 下载中重复调用视为成功（幂等）
    if (!m || typeof m.startDownload !== 'function') {
      return JSON.stringify({ ok: false, error: 'AI 模块不可用（electron/ai.js 未安装）', ai: this.aiStatus() });
    }
    let r = null;
    try { r = m.startDownload(); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    const st = this.aiStatus();
    if (r && r.ok === false) {
      if (st.downloading) return JSON.stringify({ ok: true, ai: st });
      return JSON.stringify({ ok: false, error: r.error || '无法开始下载', ai: st });
    }
    if (r && r.already) return JSON.stringify({ ok: true, already: true, ai: st });
    return JSON.stringify({ ok: true, ai: st });
  }

  aiCancelJson() {
    const m = this.ensureAi();
    if (m && typeof m.cancelDownload === 'function') {
      try { m.cancelDownload(); } catch (e) { /* ignore */ }
    }
    return JSON.stringify({ ok: true, ai: this.aiStatus() });
  }

  async aiTitleJson(body) {
    const text = String(body.text == null ? '' : body.text);
    const r = await this.generateAiTitle(text);
    const out = { ok: true, subject: r.title, source: r.source };
    if (r.source !== 'ai' && r.note) out.note = r.note;
    return JSON.stringify(out);
  }

  // POST /api/send（规格 §4.1）：chat/email 通用，支持抄送/密送/引用/附件/AI 标题
  async apiSend(body) {
    const s = this.store;
    const peer = lower(trim(body.to || ''));
    const kind = body.kind === 'email' ? 'email' : 'chat';
    const text = trim(String(body.text == null ? '' : body.text));
    const userSubject = truncate(sanitizeHeader(trim(body.subject || '')), 200);

    // 引用：后端截断到 500 字符；有 text 或 mid 即视为引用（与 C++ 一致）
    let quote = null;
    if (body.quote && typeof body.quote === 'object') {
      const q = {
        text: truncate(String(body.quote.text == null ? '' : body.quote.text).replace(/\r/g, ''), 500),
        from: sanitizeHeader(trim(body.quote.from == null ? '' : body.quote.from)),
        ts: parseInt(body.quote.ts, 10) || 0,
        mid: sanitizeHeader(trim(body.quote.mid == null ? '' : body.quote.mid)),
      };
      if (q.text || q.mid) quote = q;
    }
    // 附件：从 data/uploads 取暂存文件；失败不写消息、暂存保留可重试
    const attRes = this.collectUploadAttachments(body.attachments);
    if (attRes.error) return jsonErr(attRes.error);
    const attachments = attRes.list;
    if (!peer) return jsonErr('收件人不能为空');
    if (!text && !attachments.length && !quote) return jsonErr('内容不能为空');
    if (!s.isFriend(peer)) return jsonErr('对方不在好友白名单中，无法发送');
    if (!s.account.email || !s.account.password) return jsonErr('请先在设置中填写邮箱账户与客户端授权密码');
    if (!s.account.smtp.host) return jsonErr('请先在设置中配置 SMTP 服务器');

    // 收件人 = to + cc + bcc（去重、去空、校验含 @，每类最多 5 个）
    const ccList = parseAddrList(body.cc, 5);
    const bccList = parseAddrList(body.bcc, 5);
    const rcpts = [];
    for (const a of [peer, ...ccList, ...bccList]) if (!rcpts.includes(a)) rcpts.push(a);
    if (!rcpts.length) return jsonErr('收件人邮箱格式不正确');

    // 主题（规格 §4.1 第 3 步）
    const aiOn = !!s.account.ai.enabled && !!this.aiStatus().model_ready;
    let subject = '';
    let aiUsed = false;
    if (kind === 'chat') {
      subject = 'email-chatter 消息';
      if (aiOn) {
        const t = await this.generateAiTitle(text);
        if (t.ai && trim(t.title)) { subject = truncate(trim(t.title), 200); aiUsed = true; }
      }
    } else if (userSubject) {
      subject = userSubject;
    } else {
      let title = '';
      if (aiOn) {
        const g = await this.generateAiTitle(text);
        if (g.ai && trim(g.title)) { title = g.title; aiUsed = true; }
      }
      if (!aiUsed) title = this.heuristicTitle(text);
      subject = truncate(trim(title), 200) || '无主题';
    }
    // 2.1 引用 = reply：合法 quote.mid 时主题加 Re:（本地存实际发出的主题；buildRawMessage 内幂等）
    if (quote && validMessageId(quote.mid)) subject = withRePrefix(subject);
    // 正文：email 模式允许无正文但需附件，补 "（无正文）"
    const mailBody = kind === 'email' && !text && attachments.length ? '（无正文）' : text;
    const built = buildRawMessage({
      fromDisplay: s.account.display_name || '',
      fromAddr: s.account.email,
      to: [peer],
      cc: ccList,
      subject,
      kind,
      body: mailBody,
      quote,
      attachments: attachments.map((a) => ({ name: a.displayName, mime: a.mime, data: a.data })),
    });
    try {
      await smtpSendRaw(this.smtpConfig(), rcpts, built.raw);
    } catch (e) {
      return jsonErr(e && e.message ? e.message : '发送失败');
    }
    // 发送成功后才落盘附件、写本地消息、标记暂存已消费（规格 §4.1 第 5 步）
    const savedAtts = [];
    for (const a of attachments) {
      const meta = this.saveAttachmentBuffer(a.data, a.displayName, a.mime);
      if (meta) savedAtts.push(meta);
    }
    const storedText = kind === 'email' ? mailBody : text;
    const msg = s.addMessage(peer, 'out', storedText, now(), built.msgId, {
      kind, subject, quote, attachments: savedAtts,
    });
    s.saveMessages();
    this.markUploadsConsumed(attachments.map((a) => a.id));
    return JSON.stringify({ ok: true, id: msg ? msg.id : 0, subject, ai: aiUsed });
  }

  configJsonGet() {
    const a = this.store.account;
    return JSON.stringify({
      ok: true,
      account: {
        email: a.email, display_name: a.display_name, password: a.password,
        mode: a.mode, poll_interval: a.poll_interval, auto_poll: a.auto_poll !== false,
        imap: a.imap, pop3: a.pop3, smtp: a.smtp, ai: a.ai,
      },
      ai: this.aiStatus(),
    });
  }

  configJson(body) {
    const s = this.store;
    const a = s.account;
    // 只覆盖请求中实际提供的字段：避免「保存一个开关」把邮箱/密码等未传字段清空
    if (typeof body.email === 'string') {
      const email = lower(trim(body.email));
      if (email && email.indexOf('@') < 0) return jsonErr('邮箱地址格式不正确');
      a.email = email;
    }
    if (typeof body.display_name === 'string') a.display_name = body.display_name;
    if (typeof body.password === 'string') a.password = body.password;
    if (body.mode === 'pop3' || body.mode === 'imap') a.mode = body.mode;
    if (typeof body.auto_poll === 'boolean') a.auto_poll = body.auto_poll;
    const iv = parseInt(body.poll_interval, 10);
    if (iv >= 3 && iv <= 3600) a.poll_interval = iv;
    if (body.imap) a.imap = normalizeServer(a.imap, body.imap, 993);
    if (body.pop3) a.pop3 = normalizeServer(a.pop3, body.pop3, 995);
    if (body.smtp) a.smtp = normalizeServer(a.smtp, body.smtp, 465);
    // AI 配置：只覆盖提供的字段（规格 §2.1）
    if (body.ai && typeof body.ai === 'object') {
      const ai = a.ai;
      if (typeof body.ai.enabled === 'boolean') ai.enabled = body.ai.enabled;
      if (typeof body.ai.mirror === 'string') {
        ai.mirror = sanitizeHeader(trim(body.ai.mirror)) || DEFAULT_AI().mirror;
      }
      if (typeof body.ai.model_url === 'string') {
        ai.model_url = sanitizeHeader(trim(body.ai.model_url));
      }
      if (typeof body.ai.model_file === 'string') {
        const mf = sanitizeDisplayName(trim(body.ai.model_file), 120, '');
        if (mf && mf !== 'file') ai.model_file = mf;
      }
    }
    s.saveConfig();
    this.ensureAi();  // 把最新 ai 配置同步给 ai.js
    this.triggerPoll();
    return JSON.stringify({ ok: true, ai: this.aiStatus() });
  }

  friendsJson(body) {
    const s = this.store;
    const action = body.action;
    const email = lower(trim(body.email || ''));
    if (action === 'add') {
      if (email.indexOf('@') < 0) return jsonErr('邮箱地址格式不正确');
      if (!s.addFriend(email, body.name || '', body.note || '')) return jsonErr('添加好友失败');
    } else if (action === 'remove') {
      if (!s.removeFriend(email)) return jsonErr('该邮箱不在好友列表中');
    } else {
      return jsonErr('未知操作');
    }
    s.saveConfig();
    return jsonOk();
  }

  async testJson() {
    const s = this.store;
    const email = s.account.email, pass = s.account.password;
    const sc = Object.assign({ user: email, pass, from_addr: email, display_name: s.account.display_name }, s.account.smtp);
    const usePop3 = s.account.mode === 'pop3';
    const rc = usePop3
      ? Object.assign({ user: email, pass }, s.account.pop3)
      : Object.assign({ user: email, pass }, s.account.imap);
    let o1 = false, e1 = '', o2 = false, e2 = '';
    // 并发测试 SMTP 与收信，避免依次等待两个超时而让 UI 长时间无响应
    await Promise.all([
      (async () => { try { await smtpTest(sc); o1 = true; } catch (e) { e1 = e.message || String(e); } })(),
      (async () => { try { usePop3 ? await pop3Test(rc) : await imapTest(rc); o2 = true; } catch (e) { e2 = e.message || String(e); } })(),
    ]);
    const out = {
      ok: o1 && o2,
      smtp: { ok: o1, error: e1 },
      recv: { ok: o2, error: e2 },
    };
    // 失败时附带「哪些备用服务器能连」的建议（与 C++ 版行为一致）
    if (!(o1 && o2) && email && email.includes('@')) {
      const dom = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
      const cands = [];
      const add = (kind, host, port, ssl) => cands.push({ kind, host, port, ssl });
      add('imap', 'imaphz.qiye.163.com', 993, true);
      add('imap', 'imap.qiye.163.com', 993, true);
      add('imap', 'imap.' + dom, 993, true);
      add('pop3', 'pophz.qiye.163.com', 995, true);
      add('pop3', 'pop.qiye.163.com', 995, true);
      add('pop3', 'pop.' + dom, 995, true);
      add('smtp', 'smtphz.qiye.163.com', 994, true);
      add('smtp', 'smtp.qiye.163.com', 994, true);
      add('smtp', 'smtp.qiye.163.com', 465, true);
      add('smtp', 'smtp.' + dom, 465, true);
      out.hints = await Promise.all(cands.map(async (c) => {
        const r = await probeGreeting(c.host, c.port, c.ssl);
        if (!r.ok) return Object.assign({}, c, { ok: false, error: r.error });
        const g = r.greeting || '';
        const match = c.kind === 'smtp' ? g.startsWith('220') : c.kind === 'pop3' ? g.startsWith('+OK') : g.startsWith('* OK');
        return Object.assign({}, c, { ok: match, error: match ? '' : '端口通但不是该协议的服务器' });
      }));
    }
    return JSON.stringify(out);
  }

  // 自动检测服务器：并发探测候选 (kind, host, port, ssl)，返回每个是否可连
  async probeJson(body) {
    let list = [];
    if (Array.isArray(body.candidates)) {
      for (const it of body.candidates) {
        if (!it) continue;
        const n = normalizeHost(it.host, parseInt(it.port, 10) || 0);
        if (n.host && n.port > 0) list.push({ kind: String(it.kind || ''), host: n.host, port: n.port, ssl: it.ssl !== false });
      }
    }
    if (!list.length) {
      const email = String(body.email || this.store.account.email || '').trim();
      const at = email.lastIndexOf('@');
      const dom = at >= 0 ? email.slice(at + 1).toLowerCase() : '';
      if (!dom) return JSON.stringify({ ok: false, error: '请先填写邮箱地址（用于自动检测服务器）' });
      const add = (kind, host, port, ssl) => list.push({ kind, host, port, ssl });
      add('imap', 'imaphz.qiye.163.com', 993, true);
      add('imap', 'imap.qiye.163.com', 993, true);
      add('imap', 'imap.' + dom, 993, true);
      add('imap', 'imap.' + dom, 143, false);
      add('pop3', 'pophz.qiye.163.com', 995, true);
      add('pop3', 'pop.qiye.163.com', 995, true);
      add('pop3', 'pop.' + dom, 995, true);
      add('pop3', 'pop.' + dom, 110, false);
      add('smtp', 'smtphz.qiye.163.com', 994, true);
      add('smtp', 'smtp.qiye.163.com', 994, true);
      add('smtp', 'smtp.qiye.163.com', 465, true);
      add('smtp', 'smtp.' + dom, 465, true);
      add('smtp', 'smtp.' + dom, 587, false);
      add('smtp', 'smtp.' + dom, 25, false);
    }
    const results = await Promise.all(list.map(async (c) => {
      const t0 = Date.now();
      const r = await probeGreeting(c.host, c.port, c.ssl);
      const elapsed_ms = Date.now() - t0;
      if (!r.ok) return Object.assign({}, c, { ok: false, error: r.error, greeting: '', elapsed_ms });
      const g = r.greeting || '';
      const match = c.kind === 'smtp' ? g.startsWith('220')
        : c.kind === 'pop3' ? g.startsWith('+OK')
        : g.startsWith('* OK');
      return Object.assign({}, c, {
        ok: match,
        error: match ? '' : '端口通但不是该协议的服务器: ' + g,
        greeting: g,
        elapsed_ms,
      });
    }));
    return JSON.stringify({ ok: true, results });
  }

  // CSRF / DNS-rebinding 防护（与 C++ 版一致）：
  // 回环绑定下 Host 必须为 127.0.0.1/localhost/[::1]；带 Origin 时其 host 必须与 Host 一致。
  apiGuard(req) {
    const hostOnly = (h) => {
      let x = String(h || '').toLowerCase();
      const cl = x.lastIndexOf(':');
      if (cl >= 0 && /^\d+$/.test(x.slice(cl + 1))) x = x.slice(0, cl);
      if (x.startsWith('[') && x.endsWith(']')) x = x.slice(1, -1);
      return x;
    };
    const loopback = (h) => {
      const x = hostOnly(h);
      return x === '127.0.0.1' || x === 'localhost' || x === '::1';
    };
    const hosts = req.headers && (req.headers.host || '');
    if (!loopback(hosts)) return false;  // 后端固定绑定 127.0.0.1，任何非回环 Host 一律拒绝
    const origin = req.headers && req.headers.origin;
    if (origin) {
      let o = origin;
      if (o.startsWith('http://')) o = o.slice(7);
      else if (o.startsWith('https://')) o = o.slice(8);
      const slash = o.indexOf('/');
      if (slash >= 0) o = o.slice(0, slash);
      o = o.toLowerCase();
      if (o === 'null') return false;  // file:// 或 sandbox iframe
      if (o !== hostOnly(hosts)) return false;
    }
    return true;
  }

  async handleRequest(req, res) {
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) {
      return this.sendText(res, 400, 'text/plain; charset=utf-8', 'bad url');
    }
    let pathname;
    try { pathname = decodeURIComponent(u.pathname); } catch (e) {
      return this.sendText(res, 400, 'text/plain; charset=utf-8', 'bad path');
    }
    if (pathname.startsWith('/api/')) {
      if (!this.apiGuard(req)) return this.sendJson(res, jsonErr('拒绝访问：来源不受信任（Host/Origin 校验未通过）'), 403);
      // 附件是二进制响应，不需要读请求体（支持 GET / HEAD）
      if (pathname === '/api/attachment') return this.serveAttachment(req, res, u);
      // /api/upload 只接受 POST（避免 GET 创建 0 字节暂存，review L5；与 C++ 路由一致）
      if (pathname === '/api/upload' && req.method !== 'POST') {
        return this.sendJson(res, jsonErr('未知接口'), 404);
      }
      const rb = await readBody(req, MAX_HTTP_BODY);
      if (rb.tooLarge) return this.sendJson(res, jsonErr('请求体过大（上限 32MB）'), 413);
      const buf = rb.buf;
      let obj = {};
      if (buf.length) {
        try { obj = JSON.parse(buf.toString('utf8')); } catch (e) { obj = {}; }
      }
      if (pathname === '/api/upload') {
        return this.sendJson(res, this.uploadJson(u.searchParams.get('name') || '', req.headers['content-type'] || '', buf));
      }
      if (pathname === '/api/state') return this.sendJson(res, this.stateJson());
      if (pathname === '/api/messages') return this.sendJson(res, this.messagesJson(u.searchParams.get('with') || ''));
      if (pathname === '/api/send') return this.sendJson(res, await this.apiSend(obj));
      if (pathname === '/api/recall') return this.sendJson(res, await this.recallJson(obj));
      if (pathname === '/api/read') return this.sendJson(res, this.apiRead(obj.with));
      if (pathname === '/api/friends') return this.sendJson(res, this.friendsJson(obj));
      if (pathname === '/api/config') {
        if (req.method === 'GET') return this.sendJson(res, this.configJsonGet());
        return this.sendJson(res, this.configJson(obj));
      }
      if (pathname === '/api/test') return this.sendJson(res, await this.testJson());
      if (pathname === '/api/probe') return this.sendJson(res, await this.probeJson(obj));
      if (pathname === '/api/poll') { this.triggerPoll(); return this.sendJson(res, jsonOk()); }
      if (pathname === '/api/ai/status') return this.sendJson(res, this.aiStatusJson());
      if (pathname === '/api/ai/download') return this.sendJson(res, this.aiDownloadJson());
      if (pathname === '/api/ai/cancel') return this.sendJson(res, this.aiCancelJson());
      if (pathname === '/api/ai/title') return this.sendJson(res, await this.aiTitleJson(obj));
      return this.sendJson(res, jsonErr('未知接口'), 404);
    }
    return this.serveStatic(res, pathname);
  }

  serveStatic(res, pathname) {
    let p = pathname;
    if (p === '/' || p === '') p = '/index.html';
    if (p.includes('..') || p.includes('\\')) {
      this.sendText(res, 400, 'text/plain; charset=utf-8', 'bad path');
      return;
    }
    const file = path.join(this.webDir, p);
    if (!file.startsWith(path.resolve(this.webDir))) {
      this.sendText(res, 400, 'text/plain; charset=utf-8', 'bad path');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        this.sendText(res, 404, 'text/plain; charset=utf-8', 'not found');
        return;
      }
      const ct = {
        '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
        '.txt': 'text/plain; charset=utf-8',
      }[path.extname(p).toLowerCase()] || 'application/octet-stream';
      this.sendBytes(res, 200, ct, data);
    });
  }

  sendJson(res, objOrStr, code = 200) {
    const body = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr);
    this.sendBytes(res, code, 'application/json; charset=utf-8', Buffer.from(body, 'utf8'));
  }
  sendText(res, code, ct, text) { this.sendBytes(res, code, ct, Buffer.from(text, 'utf8')); }
  sendBytes(res, code, ct, buf) {
    res.writeHead(code, {
      'Content-Type': ct,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  }
}

// 读取请求体（原始字节，上限默认 32MB；规格 §7）。超限时返回 {tooLarge:true}。
function readBody(req, limit = MAX_HTTP_BODY) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ buf: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks), tooLarge });
    };
    const onData = (c) => {
      if (tooLarge) return;
      total += c.length;
      if (total > limit) {
        tooLarge = true;
        chunks.length = 0;
        req.removeListener('data', onData);
        try { req.resume(); } catch (e) { /* ignore */ }
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', finish);
    req.on('error', finish);
    req.on('aborted', finish);
  });
}

// ============================== entry ==============================

async function startServer(opts) {
  const dataDir = opts.dataDir || path.join(__dirname, 'data');
  const webDir = opts.webDir || path.join(__dirname, '..', 'web');
  const app = new App(dataDir, webDir);
  app.store.load();
  app.initAssets();  // 建 data/attachments|uploads|models，清理过期暂存，初始化 AI
  const port = await app.start(opts.port || 0);
  return { app, port, dataDir, webDir };
}

function stopServer(instance) {
  if (instance && instance.app) instance.app.stop();
}

module.exports = {
  startServer,
  stopServer,
  App,
  Store,
  parseMessage,
  buildMessage,
  buildRawMessage,
  normalizeMessage,
  smtpSend,
  smtpSendRaw,
  pop3Fetch,
  imapFetch,
  heuristicTitle,
};

// Allow running directly: node backend.js [port] [webDir] [dataDir]
if (require.main === module) {
  const port = parseInt(process.argv[2], 10) || 48731;
  const webDir = process.argv[3] || path.join(__dirname, '..', 'web');
  const dataDir = process.argv[4] || path.join(__dirname, 'data');
  startServer({ port, webDir, dataDir }).then((inst) => {
    console.log(`email-chatter (node backend) listening on http://127.0.0.1:${inst.port}/`);
    console.log(`dataDir=${inst.dataDir}`);
    process.on('SIGINT', () => { stopServer(inst); process.exit(0); });
  }).catch((e) => { console.error('start failed:', e); process.exit(1); });
}