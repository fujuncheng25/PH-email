#!/usr/bin/env node
'use strict';
/**
 * node-ai-api-test.js — ai.js 对外接口/回退行为自测（无需真实模型，秒级跑完）
 *
 * 覆盖规格 §4.6 / §6.5 / §9.6 要求：
 *  A. status() 字段完整（enabled/model_ready/downloading/downloaded_bytes/total_bytes/
 *     percent/error/model_file/mirror/busy/engine）
 *  B. 未启用 → generateTitle 立刻返回 heuristic + note，不 reject
 *  C. 启用但模型未下载 → heuristic + note
 *  D. 下载中 → generateTitle 立刻返回 heuristic + note（不等待下载、不阻塞）
 *  E. 模型文件非法（魔数合法但内容损坏）→ 推理失败回落 heuristic + note，不 reject
 *  F. cancelDownload 返回最新 status
 *  G. heuristicTitle / postProcessTitle 规则（与 C++/前端一致性）
 *  H. 重复 init / setConfig 部分覆盖 / model_file 清洗
 *
 * 用法：node node-ai-api-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ENGINE_DIR = path.join(__dirname, '..', 'electron');
const ai = require(path.join(ENGINE_DIR, 'ai.js'));
const gguf = require(path.join(ENGINE_DIR, 'gguf.js'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail === undefined ? '' : detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function tmpDir(tag) {
  const d = path.join(os.tmpdir(), 'ec-api-' + tag + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function cleanup(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }

async function main() {
  const dirs = [];

  // ---------------- A. status 字段
  {
    const d = tmpDir('status'); dirs.push(d);
    ai.init(d);
    ai.setConfig({ enabled: false, mirror: '', model_url: '', model_file: 'x.gguf' });
    const st = ai.status();
    const fields = ['enabled', 'model_ready', 'downloading', 'downloaded_bytes', 'total_bytes',
      'percent', 'error', 'model_file', 'mirror', 'busy', 'engine'];
    const missing = fields.filter((f) => !(f in st));
    check('A1 status 字段完整', missing.length === 0, 'missing=' + JSON.stringify(missing));
    check('A2 默认 mirror 回落', st.mirror === 'https://hf-mirror.com', st.mirror);
    check('A3 默认未就绪/不下载', st.model_ready === false && st.downloading === false && st.percent === 0);
    check('A4 engine 有值', typeof st.engine === 'string' && st.engine.length > 0, st.engine);
  }

  // ---------------- B. 未启用
  {
    const d = tmpDir('disabled'); dirs.push(d);
    ai.init(d);
    ai.setConfig({ enabled: false, model_file: 'm.gguf' });
    const r = await ai.generateTitle('请帮我确认明天下午的会议安排');
    check('B1 未启用返回 heuristic', r.source === 'heuristic' && r.title === '请帮我确认明天下午的会议安排', JSON.stringify(r));
    check('B2 未启用带 note', typeof r.note === 'string' && r.note.length > 0, r.note);
  }

  // ---------------- C. 启用但未下载
  {
    const d = tmpDir('nodl'); dirs.push(d);
    ai.init(d);
    ai.setConfig({ enabled: true, model_file: 'absent.gguf' });
    const t0 = Date.now();
    const r = await ai.generateTitle('测试标题回落');
    check('C1 未下载返回 heuristic', r.source === 'heuristic', JSON.stringify(r));
    check('C2 未下载 note 有原因', /未下载|模型/.test(r.note), r.note);
    check('C3 未下载不阻塞', Date.now() - t0 < 1000, (Date.now() - t0) + 'ms');
  }

  // ---------------- D. 下载中（stub server 卡住不结束）
  {
    const d = tmpDir('downloading'); dirs.push(d);
    ai.init(d);
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(Buffer.alloc(1024 * 1024)); // 只发一点，不结束
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    ai.setConfig({ enabled: true, model_url: 'http://127.0.0.1:' + port + '/m.gguf', model_file: 'dl.gguf' });
    const dr = ai.startDownload();
    check('D1 startDownload 立即返回 ok', dr.ok === true, JSON.stringify(dr));
    await sleep(300);
    const st = ai.status();
    check('D2 下载中状态可读', st.downloading === true && st.downloaded_bytes > 0, JSON.stringify({ d: st.downloading, b: st.downloaded_bytes }));
    const t0 = Date.now();
    const r = await ai.generateTitle('下载过程中生成标题');
    check('D3 下载中 generateTitle 立即回落', r.source === 'heuristic' && /下载/.test(r.note), JSON.stringify(r));
    check('D4 下载中不阻塞', Date.now() - t0 < 1000, (Date.now() - t0) + 'ms');
    const st2 = ai.cancelDownload();
    check('D5 cancelDownload 返回 status 对象', st2 && st2.downloading === false, JSON.stringify(st2));
    await sleep(200);
    check('D6 取消后 .part 清理', !fs.existsSync(path.join(d, 'models', 'dl.gguf.part')));
    srv.close();
  }

  // ---------------- E. 模型文件非法（魔数合法但内容损坏）
  {
    const d = tmpDir('badmodel'); dirs.push(d);
    fs.mkdirSync(path.join(d, 'models'), { recursive: true });
    const bad = path.join(d, 'models', 'bad.gguf');
    const fd = fs.openSync(bad, 'w');
    const buf = Buffer.alloc(52 * 1024 * 1024);
    buf.write('GGUF', 0, 'latin1');
    buf.writeUInt32LE(3, 4);
    // 后面全是 0：tensor_count/kv_count 为 0，但文件尾部无数据 —— 加载应失败或产生非法结构
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    ai.init(d);
    ai.setConfig({ enabled: true, model_file: 'bad.gguf' });
    check('E1 非法模型魔数通过但内容坏，model_ready 可能为 true（按文件校验）', ai.status().model_ready === true);
    const t0 = Date.now();
    const r = await ai.generateTitle('损坏模型也要回落');
    check('E2 推理失败回落 heuristic', r.source === 'heuristic', JSON.stringify(r));
    check('E3 有失败原因 note', /失败|错误|超时|模型/.test(r.note), r.note);
    check('E4 不阻塞太久', Date.now() - t0 < 20000, (Date.now() - t0) + 'ms');
    ai._private.terminateWorker();
  }

  // ---------------- F. 取消无下载时安全
  {
    const d = tmpDir('cancel-idle'); dirs.push(d);
    ai.init(d);
    const st = ai.cancelDownload();
    check('F1 无下载时 cancelDownload 安全', st && st.downloading === false, JSON.stringify(st));
  }

  // ---------------- G. 启发式/后处理规则
  {
    const longLine = '这是一个非常非常长的标题需要被截断到三十个字符以内才对啊啊啊';
    const longChars = Array.from(longLine);
    const longWant = longChars.length > 30 ? longChars.slice(0, 30).join('') + '…' : longLine;
    const cases = [
      ['', '无主题'],
      ['   \n\t \n', '无主题'],
      ['# 会议安排\n第二行', '会议安排'],
      ['- 预算表已整理', '预算表已整理'],
      ['> 引用内容', '引用内容'],
      ['**加粗标题** 文本', '加粗标题 文本'],
      ['1. 第一项任务', '第一项任务'],
      [longLine, longWant],
    ];
    let ok = true; const detail = [];
    for (const [input, want] of cases) {
      const got = ai.heuristicTitle(input);
      if (got !== want) { ok = false; detail.push({ input, got, want }); }
    }
    check('G1 heuristicTitle 规则', ok, JSON.stringify(detail));
    check('G2 ai.js 与 gguf.js 的 heuristicTitle 一致',
      ['', '标题', '# 会议', '  多行\n文本', 'a'.repeat(50)].every((s) => ai.heuristicTitle(s) === gguf.heuristicTitle(s)));
    check('G3 空文本 heuristic 为无主题', ai.heuristicTitle('') === '无主题');

    const pcases = [
      ['  标题：会议安排。 ', '会议安排'],
      ['“会议安排”', '会议安排'],
      ["'预算讨论'", '预算讨论'],
      ['「项目评审」', '项目评审'],
      ['会议安排！？', '会议安排'],
      ['第一行\n第二行', '第一行 第二行'],
      ['a'.repeat(50), 'a'.repeat(40)],
    ];
    let ok2 = true; const detail2 = [];
    for (const [input, want] of pcases) {
      const got = ai.postProcessTitle(input, 'fallback');
      if (got !== want) { ok2 = false; detail2.push({ input, got, want }); }
    }
    check('G4 postProcessTitle 规则', ok2, JSON.stringify(detail2));
    check('G5 postProcessTitle 空结果回落启发式', ai.postProcessTitle('“”', '回落文本') === '回落文本');
  }

  // ---------------- H. 配置/init 行为
  {
    const d = tmpDir('cfg'); dirs.push(d);
    ai.init(d);
    ai.init(d); // 可重复
    ai.setConfig({ enabled: true, mirror: '  http://example.com/  ', model_file: 'sub/evil.gguf' });
    const c = ai.getConfig();
    check('H1 mirror 去尾斜杠/空格', c.mirror === 'http://example.com', c.mirror);
    check('H2 model_file 路径清洗（拒绝子目录）', c.model_file === 'evil.gguf', c.model_file);
    ai.setConfig({ model_url: 'http://x/y.gguf' }); // 只覆盖一个字段
    const c2 = ai.getConfig();
    check('H3 部分覆盖不丢其它字段', c2.enabled === true && c2.mirror === 'http://example.com' && c2.model_url === 'http://x/y.gguf', JSON.stringify(c2));
    ai.setConfig({ enabled: false });
    check('H4 enabled 可关闭', ai.getConfig().enabled === false);
    ai._private.terminateWorker();
  }

  for (const d of dirs) cleanup(d);
  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 汇总 ' + (results.length - failed.length) + '/' + results.length + ' 通过 =====');
  if (failed.length) { console.log(JSON.stringify({ ok: false, failed }, null, 1)); process.exit(1); }
  console.log(JSON.stringify({ ok: true, total: results.length }));
}

main().catch((e) => { console.error('测试脚本异常:', e && e.stack || e); process.exit(1); });
