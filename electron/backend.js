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

function qpDecode(buf) {
  let out = Buffer.alloc(0);
  for (let i = 0; i < buf.length;) {
    const c = buf[i];
    if (c === 0x3d) { // '='
      if (i + 2 < buf.length && buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) { i += 3; continue; }
      if (i + 1 < buf.length && buf[i + 1] === 0x0a) { i += 2; continue; }
      if (i + 2 < buf.length) {
        const h = (x) => {
          const v = String.fromCharCode(x);
          if (v >= '0' && v <= '9') return x - 0x30;
          if (v >= 'a' && v <= 'f') return x - 0x57;
          if (v >= 'A' && v <= 'F') return x - 0x37;
          return -1;
        };
        const a = h(buf[i + 1]), b = h(buf[i + 2]);
        if (a >= 0 && b >= 0) { out = Buffer.concat([out, Buffer.from([(a << 4) | b])]); i += 3; continue; }
      }
      out = Buffer.concat([out, Buffer.from([c])]); i++;
    } else {
      out = Buffer.concat([out, Buffer.from([c])]); i++;
    }
  }
  return out;
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

function collectText(part, out) {
  let sep = part.indexOf(Buffer.from('\r\n\r\n'));
  let seplen = 4;
  if (sep < 0) { sep = part.indexOf(Buffer.from('\n\n')); seplen = 2; }
  const head = sep < 0 ? part.toString('latin1') : part.subarray(0, sep).toString('latin1');
  const body = sep < 0 ? Buffer.alloc(0) : part.subarray(sep + seplen);
  const h = parseHeaders(head);
  const ct = contentTypeOf(h['content-type']);
  if (ct.type.startsWith('multipart/')) {
    if (ct.params.boundary) {
      for (const p of splitMultipart(body, ct.params.boundary)) collectText(p, out);
    }
    return;
  }
  const cte = lower(h['content-transfer-encoding']);
  let decoded = body;
  if (cte === 'base64') decoded = Buffer.from(body.toString('latin1').replace(/[\r\n\t ]/g, ''), 'base64');
  else if (cte === 'quoted-printable') decoded = qpDecode(body);
  const text = charsetToUtf8(decoded, ct.params.charset || '');
  if (ct.type === 'text/plain') out.push({ text, type: 'text/plain' });
  else if (ct.type === 'text/html') out.push({ text: stripHtml(text), type: 'text/html' });
}

function parseMessage(rawBuf) {
  const raw = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf, 'latin1');
  let sep = raw.indexOf(Buffer.from('\r\n\r\n'));
  let seplen = 4;
  if (sep < 0) { sep = raw.indexOf(Buffer.from('\n\n')); seplen = 2; }
  const headStr = sep < 0 ? raw.toString('latin1') : raw.subarray(0, sep).toString('latin1');
  const h = parseHeaders(headStr);
  const from = decodeEncodedWords(h['from'] || '');
  const out = {
    from,
    from_addr: extractAddr(from),
    subject: decodeEncodedWords(h['subject'] || ''),
    body_text: '',
    message_id: trim(h['message-id'] || ''),
    date_raw: trim(h['date'] || ''),
    date_epoch: 0,
  };
  out.date_epoch = parseDate(out.date_raw) || now();
  const parts = [];
  collectText(raw, parts);
  let text = '';
  for (const p of parts) if (p.type === 'text/plain') { text = p.text; break; }
  if (!trim(text)) for (const p of parts) if (p.type === 'text/html') { text = p.text; break; }
  out.body_text = trim(text);
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

function buildMessage(fromDisplay, fromAddr, toAddr, subject, body) {
  const fromHdr = fromDisplay ? `${encodeHeader(fromDisplay)} <${sanitizeHeader(fromAddr)}>` : sanitizeHeader(fromAddr);
  // 原实现用了未播种的 Math.random + 秒级时间戳，同一秒内发出的两封邮件 Message-ID 可能相同。
  // 改为 crypto.randomBytes（加密级随机）+ 纳秒时间，保证唯一性。
  const msgId = `<${Date.now()}.${process.hrtime.bigint().toString()}.${crypto.randomBytes(8).toString('hex')}@email-chatter.local>`;
  let msg =
    `From: ${fromHdr}\r\nTo: <${sanitizeHeader(toAddr)}>\r\nSubject: ${encodeHeader(subject)}\r\n` +
    `Date: ${rfc5322Now()}\r\nMessage-ID: ${msgId}\r\n` +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: text/plain; charset=UTF-8\r\n' +
    'Content-Transfer-Encoding: base64\r\n' +
    'X-Email-Chatter: 1\r\n\r\n';
  const b = Buffer.from(body, 'utf8').toString('base64');
  for (let i = 0; i < b.length; i += 76) msg += b.slice(i, i + 76) + '\r\n';
  return msg;
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
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); }

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

