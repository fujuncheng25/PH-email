'use strict';
/*
 * End-to-end test for the Electron (Node) backend using the same mock mail
 * servers as the C++ e2e test.
 *
 * Usage: node e2e_node.js   (requires the DSH runtime node, Node >= 18)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const { startServer, stopServer } = require('../electron/backend.js');

const PY = process.env.PYTHON || 'python';
// 端口可用环境变量覆盖，便于与并行开发中的自测错开（默认即规格固定端口）。
const SMTP = Number(process.env.EC_SMTP || 25331);
const POP3 = Number(process.env.EC_POP3 || 25332);
const IMAP = Number(process.env.EC_IMAP || 25333);
const passed = [], failed = [];

function check(name, cond, extra) {
  if (cond) { passed.push(name); console.log('  [PASS]', name); }
  else { failed.push(name); console.log('  [FAIL]', name, extra || ''); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 测试数据只写 tests/tmp，跑完立即删除（避免明文测试配置残留）
const TMP = path.join(__dirname, 'tmp');
const mocks = [];
function cleanupTmp() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

async function api(port, method, p, body) {
  const res = await fetch('http://127.0.0.1:' + port + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function rawSmtpSend(port, raw) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    s.setTimeout(8000);
    s.on('error', reject);
    s.on('timeout', () => reject(new Error('timeout')));
    s.on('connect', () => {
      s.write('EHLO test\r\nMAIL FROM:<friend@example.com>\r\nRCPT TO:<me@test.local>\r\nDATA\r\n');
      const data = raw.split('\n').map((l) => l.replace(/\r$/, '')).map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n') + '\r\n.\r\n';
      s.write(data);
      s.write('QUIT\r\n');
    });
    s.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.split('\r\n').length > 14) { s.destroy(); resolve(true); }
      else if (buf.split('\r\n').length > 20) { s.destroy(); resolve(true); }
    });
    s.on('close', () => resolve(true));
  });
}

function inject(port, frm, subject, body) {
  const raw =
    `From: ${frm}\r\n` +
    'To: me@test.local\r\n' +
    `Subject: ${subject}\r\n` +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: text/plain; charset=UTF-8\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    Buffer.from(body, 'utf8').toString('base64');
  return rawSmtpSend(port, raw);
}

async function waitMock() {
  // poll the SMTP port until it accepts
  for (let i = 0; i < 50; i++) {
    try {
      const ok = await rawSmtpSend(SMTP, 'From: x@y\r\nTo: a@b\r\nSubject: warmup\r\n\r\nhi');
      if (ok) return;
    } catch (e) { /* not ready */ }
    await sleep(200);
  }
  throw new Error('mock server did not start');
}

// ------------------- 2.0 helpers: control HTTP + MIME build/parse -------------------
const CONTROL = Number(process.env.EC_CONTROL || 25334);
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function ctrl(method, p, body) {
  const opts = { method };
  if (body !== undefined) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      opts.headers = { 'Content-Type': 'application/octet-stream' };
      opts.body = body;
    } else {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch('http://127.0.0.1:' + CONTROL + p, opts);
  return res.json();
}

async function waitControl() {
  for (let i = 0; i < 60; i++) {
    try {
      const h = await ctrl('GET', '/health');
      if (h && h.ok) return;
    } catch (e) { /* not ready */ }
    await sleep(200);
  }
  throw new Error('mock control server did not start');
}

function spawnMockWithControl() {
  const m = spawn(PY, [path.join(__dirname, 'mock_mail.py'),
    '--smtp', String(SMTP), '--pop3', String(POP3), '--imap', String(IMAP),
    '--http', String(CONTROL)], { stdio: 'ignore' });
  mocks.push(m);
  return m;
}

async function getMails() { return (await ctrl('GET', '/mails')).mails || []; }
async function injectRaw(raw) { return ctrl('POST', '/inject', raw); }
async function resetMail() { return ctrl('POST', '/reset'); }
async function getImapSeen() { return await ctrl('GET', '/imap-seen'); }

function b64wrap(data, width = 76) {
  const s = Buffer.isBuffer(data) ? data.toString('base64')
    : Buffer.from(String(data), 'utf8').toString('base64');
  const chunks = [];
  for (let i = 0; i < s.length; i += width) chunks.push(s.slice(i, i + width));
  return chunks.join('\r\n');
}

function rfc2047(text) {
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  return '=?UTF-8?B?' + Buffer.from(text, 'utf8').toString('base64') + '?=';
}

function encodeFilename(name) {
  if (/^[\x00-\x7F]*$/.test(name)) return '"' + name + '"';
  return '"' + rfc2047(name) + '"';
}

function quoteHeaderValue(quote) {
  const payload = JSON.stringify({
    text: quote.text || '', from: quote.from || '',
    ts: quote.ts || 0, mid: quote.mid || '',
  });
  const b = Buffer.from(payload, 'utf8').toString('base64');
  const chunks = [];
  for (let i = 0; i < b.length; i += 76) chunks.push(b.slice(i, i + 76));
  return chunks.join('\r\n ');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function quoteBodyBlock(quote) {
  const d = quote.ts ? new Date(quote.ts * 1000) : null;
  const when = d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '';
  const lines = String(quote.text || '').split('\n').map((l) => '> ' + l).join('\n');
  return `\n\n--- 引用 ---\n> 发件人：${quote.from || ''}\n> 时间：${when}\n${lines}`;
}

function buildRawMessage(opts) {
  const o = opts || {};
  const frm = o.frm || 'friend@example.com';
  const to = o.to || 'me@test.local';
  let bodyText = o.body === undefined ? '正文内容' : String(o.body);
  const quote = o.quote;
  if (quote && o.appendQuoteBlock !== false) bodyText += quoteBodyBlock(quote);
  const headers = [];
  headers.push('From: ' + frm);
  headers.push('To: ' + to);
  if (o.cc) headers.push('Cc: ' + o.cc);
  headers.push('Subject: ' + rfc2047(o.subject || '测试邮件'));
  headers.push('Date: ' + new Date().toUTCString());
  if (o.mid) headers.push('Message-ID: ' + o.mid);
  headers.push('MIME-Version: 1.0');
  if (o.kind) headers.push('X-Email-Chatter-Kind: ' + o.kind);
  if (o.recall) headers.push('X-Email-Chatter-Recall: ' + o.recall);
  if (quote) headers.push('X-Email-Chatter-Quote: ' + quoteHeaderValue(quote));
  for (const [k, v] of Object.entries(o.extraHeaders || {})) headers.push(k + ': ' + v);
  const atts = o.attachments || [];
  if (!atts.length) {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: base64');
    return headers.join('\r\n') + '\r\n\r\n' + b64wrap(bodyText) + '\r\n';
  }
  const boundary = '=ec_node_' + Date.now().toString(36) + '_' + atts.length;
  headers.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  const parts = [];
  if (o.includeText !== false) {
    parts.push('--' + boundary, 'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64', '', b64wrap(bodyText));
  }
  for (const a of atts) {
    const data = a.data === undefined ? Buffer.alloc(0) : a.data;
    parts.push('--' + boundary,
      'Content-Type: ' + (a.mime || 'application/octet-stream') + '; name=' + encodeFilename(a.name || 'file.bin'),
      'Content-Disposition: attachment; filename=' + encodeFilename(a.name || 'file.bin'),
      'Content-Transfer-Encoding: base64', '', b64wrap(data));
  }
  parts.push('--' + boundary + '--', '');
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n') + '\r\n';
}

function decodeEncodedWords(v) {
  if (v === undefined || v === null) return v;
  return String(v).replace(/=\?UTF-8\?B\?([^?]+)\?=/gi,
    (_, b) => Buffer.from(b, 'base64').toString('utf8'));
}

function parseRawMail(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  const head = idx >= 0 ? raw.slice(0, idx) : raw;
  const body = idx >= 0 ? raw.slice(idx + 4) : '';
  const headers = {};
  let last = null;
  for (const line of head.split('\r\n')) {
    if (/^[ \t]/.test(line) && last) { headers[last] += ' ' + line.trim(); continue; }
    const i = line.indexOf(':');
    if (i > 0) { last = line.slice(0, i).trim().toLowerCase(); headers[last] = line.slice(i + 1).trim(); }
  }
  return { raw, headers, body };
}

function headerOf(mail, name) { return mail.headers[String(name).toLowerCase()]; }

function decodePayload(headers, body) {
  const cte = (headers['content-transfer-encoding'] || '').toLowerCase();
  if (cte === 'base64') {
    return Buffer.from(body.replace(/\r\n/g, '').replace(/\s+/g, ''), 'base64');
  }
  return Buffer.from(body, 'utf8');
}

function splitMultipart(mail) {
  const ct = mail.headers['content-type'] || '';
  const bm = /boundary="?([^";]+)"?/i.exec(ct);
  if (!bm) return [];
  const boundary = bm[1];
  const chunks = mail.body.split('--' + boundary);
  const parts = [];
  for (let chunk of chunks) {
    if (chunk.startsWith('--')) break;
    chunk = chunk.replace(/^\r\n/, '').replace(/\r\n$/, '');
    if (!chunk.trim()) continue;  // preamble
    const idx = chunk.indexOf('\r\n\r\n');
    const head = idx >= 0 ? chunk.slice(0, idx) : chunk;
    const body = idx >= 0 ? chunk.slice(idx + 4) : '';
    if (!head.includes(':')) continue;
    const headers = {};
    for (const line of head.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    parts.push({ headers, body });
  }
  return parts;
}

