'use strict';
/**
 * Email Chatter 2.0 — Node AI 标题引擎（对外门面模块）
 *
 * 接口契约见 FEATURE-SPEC.md §6.5：
 *   init(dataDir), setConfig(cfg), getConfig(), status(),
 *   startDownload() -> {ok, error?, already?}, cancelDownload(),
 *   generateTitle(text) -> Promise<{title, source:'ai'|'heuristic', note}>,
 *   heuristicTitle(text)
 *
 * 设计要点：
 *  - 只依赖 Node 内置模块（fs/path/http/https/worker_threads），不引入第三方依赖；
 *  - 推理全部在 worker_threads（ai-worker.js）里做，主线程/HTTP 服务不被阻塞；
 *  - 下载走后台任务（https/http + 重定向 + 进度 + .part 校验 + 取消），status() 始终快速返回；
 *  - generateTitle() 永不 reject：模型未就绪/推理失败/超时都回落到启发式标题并带 note；
 *  - 推理引擎惰性加载，空闲 5 分钟自动卸载（terminate worker 释放内存）。
 *
 * 本模块不依赖 backend.js 内部状态，可单独 require 做单元测试。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { Worker } = require('worker_threads');

// ---------------------------------------------------------------- 常量

const ENGINE_NAME = 'qwen2.5-0.5b-instruct-q4_k_m';
const DEFAULT_MODEL_FILE = 'qwen2.5-0.5b-instruct-q4_k_m.gguf';
const DEFAULT_MIRROR = 'https://hf-mirror.com';
// 下载完成的最小合法体积（防止把错误页/半截文件当模型）
const MIN_MODEL_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;    // 连接/无数据超时（有数据时按活动重置）
const WORKER_LOAD_TIMEOUT_MS = 180 * 1000; // 首次加载模型（1.5B Q8_0 读盘+解析）上限
const GEN_TIMEOUT_MS = Math.max(5000, parseInt(process.env.EMAIL_CHATTER_AI_TIMEOUT_MS, 10) || 170 * 1000);
const IDLE_UNLOAD_MS = Math.max(10000, parseInt(process.env.EMAIL_CHATTER_AI_IDLE_MS, 10) || 5 * 60 * 1000);
const MAX_GEN_TOKENS = 24;

// ---------------------------------------------------------------- 状态

const state = {
  dataDir: '',
  modelsDir: '',
  cfg: {
    enabled: false,
    mirror: DEFAULT_MIRROR,
    model_url: '',
    model_file: DEFAULT_MODEL_FILE,
  },
  error: '',                 // 模型文件/加载/下载错误（status().error）
  ready: false,              // 模型文件可用（首 4 字节 GGUF 且体积达标）
  readyCheckAt: 0,
  modelBytes: 0,
  // 下载
  downloading: false,
  downloadedBytes: 0,
  totalBytes: 0,
  cancelFlag: false,
  dlReq: null,               // 当前 http(s) ClientRequest
  dlStream: null,            // .part 写入流
  dlRun: null,               // 下载 Promise（测试/取消用）
  partPath: '',
  finalPath: '',
  // 推理
  busy: false,
  worker: null,
  workerReady: false,
  workerLoading: null,       // Promise
  reqId: 0,
  idleTimer: null,
  lastUseAt: 0,
};

let aiLock = Promise.resolve(); // 串行化 generateTitle（同一时刻只允许一个推理）

// ---------------------------------------------------------------- 工具

function now() { return Date.now(); }

function cfgCopy() {
  return {
    enabled: !!state.cfg.enabled,
    mirror: state.cfg.mirror || DEFAULT_MIRROR,
    model_url: state.cfg.model_url || '',
    model_file: state.cfg.model_file || DEFAULT_MODEL_FILE,
  };
}

function modelPath() {
  return path.join(state.modelsDir, state.cfg.model_file || DEFAULT_MODEL_FILE);
}

function sanitizeModelFile(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') return DEFAULT_MODEL_FILE;
  if (!/\.gguf$/i.test(base)) return DEFAULT_MODEL_FILE;
  return base;
}

/** 下载候选 URL（顺序尝试；cfg.model_url 非空时只用它） */
function resolveModelUrls() {
  const custom = String(state.cfg.model_url || '').trim();
  if (custom) return [custom];
  let mirror = String(state.cfg.mirror || '').trim() || DEFAULT_MIRROR;
  mirror = mirror.replace(/\/+$/, '');
  return [
    `${mirror}/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf?download=true`,
    `${mirror}/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf?download=true`,
    `${mirror}/unsloth/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf?download=true`,
  ];
}

