#!/usr/bin/env node
'use strict';
/**
 * node-ai-selftest.js — Node AI 引擎命令行自测工具（source/electron/gguf.js + ai.js）
 *
 * 用法（stdout 只输出 JSON，日志走 stderr）：
 *   node node-ai-selftest.js tokenize <model.gguf> <text>
 *       -> {"tokens":[int,...]}
 *   node node-ai-selftest.js generate <model.gguf> <raw_prompt_text> <n_predict> [--stop-newline]
 *       -> {"tokens":[int,...],"text":"..."}   （贪心；默认只在 EOS 停止，与 llama-server 对照）
 *   node node-ai-selftest.js logits <model.gguf> <token_ids_csv> [topk]
 *       -> {"topk":[{"id":int,"logit":float},...]}  （纯 token id，不套 tokenizer/模板；默认 top10）
 *   node node-ai-selftest.js title <model.gguf> <text>
 *       -> {"title":"...","raw":"...","prompt_tokens":n,"gen_tokens":n,"elapsed_ms":n}
 *   node node-ai-selftest.js bench <model.gguf> [n_predict] [text]
 *       -> 加载/首 token/每 token 耗时
 *   node node-ai-selftest.js dequant <model.gguf> <tensor_name> <row> [count]
 *       -> {"tensor":...,"type":...,"dims":[...],"values":[...]}  （反量化一行，用于 Q4_K/Q6_K 对照）
 *   node node-ai-selftest.js info <model.gguf>
 *       -> 模型元数据/张量类型统计
 *   node node-ai-selftest.js download-test <mirror_url> <model_file>
 *       -> 用 ai.js 的下载器测试失败/取消路径（本机无外网，只验证优雅失败）
 *
 * 例（llama-server oracle）：
 *   node node-ai-selftest.js tokenize <15B-Q8_0.gguf> "你好，世界！"
 *   node node-ai-selftest.js generate <15B-Q8_0.gguf> "你好" 4
 *   node node-ai-selftest.js logits <tiny-q4k.gguf> 151644,8948,198
 */
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

const ENGINE_DIR = path.join(__dirname, '..', 'electron');
const engine = require(path.join(ENGINE_DIR, 'gguf.js'));

function log(...args) { console.error('[selftest]', ...args); }

function die(msg) {
  console.error('[selftest] 错误：' + msg);
  process.exit(2);
}

function loadGgufOrDie(file) {
  if (!fs.existsSync(file)) die('模型文件不存在: ' + file);
  const t0 = Date.now();
  const gguf = engine.parseGGUFFile(file);
  log('GGUF 解析完成', (Date.now() - t0) + 'ms', 'tensors=' + gguf.tensorCount,
    'size=' + (gguf.size / 1048576).toFixed(1) + 'MB');
  return gguf;
}

function loadFullOrDie(file, opts) {
  if (!fs.existsSync(file)) die('模型文件不存在: ' + file);
  const t0 = Date.now();
  const loaded = engine.loadModel(file, opts);
  log('模型加载完成', (Date.now() - t0) + 'ms',
    'arch=' + loaded.model.p.arch, 'tensors=' + loaded.gguf.tensorCount,
    'vocab=' + loaded.tokenizer.nVocab);
  return loaded;
}

function parseIdsCsv(s) {
  const parts = String(s || '').split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  const ids = parts.map((x) => {
    const n = parseInt(x, 10);
    if (!Number.isInteger(n) || n < 0) die('非法 token id: ' + x);
    return n;
  });
  if (!ids.length) die('token id 列表为空');
  return ids;
}