function isBodyPart(p) {
  const ct = (p.headers['content-type'] || '').toLowerCase();
  const cd = (p.headers['content-disposition'] || '').toLowerCase();
  const hasFilename = cd.includes('filename=') || ct.includes('name=');
  return !hasFilename && ct.startsWith('text/plain');
}

function mailBodyText(mail) {
  if ((mail.headers['content-type'] || '').toLowerCase().startsWith('multipart/')) {
    for (const p of splitMultipart(mail)) {
      if (isBodyPart(p)) return decodePayload(p.headers, p.body).toString('utf8');
    }
    return '';
  }
  return decodePayload(mail.headers, mail.body).toString('utf8');
}

function mailAttachments(mail) {
  if (!(mail.headers['content-type'] || '').toLowerCase().startsWith('multipart/')) return [];
  const out = [];
  for (const p of splitMultipart(mail)) {
    if (isBodyPart(p)) continue;
    const ct = p.headers['content-type'] || '';
    if (!ct && !p.headers['content-disposition']) continue;
    let fnm = /filename\*?="?([^";]+)"?/i.exec(p.headers['content-disposition'] || '');
    if (!fnm) fnm = /name\*?="?([^";]+)"?/i.exec(ct);
    let filename = fnm ? fnm[1] : null;
    if (filename && /^utf-8''/i.test(filename)) {
      filename = decodeURIComponent(filename.replace(/^utf-8''/i, ''));
    }
    out.push({
      filename: decodeEncodedWords(filename),
      mime: ct.split(';')[0].trim(),
      data: decodePayload(p.headers, p.body),
    });
  }
  return out;
}

function parseQuoteHeader(value) {
  if (!value) return null;
  const compact = String(value).replace(/\s+/g, '');
  return JSON.parse(Buffer.from(compact, 'base64').toString('utf8'));
}

function lastMailOf(mails) { return mails.length ? parseRawMail(mails[mails.length - 1].raw) : null; }

async function waitMessages(port, peer, pred, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  let msgs = [];
  while (Date.now() < deadline) {
    msgs = (await api(port, 'GET', '/api/messages?with=' + encodeURIComponent(peer))).messages || [];
    if (pred(msgs)) return msgs;
    await sleep(300);
  }
  return msgs;
}

async function uploadBuffer(port, name, buf, mime) {
  const res = await fetch('http://127.0.0.1:' + port + '/api/upload?name=' + encodeURIComponent(name), {
    method: 'POST', headers: { 'Content-Type': mime || 'application/octet-stream' }, body: buf,
  });
  return res.json();
}

async function getBytes(port, urlPath) {
  const res = await fetch('http://127.0.0.1:' + port + urlPath);
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

function makeStubHttp() {
  const httpMod = require('http');
  const payload = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(8), Buffer.alloc(2 * 1024 * 1024, 7)]);
  const stub = httpMod.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/missing') { res.writeHead(404); res.end('nope'); return; }
    if (p === '/redirect') { res.writeHead(302, { Location: '/file', 'Content-Length': 0 }); res.end(); return; }
    if (p === '/file') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
      res.end(payload); return;
    }
    if (p === '/slow-redirect') { res.writeHead(307, { Location: '/slow', 'Content-Length': 0 }); res.end(); return; }
    if (p === '/slow') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
      let off = 0;
      const timer = setInterval(() => {
        if (off >= payload.length) { clearInterval(timer); res.end(); return; }
        res.write(payload.slice(off, off + 16384));
        off += 16384;
      }, 20);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => {
    stub.listen(0, '127.0.0.1', () => resolve({ stub, port: stub.address().port }));
  });
}

// ------------------- 健壮性回归（reviewer High：JSON/QP/POP3/仅附件） -------------------
function buildQpMail(qpBody, frm = 'stranger@example.com') {
  return 'From: ' + frm + '\r\nTo: me@test.local\r\nSubject: qp-perf\r\n' +
    'Message-ID: <qp-perf@test.local>\r\nMIME-Version: 1.0\r\n' +
    'Content-Type: text/plain; charset=UTF-8\r\n' +
    'Content-Transfer-Encoding: quoted-printable\r\n\r\n' + qpBody + '\r\n';
}

// 生成约 sizeBytes 的 QP 邮件正文（每 76 列软换行，真实邮件形态）
function makeQpBody(sizeBytes) {
  const unit = '=E4=BD=A0=E5=A5=BD=E4=B8=96=E7=95=8C'; // 解码后「你好世界」
  const lines = [];
  let total = 0;
  while (total < sizeBytes) {
    lines.push(unit);
    total += unit.length + 3; // unit + "=\r\n"
  }
  return lines.join('=\r\n');
}

function buildLargeBase64Mail(bytes, frm = 'stranger@example.com', longLine = false) {
  const payload = Buffer.alloc(bytes, 0x41); // 'A' * bytes
  const b64 = payload.toString('base64');
  const body = longLine ? b64 : (b64.match(/.{1,76}/g) || []).join('\r\n');
  return 'From: ' + frm + '\r\nTo: me@test.local\r\nSubject: big-mail\r\n' +
    'Message-ID: <big-mail@test.local>\r\nMIME-Version: 1.0\r\n' +
    'Content-Type: text/plain; charset=UTF-8\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' + body + '\r\n';
}