// ---------------------------------------------------------------- 启发式标题 / 标题后处理

/**
 * 启发式标题（无模型/失败时，C++/Node/前端一致）：
 * 取正文第一个非空行，去除 markdown 标记与多余空白，截断 30 字符（超长加 …）；空则 "无主题"。
 */
function heuristicTitle(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  let line = '';
  for (const raw of s.split('\n')) {
    if (String(raw).trim()) { line = String(raw).trim(); break; }
  }
  if (!line) return '无主题';
  let t = line
    .replace(/^\s*>\s?/, '')             // 引用块
    .replace(/^\s*#{1,6}\s+/, '')        // markdown 标题
    .replace(/^\s*[-*+]\s+/, '')         // 无序列表
    .replace(/^\s*\d+[.)]\s+/, '')       // 有序列表
    .replace(/\*\*([^*]*)\*\*/g, '$1')   // 粗体
    .replace(/__([^_]*)__/g, '$1')       // 粗体
    .replace(/\*([^*]*)\*/g, '$1')       // 斜体
    .replace(/`+/g, '')                  // 行内代码
    .replace(/[*_~]/g, '');              // 其余标记
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return '无主题';
  const chars = Array.from(t);
  if (chars.length > 30) return chars.slice(0, 30).join('') + '…';
  return t;
}

/** §6.3 后处理：去前缀/包裹引号/尾部标点，换行变空格，截断 40 字符。 */
function postProcessTitle(raw, text) {
  let t = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim();
  t = t.replace(/^\s*标题\s*[:：]\s*/, '').trim();
  // 去掉包裹引号（可能多层）
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

// ---------------------------------------------------------------- 模型文件就绪检查

function checkGgufMagic(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4);
    const n = fs.readSync(fd, b, 0, 4, 0);
    return n === 4 && b.toString('latin1') === 'GGUF';
  } catch (e) {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

/**
 * 刷新 model_ready（带 1.5s 节流，避免 status() 每次 stat 拖慢）。
 * force=true 用于 init/setConfig/下载完成后。
 */
function refreshReady(force) {
  if (state.downloading) return state.ready;
  const t = now();
  if (!force && t - state.readyCheckAt < 1500) return state.ready;
  state.readyCheckAt = t;
  state.ready = false;
  state.modelBytes = 0;
  const file = modelPath();
  let st = null;
  try { st = fs.statSync(file); } catch (e) { st = null; }
  if (!st || !st.isFile()) {
    if (state.error && /模型文件/.test(state.error)) state.error = '';
    return false;
  }
  state.modelBytes = st.size;
  if (st.size < MIN_MODEL_BYTES) {
    state.error = '模型文件不完整（' + (st.size / 1048576).toFixed(1) + ' MB），请重新下载';
    return false;
  }
  if (!checkGgufMagic(file)) {
    state.error = '模型文件格式不正确（缺少 GGUF 标识），请重新下载';
    return false;
  }
  state.ready = true;
  if (state.error && /模型文件/.test(state.error)) state.error = '';
  return true;
}

// ---------------------------------------------------------------- 配置

/** 初始化/重复调用均安全：建立 data/models 目录、清理残留 .part。 */
function init(dataDir) {
  if (dataDir) {
    state.dataDir = path.resolve(String(dataDir));
    state.modelsDir = path.join(state.dataDir, 'models');
  } else if (!state.modelsDir) {
    state.modelsDir = path.join(process.cwd(), 'data', 'models');
    state.dataDir = path.dirname(state.modelsDir);
  }
  try { fs.mkdirSync(state.modelsDir, { recursive: true }); } catch (e) {}
  // 启动时清理上一次中断留下的 .part（不支持断点续传）
  try {
    for (const f of fs.readdirSync(state.modelsDir)) {
      if (f.endsWith('.part')) { try { fs.unlinkSync(path.join(state.modelsDir, f)); } catch (e) {} }
    }
  } catch (e) {}
  refreshReady(true);
  return cfgCopy();
}

/** 合并配置；只覆盖提供的字段，与 backend 的“部分保存”语义一致。 */
function setConfig(cfg) {
  if (cfg && typeof cfg === 'object') {
    const c = state.cfg;
    if (typeof cfg.enabled === 'boolean') c.enabled = cfg.enabled;
    if (typeof cfg.mirror === 'string') {
      // 规范化：去首尾空白与尾部斜杠（拼候选 URL 时不会再出现双斜杠）
      c.mirror = cfg.mirror.trim().replace(/\/+$/, '') || DEFAULT_MIRROR;
    }
    if (typeof cfg.model_url === 'string') c.model_url = cfg.model_url.trim();
    if (typeof cfg.model_file === 'string') {
      const mf = sanitizeModelFile(cfg.model_file);
      if (mf !== c.model_file) {
        c.model_file = mf;
        // 模型文件切换后，旧的 worker 不再有效
        terminateWorker();
        state.error = '';
      }
    }
  }
  refreshReady(true);
  return cfgCopy();
}

function getConfig() { return cfgCopy(); }

/** §4.6 ai 状态对象（backend 直接 JSON 返回即可）。始终同步、快速。 */
function status() {
  refreshReady(false);
  const downloading = state.downloading;
  let downloadedBytes = 0;
  let totalBytes = 0;
  let percent = 0;
  if (downloading) {
    downloadedBytes = state.downloadedBytes;
    totalBytes = state.totalBytes;
    percent = totalBytes > 0 ? Math.min(100, Math.floor((downloadedBytes * 100) / totalBytes)) : 0;
  } else if (state.ready) {
    downloadedBytes = state.modelBytes;
    totalBytes = state.modelBytes;
    percent = 100;
  }
  return {
    enabled: !!state.cfg.enabled,
    model_ready: !!state.ready && !downloading,
    downloading,
    downloaded_bytes: downloadedBytes,
    total_bytes: totalBytes,
    percent,
    error: state.error || '',
    model_file: state.cfg.model_file || DEFAULT_MODEL_FILE,
    mirror: state.cfg.mirror || DEFAULT_MIRROR,
    busy: !!state.busy,
    engine: ENGINE_NAME,
  };
}

// ---------------------------------------------------------------- 下载

function destroyDownloadHandles() {
  const req = state.dlReq;
  state.dlReq = null;
  if (req) { try { req.destroy(); } catch (e) {} }
  const st = state.dlStream;
  state.dlStream = null;
  if (st) { try { st.destroy(); } catch (e) {} }
}

/**
 * 下载单个 URL（跟随最多 5 次重定向）。
 * resolve(true) 表示 .part 已完整落盘（尚未校验/改名）。
 */
function downloadOne(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let fileStream = null;
    let bytes = 0;

    // 只销毁请求，不销毁写入流；写入流由 finish 自己 end/destroy 以保证数据刷盘完整
    const killReq = () => {
      const req = state.dlReq;
      state.dlReq = null;
      if (req) { try { req.destroy(); } catch (e) {} }
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      killReq();
      const fs2 = fileStream;
      fileStream = null;
      state.dlStream = null;
      if (fs2) {
        if (err) {
          try { fs2.destroy(); } catch (e) {}
          reject(err);
        } else {
          // 等 'finish' 事件（所有缓冲已落盘）再返回
          fs2.end(() => resolve(true));
        }
      } else if (err) {
        reject(err);
      } else {
        resolve(true);
      }
    };

    const openPart = () => {
      if (fileStream) return;
      fileStream = fs.createWriteStream(state.partPath, { flags: 'w' });
      state.dlStream = fileStream;
      fileStream.on('error', (e) => finish(new Error('写入模型文件失败: ' + (e && e.message || e))));
    };

    const get = (target, redirectsLeft) => {
      if (state.cancelFlag) return finish(new Error('已取消'));
      let parsed;
      try { parsed = new URL(target); } catch (e) { return finish(new Error('模型下载地址无效: ' + target)); }
      const mod = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
      if (!mod) return finish(new Error('不支持的下载协议: ' + parsed.protocol));
      let req;
      try {
        req = mod.get(parsed, {
          headers: {
            'User-Agent': 'email-chatter/2.0 (+node)',
            'Accept': '*/*',
          },
          timeout: DOWNLOAD_TIMEOUT_MS,
        });
      } catch (e) {
        return finish(new Error('下载请求失败: ' + (e && e.message || e)));
      }
      state.dlReq = req;
      req.on('timeout', () => {
        try { req.destroy(new Error('下载超时（长时间无数据）')); } catch (e) {}
      });
      req.on('error', (e) => {
        if (state.cancelFlag) return finish(new Error('已取消'));
        finish(new Error('下载失败: ' + (e && e.message || e)));
      });
      req.on('response', (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return finish(new Error('重定向次数过多'));
          let next;
          try { next = new URL(res.headers.location, target).toString(); } catch (e) { return finish(new Error('重定向地址无效')); }
          try { req.destroy(); } catch (e) {}
          return get(next, redirectsLeft - 1);
        }
        if (code !== 200) {
          res.resume();
          return finish(new Error('服务器返回 HTTP ' + code));
        }
        const len = parseInt(res.headers['content-length'], 10);
        state.totalBytes = Number.isFinite(len) && len > 0 ? len : 0;
        openPart();
        res.on('data', (chunk) => {
          if (state.cancelFlag) { killReq(); return finish(new Error('已取消')); }
          bytes += chunk.length;
          state.downloadedBytes = bytes;
          const out = state.dlStream;
          if (!out) return;
          try { out.write(chunk); } catch (e) { return finish(new Error('写入模型文件失败: ' + (e && e.message || e))); }
        });
        res.on('error', (e) => finish(new Error('下载中断: ' + (e && e.message || e))));
        res.on('aborted', () => finish(new Error('下载中断（连接被中断）')));
        res.on('end', () => {
          if (!state.totalBytes) state.totalBytes = bytes;
          finish(null);
        });
      });
    };

    get(url, MAX_REDIRECTS);
  });
}

/** 校验 .part：GGUF 魔数 + 最小体积；通过后改名为正式模型文件。 */
function validateAndInstallPart() {
  const part = state.partPath;
  let st = null;
  try { st = fs.statSync(part); } catch (e) { throw new Error('下载文件不存在'); }
  if (st.size < MIN_MODEL_BYTES) {
    throw new Error('下载文件过小（' + (st.size / 1048576).toFixed(1) + ' MB，可能是错误页），已丢弃');
  }
  if (!checkGgufMagic(part)) throw new Error('下载文件不是有效的 GGUF 模型（缺少 GGUF 标识），已丢弃');
  const final = modelPath();
  try { if (fs.existsSync(final)) fs.unlinkSync(final); } catch (e) {}
  fs.renameSync(part, final);
  state.modelBytes = st.size;
  state.totalBytes = st.size;
  state.downloadedBytes = st.size;
  state.error = '';
  refreshReady(true);
  if (!state.ready) throw new Error('模型文件校验失败');
}

async function runDownload(urls) {
  const errs = [];
  for (const url of urls) {
    if (state.cancelFlag) break;
    state.totalBytes = 0;
    state.downloadedBytes = 0;
    try {
      state.partPath = modelPath() + '.part';
      state.finalPath = modelPath();
      try { fs.rmSync(state.partPath, { force: true }); } catch (e) {}
      await downloadOne(url);
      if (state.cancelFlag) throw new Error('已取消');
      validateAndInstallPart();
      return true;
    } catch (e) {
      const msg = String((e && e.message) || e);
      errs.push(msg);
      destroyDownloadHandles();
      try { fs.rmSync(state.partPath, { force: true }); } catch (e2) {}
      if (state.cancelFlag || /取消/.test(msg)) break;
    }
  }
  if (state.cancelFlag) {
    state.error = '';
    return false;
  }
  state.error = '模型下载失败：' + (errs[errs.length - 1] || '未知错误') +
    (errs.length > 1 ? '（已尝试 ' + errs.length + ' 个下载源）' : '');
  return false;
}

/**
 * 启动后台下载。立即返回（不阻塞 HTTP）。
 * 返回 {ok, error?, already?}：已就绪 → already:true；正在下载/正忙 → ok:false+error。
 */
function startDownload() {
  if (state.downloading) return { ok: false, error: '模型正在下载中' };
  refreshReady(true);
  if (state.ready) return { ok: true, already: true };
  if (state.busy) return { ok: false, error: 'AI 正在生成标题，请稍后再下载模型' };
  state.error = '';
  state.downloading = true;
  state.cancelFlag = false;
  state.totalBytes = 0;
  state.downloadedBytes = 0;
  state.dlRun = runDownload(resolveModelUrls())
    .catch((e) => { state.error = '模型下载失败：' + String((e && e.message) || e); })
    .finally(() => {
      state.downloading = false;
      state.dlRun = null;
      destroyDownloadHandles();
      if (state.cancelFlag) {
        try { fs.rmSync(modelPath() + '.part', { force: true }); } catch (e) {}
      }
      state.cancelFlag = false;
      refreshReady(true);
    });
  return { ok: true };
}

/** 取消下载：原子 flag + 销毁请求 + 删除 .part。返回最新 status。 */
function cancelDownload() {
  if (!state.downloading) return status();
  state.cancelFlag = true;
  destroyDownloadHandles();
  try { fs.rmSync(modelPath() + '.part', { force: true }); } catch (e) {}
  state.downloading = false;
  state.downloadedBytes = 0;
  state.totalBytes = 0;
  state.error = '';
  return status();
}

// ---------------------------------------------------------------- 推理 worker

function terminateWorker() {
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  const w = state.worker;
  state.worker = null;
  state.workerReady = false;
  state.workerLoading = null;
  if (w) { try { w.terminate(); } catch (e) {} }
}

/** 空闲 5 分钟后卸载模型（terminate worker 释放整块内存）。 */
function scheduleIdleUnload() {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    if (state.busy) { scheduleIdleUnload(); return; }
    terminateWorker();
  }, IDLE_UNLOAD_MS);
  if (state.idleTimer.unref) state.idleTimer.unref();
}

/** 惰性创建 worker 并等待模型加载完成。 */
function ensureWorker() {
  if (state.worker && state.workerReady) return Promise.resolve(state.worker);
  if (state.workerLoading) return state.workerLoading;
  state.workerLoading = new Promise((resolve, reject) => {
    let settled = false;
    const file = modelPath();
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'ai-worker.js'), {
        workerData: { modelPath: file },
        resourceLimits: { maxOldGenerationSizeMb: 6144 },
      });
    } catch (e) {
      state.workerLoading = null;
      return reject(new Error('无法启动 AI 工作线程: ' + (e && e.message || e)));
    }
    state.worker = worker;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateWorker();
      reject(new Error('AI 模型加载超时'));
    }, WORKER_LOAD_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    worker.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') { state.workerReady = true; done(resolve, worker); }
      else if (m.type === 'fatal') {
        state.error = 'AI 模型加载失败：' + (m.error || '未知错误');
        terminateWorker();
        done(reject, new Error(state.error));
      }
    });
    worker.on('error', (e) => {
      if (state.busy) state.error = 'AI 工作线程错误：' + (e && e.message || e);
      terminateWorker();
      done(reject, new Error('AI 工作线程错误: ' + (e && e.message || e)));
    });
    worker.on('exit', () => {
      state.workerReady = false;
      if (state.worker === worker) state.worker = null;
      done(reject, new Error('AI 工作线程已退出'));
    });
    // 加载期间保持 worker ref（进程不会因为只有 worker 而提前退出）；
    // 就绪后转由 workerGenerate 在使用期间 ref、空闲时 unref。
  });
  const p = state.workerLoading;
  p.catch(() => {}).finally(() => { if (state.workerLoading === p) state.workerLoading = null; });
  return p;
}

/** 在 worker 中生成一条标题（可能先加载模型）。失败/超时会终止 worker 以便下次重载。 */
function workerGenerate(text) {
  return ensureWorker().then((worker) => new Promise((resolve, reject) => {
    const id = ++state.reqId;
    let settled = false;
    // 推理期间 ref：即使调用方没有其它活跃句柄（如 CLI 自测），进程也不会提前退出
    try { worker.ref(); } catch (e) {}
    const cleanup = () => {
      worker.removeListener('message', onMsg);
      worker.removeListener('error', onErr);
      worker.removeListener('exit', onExit);
      clearTimeout(timer);
      try { worker.unref(); } catch (e) {} // 空闲后不阻止进程退出
    };
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    const onMsg = (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'result' && m.id === id) return done(resolve, m);
      if (m.type === 'error' && m.id === id) return done(reject, new Error(m.error || 'AI 推理失败'));
      if (m.type === 'fatal') {
        state.error = 'AI 模型加载失败：' + (m.error || '未知错误');
        terminateWorker();
        return done(reject, new Error(state.error));
      }
    };
    const onErr = (e) => {
      terminateWorker();
      done(reject, new Error('AI 工作线程错误: ' + (e && e.message || e)));
    };
    const onExit = () => {
      terminateWorker();
      done(reject, new Error('AI 工作线程意外退出'));
    };
    const timer = setTimeout(() => {
      terminateWorker();
      done(reject, new Error('AI 推理超时'));
    }, GEN_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    worker.on('message', onMsg);
    worker.on('error', onErr);
    worker.on('exit', onExit);
    try {
      worker.postMessage({ type: 'generate', id, text: String(text || ''), maxTokens: MAX_GEN_TOKENS });
    } catch (e) {
      terminateWorker();
      done(reject, new Error('提交推理任务失败: ' + (e && e.message || e)));
    }
  }));
}

// ---------------------------------------------------------------- 对外生成入口

/**
 * 生成邮件标题。永远 resolve：
 *   {title, source:'ai'|'heuristic', note}
 * 未启用/未下载/下载中/忙/失败/超时 → 启发式标题 + note 说明原因。
 */
function generateTitle(text) {
  const heuristic = heuristicTitle(text);
  const cfg = state.cfg;
  const note = (reason) => ({ title: heuristic, source: 'heuristic', note: reason });

  if (!cfg.enabled) return Promise.resolve(note('AI 标题未启用'));
  refreshReady(true);
  if (state.downloading) return Promise.resolve(note('AI 模型正在下载中'));
  if (!state.ready) return Promise.resolve(note(state.error || 'AI 模型未下载'));

  // 串行化：同一时刻只允许一个推理任务（规格 §6.2）
  const run = aiLock.then(async () => {
    if (!state.ready) return note(state.error || 'AI 模型未下载');
    state.busy = true;
    state.lastUseAt = now();
    try {
      const res = await workerGenerate(text);
      const title = postProcessTitle(res && res.title, text);
      const n = Number(res && res.genTokens) || 0;
      const elapsed = Number(res && res.elapsedMs) || 0;
      return {
        title,
        source: 'ai',
        note: '',
        tokens: n,
        elapsed_ms: elapsed,
        prompt_tokens: Number(res && res.promptTokens) || 0,
      };
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 超时/推理失败不写持久 error（避免下一次状态一直显示错误）
      return note('AI 推理失败：' + msg);
    } finally {
      state.busy = false;
      scheduleIdleUnload();
    }
  });
  // aiLock 只关心“前一个任务结束”，不让异常破坏链
  aiLock = run.then(() => {}, () => {});
  return run;
}

// ---------------------------------------------------------------- 导出（§6.5 契约）

module.exports = {
  init,
  setConfig,
  getConfig,
  status,
  startDownload,
  cancelDownload,
  generateTitle,
  heuristicTitle,
  postProcessTitle,
  // 测试/工具用（backend 不应依赖）：
  _private: {
    state,
    modelPath,
    resolveModelUrls,
    refreshReady,
    terminateWorker,
    // 自测脚本可指向已有的模型目录（避免复制大文件）
    setModelsDir(dir) { state.modelsDir = path.resolve(String(dir)); refreshReady(true); return state.modelsDir; },
    constants: {
      ENGINE_NAME, DEFAULT_MODEL_FILE, DEFAULT_MIRROR, MIN_MODEL_BYTES,
      GEN_TIMEOUT_MS, IDLE_UNLOAD_MS, MAX_GEN_TOKENS,
    },
  },
};