function topkLogits(logits, k) {
  const idx = [];
  for (let i = 0; i < logits.length; i++) idx.push(i);
  idx.sort((a, b) => logits[b] - logits[a]);
  const out = [];
  for (let i = 0; i < Math.min(k, idx.length); i++) {
    out.push({ id: idx[i], logit: Math.round(logits[idx[i]] * 1e6) / 1e6 });
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.error('用法: node node-ai-selftest.js <tokenize|generate|logits|title|bench|dequant|info|download-test> ...');
    process.exit(2);
  }
  const cmd = argv[0];
  const args = argv.slice(1).filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));

  if (cmd === 'tokenize') {
    if (args.length < 2) die('用法: tokenize <model.gguf> <text>');
    const gguf = loadGgufOrDie(args[0]);
    const tk = new engine.Tokenizer(gguf);
    const text = args.slice(1).join(' ');
    const tokens = tk.encode(text);
    console.log(JSON.stringify({ tokens }));
    return;
  }

  if (cmd === 'generate') {
    if (args.length < 2) die('用法: generate <model.gguf> <raw_prompt_text> <n_predict>');
    const file = args[0];
    const nPredict = Math.max(1, parseInt(args[args.length - 1], 10) || 8);
    const prompt = args.slice(1, args.length - 1).join(' ');
    const loaded = loadFullOrDie(file);
    const { tokenizer, model } = loaded;
    const promptIds = tokenizer.encode(prompt);
    log('prompt tokens:', promptIds.length, JSON.stringify(promptIds));
    const t0 = Date.now();
    const res = model.generateGreedy(promptIds, nPredict, {
      eosId: tokenizer.eosId,
      stopOnNewline: flags.has('--stop-newline'),
      tokenizer,
    });
    const elapsed = Date.now() - t0;
    log('生成', res.tokens.length, 'token，耗时', elapsed + 'ms，',
      '平均', res.tokens.length ? (elapsed / res.tokens.length).toFixed(0) + 'ms/token' : 'n/a');
    console.log(JSON.stringify({ tokens: res.tokens, text: res.text }));
    return;
  }

  if (cmd === 'logits') {
    if (args.length < 2) die('用法: logits <model.gguf> <token_ids_csv> [topk]');
    const loaded = loadFullOrDie(args[0]);
    const ids = parseIdsCsv(args[1]);
    const k = parseInt(args[2], 10) || 10;
    const t0 = Date.now();
    const logits = loaded.model.logitsFor(ids);
    if (logits.length !== loaded.tokenizer.nVocab) {
      die('logits 长度 ' + logits.length + ' 与 vocab ' + loaded.tokenizer.nVocab + ' 不一致');
    }
    log('logits 计算完成', (Date.now() - t0) + 'ms', 'vocab=' + logits.length);
    console.log(JSON.stringify({ topk: topkLogits(logits, k) }));
    return;
  }

  if (cmd === 'title') {
    if (args.length < 2) die('用法: title <model.gguf> <text>');
    const loaded = loadFullOrDie(args[0]);
    const text = args.slice(1).join(' ');
    const r = engine.generateTitleWithModel(loaded, text, { maxTokens: 24 });
    log('title 生成耗时', r.elapsedMs + 'ms', 'prompt=' + r.promptTokens, 'gen=' + r.genTokens);
    console.log(JSON.stringify({
      title: r.title, raw: r.raw, prompt_tokens: r.promptTokens,
      gen_tokens: r.genTokens, elapsed_ms: r.elapsedMs, gen_token_ids: r.genTokenIds || [],
    }));
    return;
  }

  if (cmd === 'bench') {
    const file = args[0];
    if (!file) die('用法: bench <model.gguf> [n_predict] [text]');
    const nPredict = parseInt(args[1], 10) || 8;
    const text = args.slice(2).join(' ') || '你好，请帮我写一封邮件。';
    const tLoad0 = Date.now();
    const loaded = loadFullOrDie(file);
    const loadMs = Date.now() - tLoad0;
    const { tokenizer, model } = loaded;
    const promptIds = tokenizer.encode(engine.buildPrompt(text));
    log('prompt tokens:', promptIds.length);
    // 预填充（最后 token 出 logits）
    const tPre = Date.now();
    model.resetCache();
    let logits = null;
    for (let i = 0; i < promptIds.length; i++) {
      logits = model.forward(promptIds[i], i, i === promptIds.length - 1);
    }
    const prefillMs = Date.now() - tPre;
    const tGen = Date.now();
    let pos = promptIds.length;
    let n = 0;
    for (let i = 0; i < nPredict; i++) {
      let best = -Infinity, bestId = -1;
      for (let v = 0; v < logits.length; v++) if (logits[v] > best) { best = logits[v]; bestId = v; }
      if (bestId === tokenizer.eosId) break;
      n++;
      logits = model.forward(bestId, pos++, true);
    }
    const genMs = Date.now() - tGen;
    console.log(JSON.stringify({
      model: path.basename(file),
      load_ms: loadMs,
      prompt_tokens: promptIds.length,
      prefill_ms: prefillMs,
      prefill_ms_per_token: promptIds.length ? Math.round(prefillMs / promptIds.length) : 0,
      gen_tokens: n,
      gen_ms: genMs,
      gen_ms_per_token: n ? Math.round(genMs / n) : 0,
      params: loaded.model.p,
    }));
    return;
  }

  if (cmd === 'dequant') {
    const file = args[0];
    const name = args[1];
    if (!file || !name) die('用法: dequant <model.gguf> <tensor_name> <row> [count]');
    const row = parseInt(args[2], 10) || 0;
    const gguf = loadGgufOrDie(file);
    const t = gguf.tensorMap.get(name);
    if (!t) die('张量不存在: ' + name + '（可用 info 查看）');
    const count = Math.min(parseInt(args[3], 10) || 16, t.rowLen);
    if (row >= t.rows) die('row 越界: ' + row + ' >= ' + t.rows);
    const out = new Float32Array(t.rowLen);
    const views = engine._internal.makeViews(gguf.buffer);
    const rowBytes = engine.tensorRowBytes(t);
    engine.dequantRow(views, t.type, t.dataOffset + row * rowBytes, t.rowLen, out);
    console.log(JSON.stringify({
      tensor: name, type: t.typeName, dims: t.dims, row,
      values: Array.from(out.subarray(0, count)).map((v) => Math.round(v * 1e8) / 1e8),
    }));
    return;
  }

  if (cmd === 'info') {
    const file = args[0];
    if (!file) die('用法: info <model.gguf>');
    const g = loadGgufOrDie(file);
    const types = {};
    for (const t of g.tensors) types[t.typeName] = (types[t.typeName] || 0) + 1;
    const md = g.metadata;
    const keys = Object.keys(md).filter((k) => !/tokenizer\.ggml\.(tokens|merges|token_type|scores)$/.test(k));
    const meta = {};
    for (const k of keys) {
      const v = md[k];
      if (typeof v === 'string' && v.length > 200) meta[k] = v.slice(0, 200) + '…';
      else if (Array.isArray(v) && v.length > 30) meta[k] = '<array len=' + v.length + '>';
      else meta[k] = v;
    }
    console.log(JSON.stringify({
      file: path.basename(file), version: g.version, size: g.size,
      tensorCount: g.tensorCount, alignment: g.alignment, dataStart: g.dataStart,
      tensorTypes: types, metadata: meta,
      tensors: g.tensors.map((t) => ({ name: t.name, type: t.typeName, dims: t.dims })),
    }));
    return;
  }

  if (cmd === 'download-test') {
    const url = args[0] || '';
    const ai = require(path.join(ENGINE_DIR, 'ai.js'));
    const dataDir = path.join(require('os').tmpdir(), 'ec-ai-selftest-' + Date.now());
    ai.init(dataDir);
    ai.setConfig({ enabled: true, model_url: url, model_file: 'selftest-model.gguf' });
    const r = ai.startDownload();
    log('startDownload:', JSON.stringify(r));
    const t0 = Date.now();
    const timer = setInterval(() => {
      const st = ai.status();
      log('status:', JSON.stringify(st));
      if (!st.downloading) {
        clearInterval(timer);
        console.log(JSON.stringify({ result: r, status: ai.status(), elapsed_ms: Date.now() - t0 }));
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
      }
    }, 500);
    return;
  }

  die('未知命令: ' + cmd);
}

main();