async function nodeScenarioResilience(webDir) {
  console.log('== Node 健壮性回归（reviewer High）==');
  const peer = 'friend@example.com';
  const mockR = spawnMockWithControl();
  await waitControl();
  const dataDir7 = path.join(TMP, 'node-data7');
  fs.rmSync(dataDir7, { recursive: true, force: true });
  const inst7 = await startServer({ port: 0, webDir, dataDir: dataDir7 });
  const port = inst7.port;
  const cfg = {
    email: 'me@test.local', display_name: '我', password: 'authcode', mode: 'pop3',
    pop3: { host: '127.0.0.1', port: POP3, ssl: false },
    smtp: { host: '127.0.0.1', port: SMTP, ssl: false },
    poll_interval: 3, auto_poll: false, ai: { enabled: false },
  };
  const be = require('../electron/backend.js');
  // mock 邮箱 reset 后 UID 会从 uid1 重新开始；清掉应用侧 seen，
  // 否则后续注入会被当成「已读」跳过（M1 用例曾因此偶发失败）。
  const resetSeen = () => { try { inst7.app.store.seenPop3.clear(); } catch (e) { /* ignore */ } };
  try {
    await api(port, 'POST', '/api/config', cfg);
    await api(port, 'POST', '/api/friends', { action: 'add', email: peer, name: '小明' });

    // ---- H2: parseMessage 400KB quoted-printable < 2s（旧 O(n²) 约 9s）----
    be.parseMessage(Buffer.from(buildQpMail('=E4=BD=A0=E5=A5=BD')));  // warmup
    const qpRaw = buildQpMail(makeQpBody(400 * 1024));
    const h2t0 = process.hrtime.bigint();
    const qpMsg = be.parseMessage(Buffer.from(qpRaw));
    const h2ms = Number(process.hrtime.bigint() - h2t0) / 1e6;
    console.log('  [TIME] R1 parseMessage 400KB QP = ' + h2ms.toFixed(1) + 'ms');
    check('R1 H2 Node parseMessage 400KB QP < 2s', h2ms < 2000
      && qpMsg && typeof qpMsg.body_text === 'string' && qpMsg.body_text.length > 0,
      'dt=' + h2ms.toFixed(1) + 'ms text_len=' + (qpMsg && qpMsg.body_text ? qpMsg.body_text.length : -1));

    // ---- H3: POP3 2.5MB 邮件（76 列 base64）拉取+解析 < 2s ----
    // 直接对核心 pop3Fetch 计时（POST /api/poll 只是 triggerPoll 立即返回，且
    // pollStatus.last_ts 是秒级、同秒内可能观测不到；这里同时做集成存活断言）。
    await sleep(300);  // 让保存配置触发的首次收信先结束
    await resetMail();
    resetSeen();
    await injectRaw(buildLargeBase64Mail(2.5 * 1024 * 1024));
    const popCfg = { host: '127.0.0.1', port: POP3, ssl: false, user: 'me@test.local', pass: 'authcode' };
    const h3t0 = process.hrtime.bigint();
    const h3res = await be.pop3Fetch(popCfg, new Set());
    const h3ms = Number(process.hrtime.bigint() - h3t0) / 1e6;
    const h3msg = (h3res.messages || [])[0] || {};
    console.log('  [TIME] R2 pop3Fetch 2.5MB mail = ' + h3ms.toFixed(1) + 'ms text_len='
      + (h3msg.body_text ? h3msg.body_text.length : -1));
    check('R2 H3 Node POP3 2.5MB 邮件拉取+解析 < 2s', h3ms < 2000
      && (h3res.messages || []).length === 1 && typeof h3msg.body_text === 'string'
      && h3msg.body_text.length > 0,
      'dt=' + h3ms.toFixed(1) + 'ms msgs=' + (h3res.messages || []).length);
    // 集成：触发 /api/poll 后客户端仍响应、poll 状态正常
    await api(port, 'POST', '/api/poll', {});
    await sleep(1200);
    const stAfterBig = await api(port, 'GET', '/api/state');
    check('R2b H3 大邮件后客户端仍响应且 poll ok', !!stAfterBig && !!stAfterBig.poll
      && stAfterBig.poll.ok === true, JSON.stringify(stAfterBig.poll || null));

    // ---- H3b: >50MB 单封邮件在 POP3 层被跳过（单元级）----
    await resetMail();
    const bigRaw = buildLargeBase64Mail(51 * 1024 * 1024, 'stranger@example.com', false);
    await injectRaw(bigRaw);
    const h3bt0 = process.hrtime.bigint();
    const fetched = await be.pop3Fetch({
      host: '127.0.0.1', port: POP3, ssl: false, user: 'me@test.local', pass: 'authcode',
    }, new Set());
    const h3bms = Number(process.hrtime.bigint() - h3bt0) / 1e6;
    console.log('  [TIME] R3 pop3Fetch 51MB mail skip = ' + h3bms.toFixed(0) + 'ms');
    check('R3 H3b >50MB 单封被跳过且不慢', fetched.messages.length === 0
      && fetched.newKeys.length === 1 && h3bms < 15000,
      'dt=' + h3bms.toFixed(0) + 'ms msgs=' + fetched.messages.length
      + ' newKeys=' + fetched.newKeys.length);

    // ---- M1: 仅附件、无文本段 -> text 空串 + attachments 1 项 ----
    await resetMail();
    resetSeen();
    await injectRaw(buildRawMessage({
      frm: peer, to: 'me@test.local', subject: '仅附件 Node', body: '',
      includeText: false, mid: '<only-attach-node@test.local>',
      attachments: [{ name: 'only.png', mime: 'image/png', data: PNG_1X1 }],
    }));
    await api(port, 'POST', '/api/poll', {});
    let rmsgs = await waitMessages(port, peer, (m) => m.some((x) => x.mid === '<only-attach-node@test.local>'), 10000);
    const only = rmsgs.find((m) => m.mid === '<only-attach-node@test.local>') || null;
    check('R4 M1 Node 仅附件邮件 text==""', only !== null && only.text === '',
      JSON.stringify(only && { text: only.text, mid: only.mid }));
    const onlyAtts = (only && only.attachments) || [];
    let onlyGet = { status: 0, buf: Buffer.alloc(0) };
    if (onlyAtts.length === 1) onlyGet = await getBytes(port, onlyAtts[0].url);
    check('R5 M1 Node 仅附件邮件 attachments 1 项且可下载',
      onlyAtts.length === 1 && onlyAtts[0].mime === 'image/png' && onlyAtts[0].inline === true
      && onlyGet.status === 200 && onlyGet.buf.equals(PNG_1X1),
      JSON.stringify(onlyAtts));
  } finally {
    stopServer(inst7);
    try { mockR.kill(); } catch (e) { /* ignore */ }
  }
}