async function smtpSend(cfg, toAddr, subject, body) {
  if (!cfg.host) throw new Error('SMTP 服务器未配置');
  const { conn, effective } = await smtpConn(cfg);
  try {
    await smtpHandshake(effective, conn);
    const from = cfg.from_addr || cfg.user;
    await conn.write(`MAIL FROM:<${sanitizeHeader(from)}>\r\n`);
    let r = await smtpResponse(conn);
    if (r.code !== 250) throw new Error('SMTP MAIL FROM 被拒绝');
    await conn.write(`RCPT TO:<${sanitizeHeader(toAddr)}>\r\n`);
    r = await smtpResponse(conn);
    if (r.code !== 250 && r.code !== 251) throw new Error('SMTP RCPT TO 被拒绝');
    await conn.write('DATA\r\n');
    r = await smtpResponse(conn);
    if (r.code !== 354) throw new Error('SMTP DATA 未接受');
    const msg = buildMessage(cfg.display_name, from, toAddr, subject, body);
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
      let raw = Buffer.alloc(0);
      for (;;) {
        const l = await conn.readLine();
        if (l === null) throw new Error('POP3 RETR 读取中断');
        if (l === '.') break;
        const line2 = l.startsWith('.') ? l.slice(1) : l;
        raw = Buffer.concat([raw, Buffer.from(line2, 'latin1'), Buffer.from('\r\n')]);
      }
      res.messages.push(parseMessage(raw));
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

async function imapFetchOne(conn, tag, uid) {
  await conn.write(`${tag} UID FETCH ${uid} (RFC822)\r\n`);
  let raw = null;
  for (;;) {
    const line = await conn.readLine();
    if (line === null) return null;
    if (line.startsWith(tag + ' ')) {
      const p = line.split(' ');
      return p[1] === 'OK' ? raw : null;
    }
    const m = line.match(/RFC822 \{(\d+)\}/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n < 50 * 1024 * 1024) {
        const buf = await conn.readExact(n);
        if (!buf) return null;
        raw = buf;
      }
    }
  }
}

async function imapFetch(cfg, seen, maxNew = 300) {
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
      const raw = await imapFetchOne(conn, 'a4', uid);
      if (!raw) continue;
      res.messages.push(parseMessage(raw));
      res.newKeys.push(key);
      await conn.write(`a5 UID STORE ${uid} +FLAGS.SILENT (\\Seen)\r\n`);
      await imapReadUntil(conn, 'a5');
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

const DEFAULT_ACCOUNT = () => ({
  email: '', display_name: '', password: '', mode: 'imap', poll_interval: 8, auto_poll: true,
  imap: { host: '', port: 993, ssl: true },
  pop3: { host: '', port: 995, ssl: true },
  smtp: { host: '', port: 465, ssl: true },
});

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
        if (Array.isArray(c.friends)) this.friends = c.friends.filter((f) => f && f.email);
        if (Array.isArray(c.seen_pop3)) this.seenPop3 = new Set(c.seen_pop3);
        if (Array.isArray(c.seen_imap)) this.seenImap = new Set(c.seen_imap);
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
      friends: this.friends,
      seen_pop3: [...this.seenPop3],
      seen_imap: [...this.seenImap],
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
  addMessage(peer, dir, text, ts, mid) {
    const t = truncate(trim(text), 4000) || '(空消息)';
    const msg = { id: this.nextMsgId++, dir, text: t, ts: ts > 0 ? ts : now() };
    if (mid) msg.mid = mid;
    // 收件按 Message-ID 去重：seen 表清空/损坏/换机重拉时，同一封邮件不重复进对话
    if (dir === 'in' && mid) {
      const conv0 = this.conversations[peer] || [];
      for (const m of conv0) if (m.dir === 'in' && m.mid === mid) return false;
    }
    if (!this.conversations[peer]) this.conversations[peer] = [];
    const conv = this.conversations[peer];
    conv.push(msg);
    if (conv.length > 300) conv.splice(0, conv.length - 300);
    return true;
  }
  lastText(peer) {
    const c = this.conversations[peer];
    return c && c.length ? c[c.length - 1].text : '';
  }
  lastTs(peer) {
    const c = this.conversations[peer];
    return c && c.length ? c[c.length - 1].ts : 0;
  }
}

// ============================== App ==============================

class App {
  constructor(dataDir, webDir) {
    this.store = new Store(dataDir);
    this.webDir = webDir;
    this.pollStatus = { last_ts: 0, ok: false, error: '', fetched: 0, skipped: 0 };
    this.pollTimer = null;
    this.polling = false;
    this.forcePoll = false;
    this.running = false;
  }

  start(port) {
    this.running = true;
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res).catch(() => this.sendJson(res, { ok: false, error: '内部错误' })));
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
        : await imapFetch(Object.assign({ user: email, pass }, s.imap), seen);
      let fetched = 0, skipped = 0, seenChanged = false;
      for (const m of fr.messages) {
        if (!m.from_addr || m.from_addr === lower(email)) { skipped++; continue; }
        if (!this.store.isFriend(m.from_addr)) { skipped++; continue; }
        if (this.store.addMessage(m.from_addr, 'in', m.body_text, m.date_epoch, m.message_id)) {
          this.store.unread[m.from_addr] = (this.store.unread[m.from_addr] || 0) + 1;
          fetched++;
        } else {
          skipped++;
        }
      }
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
      if (fetched > 0) this.store.saveMessages();
      // 只在有变化时写配置，避免定时轮询反复无条件写盘
      if (seenChanged || fetched > 0) this.store.saveConfig();
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
      .map((f) => Object.assign({}, f, {
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
        imap: acc.imap, pop3: acc.pop3, smtp: acc.smtp,
      },
      poll: this.pollStatus,
      friends,
    });
  }

  messagesJson(peer) {
    const p = lower(trim(peer));
    const s = this.store;
    const f = s.findFriend(p);
    const msgs = (s.conversations[p] || []).map((m) => Object.assign({}, m, { time: fmtTime(m.ts) }));
    return JSON.stringify({
      peer: p,
      friend: f ? { email: f.email, name: f.name || '', note: f.note || '' } : undefined,
      messages: msgs,
    });
  }

  async sendJsonReply(to, text) {
    const peer = lower(trim(to));
    const msg = trim(text);
    if (!peer || !msg) return jsonErr('收件人或内容为空');
    const s = this.store;
    if (!s.isFriend(peer)) return jsonErr('对方不在好友白名单中，无法发送');
    if (!s.account.email || !s.account.password) return jsonErr('请先在设置中填写邮箱账户与客户端授权密码');
    if (!s.account.smtp.host) return jsonErr('请先在设置中配置 SMTP 服务器');
    const cfg = Object.assign({
      user: s.account.email,
      pass: s.account.password,
      from_addr: s.account.email,
      display_name: s.account.display_name || s.account.email,
    }, s.account.smtp);
    try {
      await smtpSend(cfg, peer, 'email-chatter 消息', msg);
    } catch (e) {
      return jsonErr('发送失败: ' + (e && e.message || e));
    }
    s.addMessage(peer, 'out', msg, now());
    s.saveMessages();
    return jsonOk();
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
    s.saveConfig();
    this.triggerPoll();
    return jsonOk();
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
    const u = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(u.pathname);
    if (pathname.startsWith('/api/')) {
      if (!this.apiGuard(req)) return this.sendJson(res, jsonErr('拒绝访问：来源不受信任（Host/Origin 校验未通过）'), 403);
      const body = await readBody(req);
      let obj = {};
      try { obj = body ? JSON.parse(body) : {}; } catch (e) { /* keep {} */ }
      if (pathname === '/api/state') return this.sendJson(res, this.stateJson());
      if (pathname === '/api/messages') return this.sendJson(res, this.messagesJson(u.searchParams.get('with') || ''));
      if (pathname === '/api/send') return this.sendJson(res, await this.sendJsonReply(obj.to, obj.text));
      if (pathname === '/api/read') {
        const w = String(obj.with || '');
        delete this.store.unread[w];
        this.store.saveConfig();
        return this.sendJson(res, jsonOk());
      }
      if (pathname === '/api/friends') return this.sendJson(res, this.friendsJson(obj));
      if (pathname === '/api/config') return this.sendJson(res, this.configJson(obj));
      if (pathname === '/api/test') return this.sendJson(res, await this.testJson());
      if (pathname === '/api/probe') return this.sendJson(res, await this.probeJson(obj));
      if (pathname === '/api/poll') { this.triggerPoll(); return this.sendJson(res, jsonOk()); }
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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

// ============================== entry ==============================

async function startServer(opts) {
  const dataDir = opts.dataDir || path.join(__dirname, 'data');
  const webDir = opts.webDir || path.join(__dirname, '..', 'web');
  const app = new App(dataDir, webDir);
  app.store.load();
  const port = await app.start(opts.port || 0);
  return { app, port, dataDir, webDir };
}

function stopServer(instance) {
  if (instance && instance.app) instance.app.stop();
}

module.exports = { startServer, stopServer, Store, parseMessage, buildMessage, smtpSend, pop3Fetch, imapFetch };

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