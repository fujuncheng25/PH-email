#!/usr/bin/env node
'use strict';
/**
 * node-ai-bench.js — Node AI 引擎性能基准（真实模型 + 合成量化张量吞吐）。
 *
 * 用法：
 *   node node-ai-bench.js <model.gguf> [--n-predict 20] [--text "..."] [--quant-synth]
 *
 * 输出 JSON（stdout）：
 *   load_ms            模型加载（读盘+解析+分配）
 *   prompt_tokens      §6.3 标题提示词 token 数
 *   prefill_ms         预填充总耗时 / prefill_ms_per_token
 *   gen_tokens / gen_ms / gen_ms_per_token   贪心生成耗时（不含最后 lm_head 之后的空转）
 *   total_title_ms     若按 §6.3 后处理生成一条标题的近似总耗时
 *   quant_synth        Q8_0/Q4_K/Q6_K/Q4_0/F16 合成张量 matvec 吞吐（G 元素/秒）
 *
 * --quant-synth 只跑合成吞吐基准，不加载模型。
 */
const path = require('path');
const fs = require('fs');

const engine = require(path.join(__dirname, '..', 'electron', 'gguf.js'));

function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }

function syntheticQuantBench() {
  const results = {};
  const specs = [
    ['F32', engine.QT.F32, 1, 4],
    ['F16', engine.QT.F16, 1, 2],
    ['BF16', engine.QT.BF16, 1, 2],
    ['Q8_0', engine.QT.Q8_0, 32, 34],
    ['Q4_0', engine.QT.Q4_0, 32, 18],
    ['Q4_K', engine.QT.Q4_K, 256, 144],
    ['Q6_K', engine.QT.Q6_K, 256, 210],
  ];
  // 约 64MB 权重，rows*rowLen = 16M 元素
  const targetElems = 16 * 1024 * 1024;
  for (const [name, type, block, blockBytes] of specs) {
    let rowLen = block === 1 ? 1024 : block;
    // 让 rowLen 是 block 的整数倍，rows 使元素总数接近 targetElems
    while (rowLen * block < 4096) rowLen *= 2;
    let rows = Math.floor(targetElems / rowLen);
    const elems = rows * rowLen;
    const nbytes = (elems / block) * blockBytes;
    const buf = Buffer.alloc(nbytes);
    // 填充随机-ish 数据，避免全零导致分支预测友好（对量化解码耗时影响很小）
    for (let i = 0; i < nbytes; i += 4096) buf[i] = (i * 37) & 0xff;
    const views = engine._internal.makeViews(buf);
    // 构造伪张量描述
    const t = {
      name: 'synthetic', dims: [rowLen, rows], type, elems, rows, rowLen,
      block, blockBytes, dataOffset: 0,
      nbytes, typeName: name,
    };
    const x = new Float32Array(rowLen);
    for (let i = 0; i < rowLen; i++) x[i] = ((i * 7919) % 100) / 100 - 0.5;
    const out = new Float32Array(rows);
    const scratch = new Float32Array(rowLen);
    // 预热
    engine.matVec(views, t, x, out, scratch);
    const t0 = nowMs();
    const iters = 3;
    for (let i = 0; i < iters; i++) engine.matVec(views, t, x, out, scratch);
    const ms = (nowMs() - t0) / iters;
    results[name] = {
      ms_per_matvec: +ms.toFixed(2),
      elems: elems,
      g_elems_per_s: +(elems / (ms / 1000) / 1e9).toFixed(3),
    };
  }
  return results;
}

function main() {
  const argv = process.argv.slice(2);
  const model = argv.find((a) => !a.startsWith('--') && fs.existsSync(a)) || '';
  const nPredictArg = argv.indexOf('--n-predict');
  const nPredict = nPredictArg >= 0 ? parseInt(argv[nPredictArg + 1], 10) || 20 : 20;
  const textArg = argv.indexOf('--text');
  const text = textArg >= 0 ? argv[textArg + 1] :
    '王老师您好，我想确认一下下周三下午三点的项目评审会议是否需要提前准备材料？另外上次提到的预算表我已经整理好，稍后发您。';
  const synthOnly = argv.includes('--quant-synth');
  const ignoreEos = argv.includes('--ignore-eos');

  if (synthOnly || !model) {
    console.log(JSON.stringify({ quant_synth: syntheticQuantBench() }));
    if (!model) return;
  }

  const result = { model: path.basename(model), model_bytes: fs.statSync(model).size };
  const tLoad = nowMs();
  const loaded = engine.loadModel(model, { nCtx: 1024 });
  result.load_ms = +(nowMs() - tLoad).toFixed(0);
  const { tokenizer, model: m } = loaded;
  const p = m.p;
  result.params = { arch: p.arch, n_layer: p.nLayer, n_embd: p.nEmbd, n_ff: p.nFF, n_head: p.nHead, n_head_kv: p.nHeadKv, vocab: tokenizer.nVocab };

  const prompt = engine.buildPrompt(text);
  const ids = tokenizer.encode(prompt);
  result.prompt_chars = prompt.length;
  result.prompt_tokens = ids.length;

  // 预填充（最后一 token 出 logits）
  m.resetCache();
  const tPre = nowMs();
  let logits = null;
  for (let i = 0; i < ids.length; i++) logits = m.forward(ids[i], i, i === ids.length - 1);
  const prefillMs = nowMs() - tPre;
  result.prefill_ms = +prefillMs.toFixed(0);
  result.prefill_ms_per_token = +(prefillMs / ids.length).toFixed(1);

  // 贪心生成 nPredict 个 token
  let pos = ids.length;
  let genTokens = 0;
  const tGen = nowMs();
  const tFirst = nowMs();
  let firstTokenMs = 0;
  for (let i = 0; i < nPredict; i++) {
    let best = -Infinity, bestId = -1;
    for (let v = 0; v < logits.length; v++) if (logits[v] > best) { best = logits[v]; bestId = v; }
    if (bestId === tokenizer.eosId && !ignoreEos) break;
    if (i === 0) firstTokenMs = nowMs() - tFirst;
    genTokens++;
    logits = m.forward(bestId, pos++, true);
  }
  const genMs = nowMs() - tGen;
  result.gen_tokens = genTokens;
  result.gen_ms = +genMs.toFixed(0);
  result.gen_ms_per_token = genTokens ? +(genMs / genTokens).toFixed(0) : 0;
  result.first_token_ms = +firstTokenMs.toFixed(0);
  result.title_total_ms_approx = +(prefillMs + genMs).toFixed(0);
  result.total_for_20_tokens_s = +((prefillMs + genMs) / 1000).toFixed(1);

  console.log(JSON.stringify(result, null, 1));
}

main();