// ------------------- 2.1 未读语义 / 删除好友 / 引用=reply（Node 版） -------------------
async function nodeScenarioUnreadReply(webDir) {
  console.log('== Node 2.1 未读语义 / 删除好友 / 引用=reply ==');
  const peer = 'friend@example.com';
  const mockQ = spawnMockWithControl();
  await waitControl();
  const dataDir8 = path.join(TMP, 'node-data8');
  fs.rmSync(dataDir8, { recursive: true, force: true });
  const inst8 = await startServer({ port: 0, webDir, dataDir: dataDir8 });
  const port = inst8.port;
  try {
    await api(port, 'POST', '/api/config', {
      email: 'me@test.local', display_name: '我', password: 'authcode', mode: 'imap',
      imap: { host: '127.0.0.1', port: IMAP, ssl: false },
      smtp: { host: '127.0.0.1', port: SMTP, ssl: false },
      poll_interval: 3, auto_poll: false, ai: { enabled: false },
    });
    await api(port, 'POST', '/api/friends', { action: 'add', email: peer, name: '小明' });

    // ---- 非好友邮件：拉取但保持未读、不显示 ----
    await resetMail();
    await injectRaw(buildRawMessage({
      frm: 'stranger@example.com', to: 'me@test.local', subject: '陌生人邮件',
      body: '非好友正文', mid: '<stranger-21@test.local>',
    }));
    await api(port, 'POST', '/api/poll', {});
    await sleep(1800);
    let seenRes = await getImapSeen();
    let msgs = (await api(port, 'GET', '/api/messages?with=' + encodeURIComponent(peer))).messages || [];
    check('Q1 Node 非好友邮件不在聊天显示',
      !msgs.some((m) => String(m.text || '').includes('非好友正文')),
      JSON.stringify(msgs.map((m) => m.text)));
    check('Q2 Node 非好友邮件在邮箱保持未读', Array.isArray(seenRes.seen) && seenRes.seen.length === 0,
      JSON.stringify(seenRes));
    let st = await api(port, 'GET', '/api/state');
    let fr = (st.friends || []).find((f) => f.email === peer) || {};
    check('Q3 Node 非好友邮件不影响好友未读', (fr.unread || 0) === 0, JSON.stringify(fr));

    // ---- 好友邮件：拉取后仍保持未读；/api/read 后才标服务器已读 ----
    await injectRaw(buildRawMessage({
      frm: peer, to: 'me@test.local', subject: '好友新邮件', body: '好友正文21',
      mid: '<friend-21@test.local>',
    }));
    await api(port, 'POST', '/api/poll', {});
    msgs = await waitMessages(port, peer, (m) => m.some((x) => String(x.text || '').includes('好友正文21')), 10000);
    const fm = msgs.find((x) => String(x.text || '').includes('好友正文21')) || {};
    st = await api(port, 'GET', '/api/state');
    fr = (st.friends || []).find((f) => f.email === peer) || {};
    seenRes = await getImapSeen();
    check('Q4 Node 好友邮件显示且未读=1', !!fm.text && (fr.unread || 0) === 1,
      JSON.stringify({ unread: fr.unread, text: fm.text }));
    check('Q5 Node 好友邮件拉取后邮箱仍未读', !(seenRes.seen || []).includes(2),
      JSON.stringify(seenRes));
    check('Q6 Node 收件消息记录 IMAP uid', String(fm.uid || '') === '2', String(fm.uid));

    await api(port, 'POST', '/api/read', { with: peer });
    await sleep(2500);
    await api(port, 'POST', '/api/poll', {});
    await sleep(1800);
    seenRes = await getImapSeen();
    st = await api(port, 'GET', '/api/state');
    fr = (st.friends || []).find((f) => f.email === peer) || {};
    check('Q7 Node /api/read 后服务器标记该 uid 已读、其它不受影响',
      (seenRes.seen || []).includes(2) && !(seenRes.seen || []).includes(1), JSON.stringify(seenRes));
    check('Q8 Node /api/read 后本地未读清零', (fr.unread || 0) === 0, JSON.stringify(fr));

    // ---- 删除好友：不改邮箱、未读邮件仍 unseen ----
    await injectRaw(buildRawMessage({
      frm: peer, to: 'me@test.local', subject: '删除前未读', body: '删除前未读正文',
      mid: '<friend-21b@test.local>',
    }));
    await api(port, 'POST', '/api/poll', {});
    await waitMessages(port, peer, (m) => m.some((x) => String(x.text || '').includes('删除前未读正文')), 10000);
    const beforeDel = await getImapSeen();
    const rawCount = beforeDel.count;
    const seenBefore = JSON.stringify(beforeDel.seen || []);
    await api(port, 'POST', '/api/friends', { action: 'remove', email: peer });
    await sleep(800);
    const afterDel = await getImapSeen();
    msgs = (await api(port, 'GET', '/api/messages?with=' + encodeURIComponent(peer))).messages || [];
    check('Q9 Node 删除好友不改邮箱邮件', afterDel.count === rawCount,
      JSON.stringify({ before: rawCount, after: afterDel.count }));
    check('Q10 Node 删除好友后未读邮件仍 unseen',
      !(afterDel.seen || []).includes(3) && JSON.stringify(afterDel.seen || []) === seenBefore,
      JSON.stringify(afterDel));
    check('Q11 Node 删除好友后本地会话清除', msgs.length === 0, JSON.stringify(msgs.length));

    // ---- 引用=reply ----
    await api(port, 'POST', '/api/friends', { action: 'add', email: peer, name: '小明' });
    const qmid = '<orig-thread-21@example.com>';
    const quote = { text: '被回复的原文', from: '小明', ts: 1729990000, mid: qmid };
    let r = await api(port, 'POST', '/api/send', { to: peer, text: '聊天回复正文', quote });
    let mails = await getMails();
    let mail = lastMailOf(mails);
    let subj = mail ? decodeEncodedWords(headerOf(mail, 'subject')) : '';
    check('Q12 Node chat+quote.mid：Subject 加 Re: 前缀',
      r.ok === true && subj.startsWith('Re: ') && subj.includes('email-chatter 消息'), subj);
    check('Q13 Node chat+quote.mid：In-Reply-To/References=mid',
      mail && headerOf(mail, 'in-reply-to') === qmid && headerOf(mail, 'references') === qmid,
      JSON.stringify(mail && { irt: headerOf(mail, 'in-reply-to'), refs: headerOf(mail, 'references') }));
    const bodyDecoded = mail ? mailBodyText(mail) : '';
    check('Q14 Node quote 头与可读引用块保留',
      mail && headerOf(mail, 'x-email-chatter-quote') !== undefined && bodyDecoded.includes('--- 引用 ---'),
      JSON.stringify(bodyDecoded.slice(0, 120)));

    r = await api(port, 'POST', '/api/send', {
      to: peer, kind: 'email', subject: '项目讨论', text: '邮件回复正文', quote,
    });
    mails = await getMails();
    mail = lastMailOf(mails);
    subj = mail ? decodeEncodedWords(headerOf(mail, 'subject')) : '';
    check('Q15 Node email+quote.mid：Subject=Re: 用户主题且线程头正确',
      r.ok === true && subj === 'Re: 项目讨论'
      && headerOf(mail, 'in-reply-to') === qmid && headerOf(mail, 'references') === qmid, subj);
    msgs = (await api(port, 'GET', '/api/messages?with=' + encodeURIComponent(peer))).messages || [];
    const outMail = msgs.find((m) => m.text === '邮件回复正文') || {};
    check('Q16 Node 本地发件消息 subject 记录 Re: 前缀', outMail.subject === 'Re: 项目讨论',
      JSON.stringify(outMail.subject));

    const quoteNoMid = { text: '没有消息号的引用', from: '小明', ts: 1729990000, mid: '' };
    r = await api(port, 'POST', '/api/send', { to: peer, text: '无 mid 聊天回复', quote: quoteNoMid });
    mails = await getMails();
    mail = lastMailOf(mails);
    subj = mail ? decodeEncodedWords(headerOf(mail, 'subject')) : '';
    check('Q17 Node 无 mid：Subject 不加 Re: 且无 In-Reply-To/References',
      r.ok === true && subj === 'email-chatter 消息' && !headerOf(mail, 'in-reply-to')
      && !headerOf(mail, 'references') && headerOf(mail, 'x-email-chatter-quote') !== undefined, subj);
    r = await api(port, 'POST', '/api/send', {
      to: peer, kind: 'email', subject: '会议纪要', text: '无 mid 邮件回复', quote: quoteNoMid,
    });
    mails = await getMails();
    mail = lastMailOf(mails);
    subj = mail ? decodeEncodedWords(headerOf(mail, 'subject')) : '';
    check('Q18 Node 无 mid email：Subject 保持用户主题且无线程头',
      r.ok === true && subj === '会议纪要' && !headerOf(mail, 'in-reply-to')
      && !headerOf(mail, 'references'), subj);
  } finally {
    stopServer(inst8);
    try { mockQ.kill(); } catch (e) { /* ignore */ }
  }
}

