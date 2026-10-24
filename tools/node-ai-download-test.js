#!/usr/bin/env node
'use strict';
/**
 * node-ai-download-test.js — 用本地 stub HTTP server 测试 ai.js 的后台下载器
 * （本机无外网，规格 §8 要求：只测失败路径 / 取消 / 进度，不做真实下载）。
 *
 * 覆盖：
 *  A. 302 重定向 + Transfer-Encoding: chunked（无 Content-Length）+ 进度 + 校验安装（GGUF 魔数 + ≥50MB）
 *  B. 候选 URL 依次重试（mirror 模式：前两个 404，第三个成功）
 *  C. 全部失败 → 后台任务优雅结束、error 有中文原因、.part 被删除、model_ready=false
 *  D. 200 但内容不是 GGUF（50MB HTML）→ 魔数校验失败，.part 被删除
 *  E. 200 但文件过小（10MB）→ 体积校验失败，.part 被删除
 *  F. 下载中途 cancelDownload() → 停止、.part 删除、无正式文件、不报错
 *  G. 已就绪时 startDownload() → {ok:true, already:true}
 *  H. model_url 覆盖：只请求自定义 URL（不请求候选 URL）
 *
 * 用法：node node-ai-download-test.js [--keep]
 * 输出：JSON 汇总；有失败时 exit code 1。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENGINE_DIR = path.join(__dirname, '..', 'electron');
const ai = require(path.join(ENGINE_DIR, 'ai.js'));

const GGUF_MAGIC = Buffer.from('GGUF', 'latin1');
const MIN_BYTES = 50 * 1024 * 1024;
const KEEP = process.argv.includes('--keep');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail === undefined ? '' : detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeTmpDir(tag) {
  const d = path.join(os.tmpdir(), 'ec-dl-' + tag + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  fs.mkdirSync(path.join(d, 'models'), { recursive: true });
  return d;
}
function rmDir(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }

/** 生成一个合法魔数 + 指定体积的假 GGUF 文件（只用于下载/校验测试，不加载） */
function makeFakeGgufFile(file, sizeBytes, magic) {
  const fd = fs.openSync(file, 'w');
  const head = Buffer.alloc(1024 * 1024);
  if (magic !== false) GGUF_MAGIC.copy(head, 0);
  fs.writeSync(fd, head, 0, head.length, 0);
  fs.writeSync(fd, head, 0, head.length, head.length);
  let written = head.length * 2;
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  while (written < sizeBytes) {
    const n = Math.min(chunk.length, sizeBytes - written);
    fs.writeSync(fd, chunk, 0, n, written);
    written += n;
  }
  fs.closeSync(fd);
}

/** 等待下载结束（或超时） */
async function waitDownloadDone(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = ai.status();
    if (!st.downloading) return st;
    await sleep(50);
  }
  return ai.status();
}

// ---------------------------------------------------------------- stub server

class StubServer {
  constructor() {
    this.routes = new Map();
    this.requests = [];
    this.server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      this.requests.push(u.pathname + u.search);
      const h = this.routes.get(u.pathname);
      if (!h) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      h(req, res);
    });
  }
  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    this.base = 'http://127.0.0.1:' + this.port;
    return this;
  }
  route(p, handler) { this.routes.set(p, handler); }
  stop() { try { this.server.close(); } catch (e) {} }
}

const BIG_FILE = path.join(os.tmpdir(), 'ec-dl-big-' + process.pid + '.gguf');
const SMALL_FILE = path.join(os.tmpdir(), 'ec-dl-small-' + process.pid + '.gguf');
const HTML_FILE = path.join(os.tmpdir(), 'ec-dl-html-' + process.pid + '.bin');

function sendFileSlowly(res, file, opts) {
  opts = opts || {};
  const stat = fs.statSync(file);
  if (!opts.chunked) res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size });
  else res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(opts.chunkSize || 1024 * 1024);
  let pos = 0;
  const tick = () => {
    if (opts.cancelAt && pos >= opts.cancelAt) return; // 卡住不结束，等客户端取消
    if (pos >= stat.size) { try { fs.closeSync(fd); } catch (e) {} res.end(); return; }
    const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - pos), pos);
    res.write(chunk.subarray(0, n));
    pos += n;
    setTimeout(tick, opts.delayMs || 0);
  };
  tick();
}

