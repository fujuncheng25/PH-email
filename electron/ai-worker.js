'use strict';
/**
 * Email Chatter 2.0 — AI 推理 worker 线程。
 *
 * 在 worker_threads 中加载 GGUF/Qwen2 模型并执行推理，主线程（ai.js / HTTP 服务 / 轮询）
 * 不被阻塞。由 ai.js 通过 workerData.modelPath 启动。
 *
 * 消息协议
 *   主线程 -> worker:
 *     { type:'generate', id, text, maxTokens }   生成邮件标题（§6.3 提示词 + 贪心 + 后处理）
 *     { type:'ping' }                            探活
 *     { type:'shutdown' }                        卸载模型并退出
 *   worker -> 主线程:
 *     { type:'ready', loadMs, params }           模型加载完成
 *     { type:'result', id, title, raw, promptTokens, genTokens, elapsedMs, loadMs }
 *     { type:'error', id, error }                单次推理失败（worker 仍可用）
 *     { type:'fatal', error }                    模型加载失败（worker 不可用）
 *     { type:'pong' }
 *
 * 说明：worker 只负责“模型文件 -> 标题文本”，不关心下载/配置/后端状态；
 *      超时与回退由主线程 ai.js 负责（超时后 terminate worker 释放内存）。
 */
const { parentPort, workerData } = require('worker_threads');
const path = require('path');

const ENGINE_DIR = __dirname;
let engine = null;      // gguf.js 模块
let loaded = null;      // {gguf, tokenizer, model}
let loadMs = 0;

function send(msg) {
  try { parentPort.postMessage(msg); } catch (e) { /* 主线程可能已退出 */ }
}

function loadModel(modelPath) {
  if (!modelPath) throw new Error('缺少模型文件路径');
  engine = require(path.join(ENGINE_DIR, 'gguf.js'));
  const t0 = Date.now();
  loaded = engine.loadModel(modelPath, { nCtx: 1024 });
  loadMs = Date.now() - t0;
  return loaded;
}

function handleGenerate(req) {
  const t0 = Date.now();
  try {
    if (!loaded) throw new Error('模型尚未加载');
    const maxTokens = Math.min(Math.max(parseInt(req.maxTokens, 10) || 24, 1), 64);
    const r = engine.generateTitleWithModel(loaded, String(req.text || ''), { maxTokens });
    send({
      type: 'result',
      id: req.id,
      title: r.title,
      raw: r.raw,
      promptTokens: r.promptTokens,
      genTokens: r.genTokens,
      genTokenIds: r.genTokenIds || [],
      elapsedMs: Date.now() - t0,
      loadMs,
    });
  } catch (e) {
    send({ type: 'error', id: req.id, error: String((e && e.message) || e) });
  }
}

try {
  const modelPath = workerData && workerData.modelPath;
  loadModel(modelPath);
  const p = loaded.model.p;
  send({
    type: 'ready',
    loadMs,
    params: {
      arch: p.arch, nLayer: p.nLayer, nEmbd: p.nEmbd, nFF: p.nFF,
      nHead: p.nHead, nHeadKv: p.nHeadKv, headDim: p.headDim, nCtx: loaded.model.nCtx,
      nVocab: loaded.tokenizer.nVocab,
    },
  });
} catch (e) {
  send({ type: 'fatal', error: String((e && e.message) || e) });
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'generate':
        handleGenerate(msg);
        break;
      case 'ping':
        send({ type: 'pong' });
        break;
      case 'shutdown':
        loaded = null;
        if (engine) engine = null;
        // 允许主线程 terminate；这里主动退出以尽快释放内存
        process.exit(0);
        break;
      default:
        break;
    }
  });
}