// ------------------- 2.0 新功能场景（J/K/L/M/N 的 Node 版） -------------------
async function nodeScenarioNewFeatures(webDir) {
  const peer = 'friend@example.com';
  const mockN = spawnMockWithControl();
  await waitControl();
  const dataDir5 = path.join(TMP, 'node-data5');
  fs.rmSync(dataDir5, { recursive: true, force: true });
  const inst5 = await startServer({ port: 0, webDir, dataDir: dataDir5 });
  const port = inst5.port;

  const mockCfg = {
    email: 'me@test.local', display_name: '我', password: 'authcode', mode: 'pop3',
    pop3: { host: '127.0.0.1', port: POP3, ssl: false },
    smtp: { host: '127.0.0.1', port: SMTP, ssl: false },
    poll_interval: 3,
  };
  let r;
  try {
    r = await api(port, 'POST', '/api/config', { ...mockCfg, ai: { enabled: false } });
    check('N25 新配置保存(含 ai)', r.ok === true, JSON.stringify(r));
    await api(port, 'POST', '/api/friends', { action: 'add', email: peer, name: '小明' });

    // ---------- 扩展邮件模式 ----------
    await resetMail();
    const quote = { text: '被引用的原文第一行\n被引用的原文第二行', from: '小明', ts: 1729990000, mid: '<orig-1@test.local>' };
    const subject = '项目周会安排';
    const bodyText = '第一行正文\n第二行有\t制表符';
    r = await api(port, 'POST', '/api/send', {
      to: peer, kind: 'email', subject, text: bodyText,
      cc: 'cc1@example.com, cc2@example.com', bcc: 'bcc@example.com', quote,
    });
    check('N26 邮件模式发送成功/主题(Re:)/ai=false',
      r.ok === true && r.subject === 'Re: ' + subject && r.ai === false, JSON.stringify(r));
    let mails = await getMails();
    let mail = lastMailOf(mails);
    check('N27 SMTP raw 是标准邮件且有 Kind=email + Re:/In-Reply-To',
      mails.length === 1 && mail && decodeEncodedWords(headerOf(mail, 'subject')) === 'Re: ' + subject
      && headerOf(mail, 'x-email-chatter-kind') === 'email'
      && headerOf(mail, 'in-reply-to') === quote.mid
      && headerOf(mail, 'references') === quote.mid,
      JSON.stringify(mail && { subject: headerOf(mail, 'subject'), kind: headerOf(mail, 'x-email-chatter-kind'),
        irt: headerOf(mail, 'in-reply-to'), refs: headerOf(mail, 'references') }));
    const env = mails.length ? mails[mails.length - 1].envelope : {};
    const rcptSet = new Set(env.rcpts || []);
    check('N28 Cc 写头 / Bcc 只进信封',
      mail && String(headerOf(mail, 'cc')).includes('cc1@example.com')
      && headerOf(mail, 'bcc') === undefined
      && rcptSet.has('friend@example.com') && rcptSet.has('cc1@example.com')
      && rcptSet.has('cc2@example.com') && rcptSet.has('bcc@example.com'),
      JSON.stringify(env));
    const bodyDecoded = mail ? mailBodyText(mail) : '';
    check('N29 正文换行/Tab 与引用块',
      bodyDecoded.includes(bodyText) && bodyDecoded.includes('--- 引用 ---')
      && bodyDecoded.includes('> 发件人：小明'), JSON.stringify(bodyDecoded.slice(0, 160)));
    let qh = null;
    try { qh = parseQuoteHeader(mail && headerOf(mail, 'x-email-chatter-quote')); } catch (e) { qh = null; }
    check('N30 quote 头可解析', qh && qh.text === quote.text && qh.from === quote.from
      && qh.mid === quote.mid && qh.ts === quote.ts, JSON.stringify(qh));
    let msgs = await waitMessages(port, peer, (m) => m.some((x) => x.kind === 'email' && x.dir === 'out'));
    const localOut = msgs.filter((x) => x.dir === 'out' && x.kind === 'email').pop() || {};
    check('N31 本地邮件消息字段(kind/subject(Re:)/mid/quote)',
      localOut.kind === 'email' && localOut.subject === 'Re: ' + subject && !!localOut.mid
      && localOut.quote && localOut.quote.text === quote.text && localOut.recalled === false,
      JSON.stringify({ kind: localOut.kind, subject: localOut.subject, mid: localOut.mid, quote: localOut.quote }));
    let st = await api(port, 'GET', '/api/state');
    const fr = st.friends.find((f) => f.email === peer);
    check('N32 last_text 预览=主题（Re:）', fr && fr.last_text === 'Re: ' + subject, JSON.stringify(fr));
    r = await api(port, 'POST', '/api/send', { to: peer, text: '普通聊天' });
    check('N33 chat 模式固定主题', r.ok === true && r.subject === 'email-chatter 消息', JSON.stringify(r));

    // ---------- 上传 / 附件发送与接收 ----------
    await resetMail();
    const txtBuf = Buffer.from('这是一个文本附件。\n第二行', 'utf8');
    const upImg = await uploadBuffer(port, 'photo.png', PNG_1X1, 'image/png');
    check('N34 上传图片', upImg.ok === true && String(upImg.id).startsWith('u_')
      && upImg.name === 'photo.png' && upImg.size === PNG_1X1.length && upImg.mime === 'image/png',
      JSON.stringify(upImg));
    const upTxt = await uploadBuffer(port, '报告附件.txt', txtBuf, 'text/plain');
    check('N35 上传中文文件名', upTxt.ok === true && upTxt.name === '报告附件.txt'
      && upTxt.size === txtBuf.length, JSON.stringify(upTxt));
    r = await api(port, 'POST', '/api/send', {
      to: peer, text: '看附件',
      attachments: [{ id: upImg.id, name: upImg.name }, { id: upTxt.id, name: upTxt.name }],
    });
    check('N36 带附件发送成功', r.ok === true, JSON.stringify(r));
    mails = await getMails();
    mail = lastMailOf(mails);
    const atts = mail ? mailAttachments(mail) : [];
    check('N37 发出邮件是 multipart 且附件字节一致',
      mail && (mail.headers['content-type'] || '').startsWith('multipart/mixed')
      && atts.some((a) => a.mime === 'image/png' && a.data.equals(PNG_1X1))
      && atts.some((a) => a.filename === '报告附件.txt' && a.data.equals(txtBuf)),
      JSON.stringify(atts.map((a) => [a.filename, a.mime, a.data.length])));
    check('N38 发出正文可读', mailBodyText(mail).includes('看附件'), JSON.stringify(mailBodyText(mail).slice(0, 80)));
    msgs = await waitMessages(port, peer, (m) => m.some((x) => x.dir === 'out' && (x.attachments || []).length));
    const outAtt = msgs.filter((x) => x.dir === 'out' && (x.attachments || []).length).pop() || {};
    const la = outAtt.attachments || [];
    check('N39 本地 attachments 元数据完整', la.length === 2 && la[0].mime === 'image/png'
      && la[0].inline === true && la[0].size === PNG_1X1.length
      && String(la[0].url || '').startsWith('/api/attachment?file=')
      && la[1].inline === false, JSON.stringify(la));
    let g = { status: 0, buf: Buffer.alloc(0) };
    if (la.length === 2) g = await getBytes(port, la[0].url);
    check('N40 GET /api/attachment 原始字节', g.status === 200 && g.buf.equals(PNG_1X1),
      'status=' + g.status + ' len=' + g.buf.length);
    const trav = await getBytes(port, '/api/attachment?file=..%2Fconfig.json');
    check('N41 附件路径穿越被拒绝', [400, 403, 404].includes(trav.status), 'status=' + trav.status);

    const inRaw = buildRawMessage({
      frm: peer, to: 'me@test.local', subject: '收到的附件', body: '请查收图片和文件',
      mid: '<in-attach-node@test.local>',
      attachments: [{ name: 'inbox.png', mime: 'image/png', data: PNG_1X1 },
        { name: '清单.csv', mime: 'text/csv', data: Buffer.from('a,b\n1,2', 'utf8') }],
    });
    await injectRaw(inRaw);
    await api(port, 'POST', '/api/poll', {});
    msgs = await waitMessages(port, peer, (m) => m.some((x) => x.dir === 'in' && (x.attachments || []).length), 10000);
    const inAtt = msgs.filter((x) => x.dir === 'in' && (x.attachments || []).length).pop() || {};
    const ia = inAtt.attachments || [];
    let inGet = { status: 0, buf: Buffer.alloc(0) };
    if (ia.length === 2) inGet = await getBytes(port, ia[0].url);
    check('N42 收信附件元数据+下载+正文', ia.length === 2 && ia[0].inline === true
      && ia[1].inline === false && inGet.status === 200 && inGet.buf.equals(PNG_1X1)
      && String(inAtt.text || '').includes('请查收图片和文件'), JSON.stringify(ia));

    // ---------- 引用 / 撤回 ----------
    await resetMail();
    r = await api(port, 'POST', '/api/send', { to: peer, text: '原始聊天消息' });
    msgs = await waitMessages(port, peer, (m) => m.some((x) => x.dir === 'out' && x.text === '原始聊天消息'));
    const origMsg = msgs.find((x) => x.dir === 'out' && x.text === '原始聊天消息') || {};
    check('N43 发件消息记录 mid', r.ok === true && !!origMsg.mid, JSON.stringify({ id: origMsg.id, mid: origMsg.mid }));
    r = await api(port, 'POST', '/api/recall', { with: peer, id: origMsg.id });
    mails = await getMails();
    mail = lastMailOf(mails);
    check('N44 撤回发送：SMTP 通知邮件', r.ok === true && mail
      && headerOf(mail, 'x-email-chatter-kind') === 'recall'
      && decodeEncodedWords(headerOf(mail, 'subject')) === '撤回了一条消息'
      && String(headerOf(mail, 'x-email-chatter-recall') || '').includes(origMsg.mid || ''),
      JSON.stringify({ r, kind: mail && headerOf(mail, 'x-email-chatter-kind'), recall: mail && headerOf(mail, 'x-email-chatter-recall') }));
    msgs = await waitMessages(port, peer, (m) => m.some((x) => x.id === origMsg.id && x.recalled));
    const recMsg = msgs.find((x) => x.id === origMsg.id) || {};
    check('N45 本地消息 recalled=true', recMsg.recalled === true, JSON.stringify(recMsg.recalled));
    r = await api(port, 'POST', '/api/recall', { with: peer, id: origMsg.id });
    check('N46 重复撤回被拒绝', r.ok === false && !!r.error, JSON.stringify(r));

    // 接收引用邮件
    const quote2 = { text: '对方引用的内容\n第二行', from: '小明', ts: 1730000000, mid: '<in-quote-node@test.local>' };
    await injectRaw(buildRawMessage({
      frm: peer, to: 'me@test.local', subject: '邮件回复', body: '我的邮件回复',
      mid: '<in-quote-node@test.local>', kind: 'email', quote: quote2,
    }));
    await api(port, 'POST', '/api/poll', {});
    msgs = await waitMessages(port, peer, (m) => m.some((x) => x.text === '我的邮件回复'), 10000);
    const inQuote = msgs.find((x) => x.text === '我的邮件回复') || {};
    check('N47 接收引用邮件(quote 字段/正文剥离)',
      inQuote.kind === 'email' && inQuote.subject === '邮件回复'
      && inQuote.quote && inQuote.quote.text === quote2.text
      && !String(inQuote.text).includes('--- 引用 ---'), JSON.stringify({ t: inQuote.text, q: inQuote.quote }));

    // 接收撤回通知
    const beforeRecall = msgs.length;
    await injectRaw(buildRawMessage({
      frm: peer, to: 'me@test.local', subject: '撤回了一条消息', body: '对方撤回了一条消息',
      kind: 'recall', recall: '<in-quote-node@test.local>', mid: '<recall-notice-node@test.local>',
    }));
    await api(port, 'POST', '/api/poll', {});
    msgs = await waitMessages(port, peer, (m) => m.some((x) => x.mid === '<in-quote-node@test.local>' && x.recalled), 10000);
    const recalledIn = msgs.find((x) => x.mid === '<in-quote-node@test.local>') || {};
    check('N48 接收撤回：目标 recalled 且不新增消息',
      recalledIn.recalled === true && msgs.length === beforeRecall,
      JSON.stringify({ recalled: recalledIn.recalled, before: beforeRecall, now: msgs.length }));

    // pending_recalls
    const unknownMid = '<pending-node@test.local>';
    await injectRaw(buildRawMessage({
      frm: peer, to: 'me@test.local', subject: '撤回了一条消息', body: '对方撤回了一条消息',
      kind: 'recall', recall: unknownMid, mid: '<recall-pending-node@test.local>',
    }));
    await api(port, 'POST', '/api/poll', {});
    await sleep(1800);
    const cfgAfter = JSON.parse(fs.readFileSync(path.join(dataDir5, 'config.json'), 'utf8'));
    check('N49 未知撤回进入 pending_recalls',
      JSON.stringify(cfgAfter).includes(unknownMid), JSON.stringify(cfgAfter).slice(0, 300));
    let nowMsgs = (await api(port, 'GET', '/api/messages?with=' + encodeURIComponent(peer))).messages;
    await injectRaw(buildRawMessage({ frm: peer, to: 'me@test.local', subject: '迟到来信',
      body: '这封应该被丢弃', mid: unknownMid }));
    await api(port, 'POST', '/api/poll', {});
    await sleep(1800);
    nowMsgs = (await api(port, 'GET', '/api/messages?with=' + encodeURIComponent(peer))).messages;
    check('N50 pending mid 的迟到来信被丢弃',
      !nowMsgs.some((m) => m.text === '这封应该被丢弃'), JSON.stringify(nowMsgs.map((m) => m.text)));

    // ---------- AI 状态 / 配置 / 回落 / 下载失败 ----------
    st = await api(port, 'GET', '/api/state');
    const required = ['enabled', 'model_ready', 'downloading', 'downloaded_bytes', 'total_bytes',
      'percent', 'error', 'model_file', 'mirror', 'busy', 'engine'];
    check('N51 AI 状态字段完整/默认关闭',
      st.ai && required.every((k) => k in st.ai) && st.ai.enabled === false && st.ai.model_ready === false,
      JSON.stringify(st.ai));
    let stt = await api(port, 'GET', '/api/ai/status');
    check('N52 /api/ai/status ok+ai', stt.ok === true && stt.ai && required.every((k) => k in stt.ai),
      JSON.stringify(stt).slice(0, 300));
    r = await api(port, 'POST', '/api/config', { ai: { enabled: true, mirror: 'http://127.0.0.1:9/' } });
    st = await api(port, 'GET', '/api/state');
    check('N53 ai 配置保存并回显', r.ok === true && st.account.ai.enabled === true
      && st.account.ai.mirror === 'http://127.0.0.1:9/' && st.ai.enabled === true,
      JSON.stringify({ acc: st.account.ai, top: st.ai }));
    r = await api(port, 'POST', '/api/ai/title', { text: '周六早上八点香山门口集合，别迟到！' });
    check('N54 未下载时 title 回落启发式', r.ok === true && r.source === 'heuristic'
      && !!r.subject && r.subject.length <= 31 && r.subject.includes('香山'), JSON.stringify(r));
    r = await api(port, 'POST', '/api/ai/title', { text: '' });
    check('N55 空正文标题=无主题', r.ok === true && r.source === 'heuristic' && r.subject === '无主题',
      JSON.stringify(r));
    r = await api(port, 'POST', '/api/send', { to: peer, text: 'AI 开启但模型未下载' });
    check('N56 AI 未就绪 chat 回落固定主题', r.ok === true && r.subject === 'email-chatter 消息' && r.ai === false,
      JSON.stringify(r));
    r = await api(port, 'POST', '/api/send', { to: peer, kind: 'email', text: '这条邮件没有主题需要自动生成' });
    check('N57 AI 未就绪 email 回落启发式', r.ok === true && !!r.subject
      && r.subject !== 'email-chatter 消息' && r.ai === false, JSON.stringify(r));

    await api(port, 'POST', '/api/config', { ai: { enabled: true, model_url: 'http://127.0.0.1:1/x.gguf' } });
    const t0 = Date.now();
    const rd = await api(port, 'POST', '/api/ai/download', {});
    const dt = Date.now() - t0;
    check('N58 下载接口立即返回', rd.ok === true && dt < 10000, 'dt=' + dt + ' ' + JSON.stringify(rd));
    let aiNow = {};
    let slow = 0;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const ts = Date.now();
      const sj = await api(port, 'GET', '/api/ai/status');
      if (Date.now() - ts > 3000) slow += 1;
      aiNow = sj.ai || {};
      if (!aiNow.downloading && (aiNow.error || aiNow.model_ready)) break;
      await sleep(400);
    }
    check('N59 下载失败优雅报错', aiNow.downloading === false && aiNow.model_ready === false
      && !!aiNow.error, JSON.stringify(aiNow));
    check('N60 /api/ai/status 快速返回', slow === 0, 'slow=' + slow);
    r = await api(port, 'POST', '/api/ai/cancel', {});
    check('N61 取消接口可用', r.ok === true && r.ai && typeof r.ai.downloading === 'boolean',
      JSON.stringify(r).slice(0, 200));

    // 本地 stub：重定向/进度/取消（Node 用 http 模块，本地 http:// 应可用）
    const stubInfo = await makeStubHttp();
    try {
      await api(port, 'POST', '/api/config', {
        ai: { enabled: true, model_url: 'http://127.0.0.1:' + stubInfo.port + '/slow-redirect' },
      });
      await api(port, 'POST', '/api/ai/download', {});
      let prog = null;
      const samples = [];
      const dl2 = Date.now() + 12000;
      while (Date.now() < dl2) {
        const sj = await api(port, 'GET', '/api/ai/status');
        const ai = sj.ai || {};
        samples.push({ d: ai.downloading, b: ai.downloaded_bytes, e: ai.error });
        if (samples.length > 8) samples.shift();
        if (ai.downloading && ai.downloaded_bytes > 0) { prog = ai; break; }
        if (!ai.downloading && ai.error) { prog = ai; break; }
        await sleep(150);
      }
      if (!prog) {
        check('N62 stub 重定向/进度/取消', false, '12s 内无下载进度: ' + JSON.stringify(samples));
      } else if (!prog.downloading && prog.error && !prog.downloaded_bytes) {
        check('N62 stub 重定向/进度/取消', false, '本地 http 直链未开始: ' + String(prog.error).slice(0, 120));
      } else {
        check('N62 stub 重定向后下载有进度', prog.downloaded_bytes > 0 && prog.total_bytes > 0,
          JSON.stringify(prog));
        await api(port, 'POST', '/api/ai/cancel', {});
        let stopped = false;
        const dl3 = Date.now() + 8000;
        while (Date.now() < dl3) {
          const ai = (await api(port, 'GET', '/api/ai/status')).ai || {};
          if (!ai.downloading) { stopped = true; break; }
          await sleep(300);
        }
        const modelDir = path.join(dataDir5, 'models');
        const parts = fs.existsSync(modelDir) ? fs.readdirSync(modelDir).filter((f) => f.endsWith('.part')) : [];
        check('N63 取消后停止且删除 .part', stopped && parts.length === 0,
          'stopped=' + stopped + ' parts=' + JSON.stringify(parts));
      }
    } finally {
      try { stubInfo.stub.close(); } catch (e) { /* ignore */ }
    }
  } finally {
    stopServer(inst5);
  }

  try {
  // ---------- 旧数据兼容 ----------
  const dataDir6 = path.join(TMP, 'node-data6');
  fs.rmSync(dataDir6, { recursive: true, force: true });
  fs.mkdirSync(dataDir6, { recursive: true });
  const oldCfg = {
    email: 'me@test.local', display_name: '我', password: 'authcode', mode: 'pop3',
    poll_interval: 3, auto_poll: true,
    pop3: { host: '127.0.0.1', port: POP3, ssl: false },
    imap: { host: '127.0.0.1', port: IMAP, ssl: false },
    smtp: { host: '127.0.0.1', port: SMTP, ssl: false },
    friends: [{ email: peer, name: '小明', note: '旧备注', added_at: 1729000000 }],
    seen_pop3: [], seen_imap: [], unread: { [peer]: 0 }, next_msg_id: 3,
  };
  const oldMsgs = { conversations: { [peer]: [
    { id: 1, dir: 'in', text: '旧版收到的消息', ts: 1729000001, mid: '<old-1@test.local>' },
    { id: 2, dir: 'out', text: '旧版发出的消息', ts: 1729000002, mid: '<old-2@test.local>' },
  ] } };
  fs.writeFileSync(path.join(dataDir6, 'config.json'), JSON.stringify(oldCfg));
  fs.writeFileSync(path.join(dataDir6, 'messages.json'), JSON.stringify(oldMsgs));
  const inst6 = await startServer({ port: 0, webDir, dataDir: dataDir6 });
  try {
    const p6 = inst6.port;
    let oldM = (await api(p6, 'GET', '/api/messages?with=' + encodeURIComponent(peer))).messages || [];
    const oldIn = oldM.find((m) => m.text === '旧版收到的消息') || {};
    check('N64 旧 messages.json 加载', oldM.length === 2 && !!oldM.find((m) => m.text === '旧版收到的消息')
      && !!oldM.find((m) => m.text === '旧版发出的消息'), JSON.stringify(oldM.map((m) => m.text)));
    check('N65 旧消息默认字段', oldIn.kind === undefined || oldIn.kind === 'chat'
      && oldIn.recalled === undefined || oldIn.recalled === false,
      JSON.stringify({ kind: oldIn.kind, recalled: oldIn.recalled, mid: oldIn.mid }));
    const st6 = await api(p6, 'GET', '/api/state');
    check('N66 旧 config.json 加载 + ai 默认关闭',
      st6.account.email === 'me@test.local' && st6.account.ai
      && st6.account.ai.enabled === false && st6.ai && st6.ai.model_ready === false,
      JSON.stringify({ acc: st6.account, ai: st6.ai }));
    r = await api(p6, 'POST', '/api/recall', { with: peer, id: 2 });
    check('N67 旧发件消息支持撤回', r.ok === true, JSON.stringify(r));
    oldM = (await api(p6, 'GET', '/api/messages?with=' + encodeURIComponent(peer))).messages || [];
    const oldOut = oldM.find((m) => m.id === 2) || {};
    check('N68 旧消息撤回后 recalled=true', oldOut.recalled === true, JSON.stringify(oldOut.recalled));
  } finally {
    stopServer(inst6);
  }
  } finally {
    try { mockN.kill(); } catch (e) { /* ignore */ }
  }
}