async function main() {
  console.log('准备 stub 文件…');
  makeFakeGgufFile(BIG_FILE, MIN_BYTES, true);       // 50MB，合法魔数
  makeFakeGgufFile(SMALL_FILE, 10 * 1024 * 1024, true); // 10MB
  makeFakeGgufFile(HTML_FILE, MIN_BYTES, false);      // 50MB，非 GGUF

  const srv = await new StubServer().start();
  const tmpDirs = [];
  const newAi = (tag) => {
    const d = makeTmpDir(tag);
    tmpDirs.push(d);
    ai.init(d);
    return d;
  };

  // ---------------- A. 302 + chunked + 进度 + 安装
  {
    srv.route('/redir', (req, res) => { res.writeHead(302, { Location: '/chunked' }); res.end(); });
    srv.route('/chunked', (req, res) => sendFileSlowly(res, BIG_FILE, { chunked: true, chunkSize: 512 * 1024, delayMs: 3 }));
    const d = newAi('redirect-chunked');
    ai.setConfig({ enabled: true, model_url: srv.base + '/redir', model_file: 'stub.gguf' });
    let sawProgress = false;
    let r = ai.startDownload();
    check('A1 startDownload.ok', r.ok === true, JSON.stringify(r));
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const st = ai.status();
      if (st.downloading && st.downloaded_bytes > 0) sawProgress = true;
      if (!st.downloading) break;
      await sleep(30);
    }
    const st = ai.status();
    check('A2 进度可读（downloaded_bytes>0 且 percent 递增）', sawProgress, JSON.stringify({ bytes: st.downloaded_bytes }));
    check('A3 下载成功且 model_ready', st.model_ready === true && st.downloading === false, JSON.stringify(st));
    check('A4 正式文件存在且无 .part', fs.existsSync(path.join(d, 'models', 'stub.gguf')) && !fs.existsSync(path.join(d, 'models', 'stub.gguf.part')));
    check('A5 就绪后 percent=100 且字节数=文件大小', st.percent === 100 && st.downloaded_bytes === MIN_BYTES, JSON.stringify({ p: st.percent, b: st.downloaded_bytes }));
  }

  // ---------------- B. mirror 候选 URL 依次重试（前两个失败）
  {
    srv.route('/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf', (req, res) => { res.writeHead(404); res.end('nope'); });
    srv.route('/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', (req, res) => { res.writeHead(500); res.end('err'); });
    srv.route('/unsloth/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', (req, res) => sendFileSlowly(res, BIG_FILE));
    const d = newAi('candidates');
    srv.requests.length = 0;
    ai.setConfig({ enabled: true, mirror: srv.base, model_url: '', model_file: 'stub.gguf' });
    const t0 = Date.now();
    ai.startDownload();
    const st = await waitDownloadDone(30000);
    check('B1 候选 URL 回退后成功', st.model_ready === true, JSON.stringify({ err: st.error, ms: Date.now() - t0 }));
    check('B2 依次请求了 3 个候选 URL', srv.requests.some((x) => x.startsWith('/Qwen/')) && srv.requests.some((x) => x.startsWith('/bartowski/')) && srv.requests.some((x) => x.startsWith('/unsloth/')), JSON.stringify(srv.requests));
  }

  // ---------------- C. 全部失败
  {
    srv.route('/always404', (req, res) => { res.writeHead(404); res.end('no'); });
    const d = newAi('allfail');
    ai.setConfig({ enabled: true, model_url: srv.base + '/always404', model_file: 'stub.gguf' });
    ai.startDownload();
    const st = await waitDownloadDone(15000);
    check('C1 失败后 downloading=false', st.downloading === false, JSON.stringify(st));
    check('C2 error 有中文原因且含 HTTP 404', /下载失败/.test(st.error) && /404/.test(st.error), st.error);
    check('C3 失败后无 .part 且无正式文件', !fs.existsSync(path.join(d, 'models', 'stub.gguf.part')) && !fs.existsSync(path.join(d, 'models', 'stub.gguf')));
    check('C4 model_ready=false', st.model_ready === false);
  }

  // ---------------- D. 非 GGUF 内容
  {
    srv.route('/html', (req, res) => sendFileSlowly(res, HTML_FILE));
    const d = newAi('badmagic');
    ai.setConfig({ enabled: true, model_url: srv.base + '/html', model_file: 'stub.gguf' });
    ai.startDownload();
    const st = await waitDownloadDone(30000);
    check('D1 魔数校验失败并报错', /GGUF/.test(st.error), st.error);
    check('D2 非法文件被删除', !fs.existsSync(path.join(d, 'models', 'stub.gguf')) && !fs.existsSync(path.join(d, 'models', 'stub.gguf.part')));
  }

  // ---------------- E. 文件过小
  {
    srv.route('/small', (req, res) => sendFileSlowly(res, SMALL_FILE));
    const d = newAi('toosmall');
    ai.setConfig({ enabled: true, model_url: srv.base + '/small', model_file: 'stub.gguf' });
    ai.startDownload();
    const st = await waitDownloadDone(15000);
    check('E1 体积校验失败并报错', /过小/.test(st.error), st.error);
    check('E2 小文件被删除', !fs.existsSync(path.join(d, 'models', 'stub.gguf')) && !fs.existsSync(path.join(d, 'models', 'stub.gguf.part')));
  }

  // ---------------- F. 中途取消
  {
    srv.route('/stall', (req, res) => sendFileSlowly(res, BIG_FILE, { chunkSize: 256 * 1024, delayMs: 30, cancelAt: 2 * 1024 * 1024 }));
    const d = newAi('cancel');
    ai.setConfig({ enabled: true, model_url: srv.base + '/stall', model_file: 'stub.gguf' });
    ai.startDownload();
    // 等有进度后取消
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const st = ai.status();
      if (st.downloaded_bytes > 0) break;
      await sleep(20);
    }
    const before = ai.status();
    const after = ai.cancelDownload();
    await sleep(300);
    const st = ai.status();
    check('F1 取消前有进度', before.downloaded_bytes > 0, JSON.stringify({ bytes: before.downloaded_bytes }));
    check('F2 取消后 downloading=false', st.downloading === false && after.downloading === false, JSON.stringify(st));
    check('F3 取消后 .part 被删除、无正式文件', !fs.existsSync(path.join(d, 'models', 'stub.gguf.part')) && !fs.existsSync(path.join(d, 'models', 'stub.gguf')));
    check('F4 取消不产生 error', st.error === '', st.error);
    check('F5 取消后 model_ready=false', st.model_ready === false);
  }

  // ---------------- G. 已就绪时再次 startDownload
  {
    const d = newAi('already');
    fs.copyFileSync(BIG_FILE, path.join(d, 'models', 'stub.gguf'));
    ai.setConfig({ enabled: true, model_url: srv.base + '/chunked', model_file: 'stub.gguf' });
    ai._private.refreshReady(true);
    const before = ai.status();
    const r = ai.startDownload();
    check('G1 已就绪时返回 already', r.ok === true && r.already === true, JSON.stringify(r));
    check('G2 已就绪状态正确', before.model_ready === true && before.percent === 100, JSON.stringify(before));
  }

  // ---------------- H. model_url 覆盖候选
  {
    srv.route('/custom-only', (req, res) => sendFileSlowly(res, BIG_FILE));
    const d = newAi('custom');
    srv.requests.length = 0;
    ai.setConfig({ enabled: true, mirror: 'http://127.0.0.1:1', model_url: srv.base + '/custom-only', model_file: 'stub.gguf' });
    ai.startDownload();
    const st = await waitDownloadDone(30000);
    check('H1 自定义 model_url 成功', st.model_ready === true, JSON.stringify(st));
    check('H2 没有请求 mirror 候选 URL', srv.requests.length > 0 && srv.requests.every((x) => x.startsWith('/custom-only')), JSON.stringify(srv.requests));
  }

  srv.stop();
  for (const d of tmpDirs) if (!KEEP) rmDir(d);
  for (const f of [BIG_FILE, SMALL_FILE, HTML_FILE]) { try { fs.unlinkSync(f); } catch (e) {} }
  if (KEEP) console.log('保留临时目录:', tmpDirs.join(', '));

  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 汇总 ' + (results.length - failed.length) + '/' + results.length + ' 通过 =====');
  if (failed.length) {
    console.log(JSON.stringify({ ok: false, failed }, null, 1));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, total: results.length }));
}

main().catch((e) => {
  console.error('测试脚本异常:', e && e.stack || e);
  process.exit(1);
});