(async () => {
  cleanupTmp();
  const webDir = path.join(__dirname, '..', 'web');
  if (!process.env.EC_SKIP_OLD && !process.env.EC_ONLY_RESILIENCE && !process.env.EC_ONLY_21) {
  const mock = spawn(PY, [path.join(__dirname, 'mock_mail.py'), '--smtp', String(SMTP), '--pop3', String(POP3), '--imap', String(IMAP)], {
    stdio: 'ignore',
  });
  mocks.push(mock);
  await waitMock();

  const dataDir = path.join(TMP, 'node-data');
  fs.rmSync(dataDir, { recursive: true, force: true });
  const inst = await startServer({ port: Number(process.env.EC_API || 25341), webDir, dataDir });
  const port = inst.port;
  console.log('node backend listening on', port);

  let s = await api(port, 'GET', '/api/state');
  check('N1 初始未配置', s.configured === false);

  let r = await api(port, 'POST', '/api/config', {
    email: 'me@test.local', display_name: '我', password: 'authcode', mode: 'pop3',
    pop3: { host: '127.0.0.1', port: POP3, ssl: false },
    smtp: { host: '127.0.0.1', port: SMTP, ssl: false },
    poll_interval: 3,
  });
  check('N2 保存配置', r.ok === true, JSON.stringify(r));

  r = await api(port, 'POST', '/api/friends', { action: 'add', email: 'friend@example.com', name: '小明' });
  check('N3 添加好友', r.ok === true);

  r = await api(port, 'POST', '/api/send', { to: 'friend@example.com', text: '你好 Node 后端，测试中文!' });
  check('N4 SMTP 发送', r.ok === true, JSON.stringify(r));

  await inject(SMTP, 'friend@example.com', '测试主题', '收到请回复 Node！');
  await api(port, 'POST', '/api/poll', {});
  await sleep(1600);

  const msgs = (await api(port, 'GET', '/api/messages?with=friend@example.com')).messages;
  const texts = msgs.map((m) => m.text);
  check('N5 POP3 收到好友来信', msgs.length === 2 && texts.includes('收到请回复 Node！'), JSON.stringify(texts));
  check('N6 外发已保存', texts.includes('你好 Node 后端，测试中文!'), JSON.stringify(texts));

  await inject(SMTP, 'stranger@x.com', '广告', '买吗');
  await api(port, 'POST', '/api/poll', {});
  await sleep(1600);
  const msgs2 = (await api(port, 'GET', '/api/messages?with=friend@example.com')).messages;
  check('N7 非白名单邮件被忽略', msgs2.length === 2, String(msgs2.length));

  stopServer(inst);

  // ------- IMAP mode (fresh data AND fresh mock mailbox) -------
  mock.kill();
  const mock2 = spawn(PY, [path.join(__dirname, 'mock_mail.py'), '--smtp', String(SMTP), '--pop3', String(POP3), '--imap', String(IMAP)], {
    stdio: 'ignore',
  });
  mocks.push(mock2);
  await waitMock();

  fs.rmSync(dataDir, { recursive: true, force: true });
  const inst2 = await startServer({ port: 0, webDir, dataDir });
  const port2 = inst2.port;
  await api(port2, 'POST', '/api/config', {
    email: 'me@test.local', display_name: '我', password: 'authcode', mode: 'imap',
    imap: { host: '127.0.0.1', port: IMAP, ssl: false },
    smtp: { host: '127.0.0.1', port: SMTP, ssl: false },
    poll_interval: 3,
  });
  await api(port2, 'POST', '/api/friends', { action: 'add', email: 'friend@example.com', name: '小明' });
  await inject(SMTP, 'friend@example.com', 'IMAP1', 'IMAP 第一封');
  await inject(SMTP, 'friend@example.com', 'IMAP2', 'IMAP 第二封');
  await api(port2, 'POST', '/api/poll', {});
  await sleep(1600);

  const msgs3 = (await api(port2, 'GET', '/api/messages?with=friend@example.com')).messages;
  const texts3 = msgs3.map((m) => m.text);
  check('N8 IMAP 收到两封', msgs3.length === 2 && texts3.includes('IMAP 第一封') && texts3.includes('IMAP 第二封'), JSON.stringify(texts3));

  const st = await api(port2, 'GET', '/api/state');
  const fr = st.friends.find((f) => f.email === 'friend@example.com');
  check('N9 IMAP 未读数=2', fr && fr.unread === 2, JSON.stringify(fr));

  await api(port2, 'POST', '/api/poll', {});
  await sleep(1600);
  const msgs4 = (await api(port2, 'GET', '/api/messages?with=friend@example.com')).messages;
  // 2.1：BODY.PEEK[] 拉取不改变服务器 \Seen（服务器未读语义由 Q 系列新用例覆盖）
  check('N10 PEEK 拉取后本地去重无重复', msgs4.length === 2, String(msgs4.length));

  const pr = await api(port2, 'POST', '/api/probe', {
    candidates: [
      { kind: 'imap', host: '127.0.0.1', port: IMAP, ssl: false },
      { kind: 'pop3', host: '127.0.0.1', port: POP3, ssl: false },
      { kind: 'smtp', host: '127.0.0.1', port: SMTP, ssl: false },
      { kind: 'smtp', host: '127.0.0.1', port: 1, ssl: false },
    ],
  });
  const okList = (pr.results || []).filter((x) => x.ok);
  check('N11 probe 三协议均连通', okList.length === 3 && new Set(okList.map((x) => x.kind)).size === 3, JSON.stringify(pr).slice(0, 300));
  check('N12 probe 不通端口标记失败', (pr.results || []).filter((x) => !x.ok).length === 1, JSON.stringify(pr.results || []).slice(0, 200));

  stopServer(inst2);

  // ------- 回归 N13-N14：SSL 错配自动回退（模拟用户把 143/110/587 明文端口误勾 SSL） -------
  // 用全新 mock 邮箱，便于精确断言
  mock2.kill();
  const mock3 = spawn(PY, [path.join(__dirname, 'mock_mail.py'), '--smtp', String(SMTP), '--pop3', String(POP3), '--imap', String(IMAP)], { stdio: 'ignore' });
  mocks.push(mock3);
  await waitMock();

  const dataDir3 = path.join(TMP, 'node-data3');
  fs.rmSync(dataDir3, { recursive: true, force: true });
  const inst3 = await startServer({ port: 0, webDir, dataDir: dataDir3 });
  const port3 = inst3.port;
  await api(port3, 'POST', '/api/config', {
    email: 'me@test.local', display_name: '我', password: 'authcode', mode: 'imap',
    imap: { host: '127.0.0.1', port: IMAP, ssl: true },   // 明文端口 + ssl:true —— 必须自动回退
    pop3: { host: '127.0.0.1', port: POP3, ssl: true },
    smtp: { host: '127.0.0.1', port: SMTP, ssl: true },
    poll_interval: 3,
  });
  await api(port3, 'POST', '/api/friends', { action: 'add', email: 'friend@example.com', name: '小明' });
  const r13 = await api(port3, 'POST', '/api/send', { to: 'friend@example.com', text: '回退后发送' });
  check('N13 SSL错配自动回退 SMTP发送', r13.ok === true, JSON.stringify(r13));

  await inject(SMTP, 'friend@example.com', '回退主题', '回退后收到');
  await api(port3, 'POST', '/api/poll', {});
  await sleep(1600);
  const m13 = (await api(port3, 'GET', '/api/messages?with=friend@example.com')).messages;
  check('N14 SSL错配自动回退 IMAP收信', m13.length === 2 && m13.some((m) => m.text === '回退后收到'), JSON.stringify(m13.map((m) => m.text)));

  // ------- 回归 N15-N16：Message-ID 去重（seen 表清空/损坏时重拉不重复） -------
  const dataDir4 = path.join(TMP, 'node-data4');
  fs.rmSync(dataDir4, { recursive: true, force: true });
  const inst4 = await startServer({ port: 0, webDir, dataDir: dataDir4 });
  const port4 = inst4.port;
  await api(port4, 'POST', '/api/config', {
    email: 'me@test.local', password: 'authcode', mode: 'pop3',
    pop3: { host: '127.0.0.1', port: POP3, ssl: false },
    smtp: { host: '127.0.0.1', port: SMTP, ssl: false },
    poll_interval: 3,
  });
  await api(port4, 'POST', '/api/friends', { action: 'add', email: 'friend@example.com', name: '小明' });
  const dupMid = '<dup-20241022@example.com>';
  const dupRaw =
    'From: friend@example.com\r\nTo: me@test.local\r\nSubject: dup\r\n' +
    `Message-ID: ${dupMid}\r\n` +
    'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
    Buffer.from('重复消息', 'utf8').toString('base64');
  await rawSmtpSend(SMTP, dupRaw);
  await api(port4, 'POST', '/api/poll', {});
  await sleep(1200);
  let n15 = (await api(port4, 'GET', '/api/messages?with=friend@example.com')).messages.filter((m) => m.text === '重复消息').length;
  check('N15 Message-ID 去重（首轮）', n15 === 1, String(n15));
  // 模拟 seen 表丢失：清空后重拉，仅靠 Message-ID 去重也不应重复
  inst4.app.store.seenPop3.clear();
  inst4.app.store.saveConfig();
  await api(port4, 'POST', '/api/poll', {});
  await sleep(1200);
  n15 = (await api(port4, 'GET', '/api/messages?with=friend@example.com')).messages.filter((m) => m.text === '重复消息').length;
  check('N16 seen 清空后 Message-ID 去重仍生效', n15 === 1, String(n15));

  // ------- 回归 N17：关闭自动收信后不轮询，手动收信仍可用 -------
  await api(port4, 'POST', '/api/config', { auto_poll: false });
  const st17 = await api(port4, 'GET', '/api/state');
  check('N17 auto_poll=false 已保存并回显', st17.account && st17.account.auto_poll === false, JSON.stringify(st17.account));
  // 保存配置会触发一次「立即收信」，等它跑完再注入，避免误判
  await sleep(1200);
  await inject(SMTP, 'friend@example.com', 'auto', '自动关闭后不该自动收到');
  await sleep(4500);   // > poll_interval(3s)：若自动轮询存在，这段时间会收到
  let m17 = (await api(port4, 'GET', '/api/messages?with=friend@example.com')).messages;
  check('N18 关闭自动收信后未自动收取', !m17.some((m) => m.text === '自动关闭后不该自动收到'), JSON.stringify(m17.map((m) => m.text)));
  await api(port4, 'POST', '/api/poll', {});
  await sleep(1200);
  m17 = (await api(port4, 'GET', '/api/messages?with=friend@example.com')).messages;
  check('N19 手动收信仍然可用', m17.some((m) => m.text === '自动关闭后不该自动收到'), JSON.stringify(m17.map((m) => m.text)));

  // ------- 回归 N20：probe 对「连上但沉默」的服务器不挂起 -------
  const silent = net.createServer((s) => { /* 收下连接但一个字都不回 */ });
  await new Promise((res) => silent.listen(0, '127.0.0.1', res));
  const silentPort = silent.address().port;
  const t0 = Date.now();
  const pr20 = await api(port4, 'POST', '/api/probe', {
    candidates: [{ kind: 'smtp', host: '127.0.0.1', port: silentPort, ssl: false }],
  });
  const dt20 = Date.now() - t0;
  silent.close();
  check('N20 黑洞连接 probe 不挂起(<10s)', dt20 < 10000 && (pr20.results || []).length === 1 && !pr20.results[0].ok, `dt=${dt20}ms ` + JSON.stringify(pr20).slice(0, 200));

  // ------- 回归 N21：Host/Origin 防护 -------
  function rawApi(port, method, p, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  const g1 = await rawApi(port4, 'GET', '/api/state', { Host: 'evil.com' });
  check('N21 恶意 Host 被拒(403)', g1.status === 403, `status=${g1.status}`);
  const g2 = await rawApi(port4, 'GET', '/api/state', { Host: `127.0.0.1:${port4}`, Origin: 'http://evil.com' });
  check('N22 Origin 不一致被拒(403)', g2.status === 403, `status=${g2.status}`);
  const g3 = await rawApi(port4, 'GET', '/api/state', { Host: `127.0.0.1:${port4}`, Origin: 'null' });
  check('N23 Origin=null 被拒(403)', g3.status === 403, `status=${g3.status}`);
  const g4 = await rawApi(port4, 'GET', '/api/state', { Host: `127.0.0.1:${port4}` });
  check('N24 本机无 Origin 请求放行(200)', g4.status === 200, `status=${g4.status}`);

  stopServer(inst3);
  stopServer(inst4);
  mocks.forEach((m) => { try { m.kill(); } catch (e) { /* ignore */ } });
  await sleep(600);
  }  // end !EC_SKIP_OLD

  // ------- 2.0 新功能场景（独立 mock + 独立数据目录） -------
  if (!process.env.EC_ONLY_RESILIENCE && !process.env.EC_ONLY_21) {
    try {
      await nodeScenarioNewFeatures(webDir);
    } catch (e) {
      check('2.0 新功能场景异常', false, String(e));
      console.error('NEW SCENARIO ERROR:', e);
    }
  }

  // ------- reviewer High 健壮性回归（H2 QP 性能 / H3 POP3 大邮件 / M1 仅附件） -------
  if (!process.env.EC_ONLY_21) {
    mocks.forEach((m) => { try { m.kill(); } catch (e) { /* ignore */ } });
    await sleep(600);
    try {
      await nodeScenarioResilience(webDir);
    } catch (e) {
      check('健壮性回归场景异常', false, String(e));
      console.error('RESILIENCE SCENARIO ERROR:', e);
    }
  }

  // ------- 2.1 未读语义 / 删除好友 / 引用=reply -------
  mocks.forEach((m) => { try { m.kill(); } catch (e) { /* ignore */ } });
  await sleep(600);
  try {
    await nodeScenarioUnreadReply(webDir);
  } catch (e) {
    check('2.1 未读/reply 场景异常', false, String(e));
    console.error('UNREAD/REPLY SCENARIO ERROR:', e);
  }
  mocks.forEach((m) => { try { m.kill(); } catch (e) { /* ignore */ } });
  cleanupTmp();

  console.log(`== NODE BACKEND RESULT: ${passed.length} passed, ${failed.length} failed ==`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  mocks.forEach((m) => { try { m.kill(); } catch (err) { /* ignore */ } });
  cleanupTmp();
  console.error('FATAL:', e);
  process.exit(2);
});