'use strict';
/* Email Chatter 2.0 - WeChat-like email IM client UI（零构建，原生 JS） */

const $ = (id) => document.getElementById(id);

let state = { friends: [], configured: false, account: {}, ai: null };
let activePeer = null;
let messagesCache = [];
let searchTerm = '';
let backendOnline = true;
let lastRenderKey = '';

/* ---------------- 离线精简模式：本地缓存 + 待发队列 ---------------- */
const LS_STATE = 'ec.state';
const LS_MSGS = (peer) => 'ec.msgs.' + peer;
const LS_OUTBOX = 'ec.outbox';

function lsGet(key, dflt) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 配额满则忽略 */ }
}
function getOutbox() { return lsGet(LS_OUTBOX, []); }
function setOutbox(q) { lsSet(LS_OUTBOX, q); updateOfflineBanner(); }

function updateOfflineBanner() {
  const el = $('offline-banner');
  if (!el) return;
  const q = getOutbox().length;
  if (backendOnline) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.textContent = '离线模式：仅显示缓存消息' + (q ? ' · ' + q + ' 条待发送' : '') + '（启动本地服务后自动同步）';
}

const AVATAR_COLORS = ['#5b8ff9', '#5ad8a6', '#5d7092', '#f6bd16', '#e8684a', '#6dc8ec', '#9270ca', '#ff9d4d', '#269a99', '#ff99c3'];

function avatarColor(email) {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initialOf(s) { return (s || '?').trim().charAt(0).toUpperCase() || '?'; }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtSize(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtMB(n) {
  if (!n) return '0 MB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function truncateText(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function isImageMime(mime, name) {
  if (/^image\//i.test(mime || '')) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name || '');
}
function isImageAtt(a) {
  if (!a) return false;
  if (a.inline) return true;
  return isImageMime(a.mime, a.name);
}
function isImageFile(f) { return /^image\//i.test(f.type || '') || isImageMime('', f.name); }
function peerDisplayName(email) {
  if (!email) return '';
  const f = (state.friends || []).find((x) => x.email === email);
  return (f && (f.name || f.email)) || email;
}
function selfDisplayName() {
  const a = state.account || {};
  return a.display_name || a.email || '我';
}

/* ---------------- 后端请求 ---------------- */
async function api(path, method, body) {
  let res;
  try {
    const opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    res = await fetch(path, opts);
  } catch (e) {
    backendOnline = false;
    return { ok: false, offline: true, error: '本地服务未运行：离线模式（仅缓存与排队）' };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  backendOnline = true;
  if (!data) return { ok: false, error: '本地服务响应异常（HTTP ' + res.status + '）' };
  return data;
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------------- 草稿：正文 / 附件 / 引用（两态共用） ---------------- */
const draft = {
  attachments: [],   // {id,name,size,mime,objUrl,uploading}
  quote: null,
};
const ui = { emailMode: false };
let sending = false;
let sendingLabel = '';
const MAX_ATTACH_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_ATTACH_BYTES = 24 * 1024 * 1024;

function hasUploadingAttachment() { return draft.attachments.some((a) => a.uploading); }

function updateToolbar() {
  const busy = sending || hasUploadingAttachment();
  const sendBtn = $('btn-send');
  const emailBtn = $('btn-email-send');
  sendBtn.disabled = busy;
  emailBtn.disabled = busy;
  $('btn-expand').disabled = sending;
  $('btn-attach').disabled = sending;
  $('btn-email-attach').disabled = sending;
  $('btn-ai-title').disabled = sending;
  if (!sending) {
    sendBtn.textContent = '发送';
    emailBtn.textContent = '发送';
  } else {
    sendBtn.textContent = sendingLabel;
    emailBtn.textContent = sendingLabel;
  }
}

function setSending(on, label) {
  sending = !!on;
  sendingLabel = on ? (label || '发送中…') : '';
  updateToolbar();
}

function renderAttachments() {
  const html = draft.attachments.map((a, i) => {
    const thumb = isImageAtt(a) && a.objUrl
      ? `<img src="${esc(a.objUrl)}" alt="">`
      : `<span>${isImageAtt(a) ? '🖼' : '📄'}</span>`;
    const status = a.uploading
      ? '<span class="att-chip-size up">上传中…</span>'
      : `<span class="att-chip-size">${esc(fmtSize(a.size))}</span>`;
    return `<span class="att-chip">
      <span class="att-chip-thumb">${thumb}</span>
      <span class="att-chip-info">
        <span class="att-chip-name" title="${esc(a.name)}">${esc(a.name)}</span>
        ${status}
      </span>
      <button class="chip-x" data-att-del="${i}" title="移除附件">×</button>
    </span>`;
  }).join('');
  $('collapsed-atts').innerHTML = html;
  $('email-atts').innerHTML = html;
  updateToolbar();
}

function renderQuote() {
  ['collapsed-quote', 'email-quote'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const q = draft.quote;
    if (!q) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = 'flex';
    el.innerHTML = `<div class="quote-bar-inner">
        <span class="quote-bar-label">引用 ${esc(q.from || '')}：</span>
        <span class="quote-bar-text">${esc(truncateText(q.text || '', 120))}</span>
      </div>
      <button class="chip-x" data-quote-clear="1" title="取消引用">×</button>`;
  });
}

function removeDraftAttachment(item) {
  const idx = draft.attachments.indexOf(item);
  if (idx >= 0) {
    if (item.objUrl) { try { URL.revokeObjectURL(item.objUrl); } catch (e) { /* ignore */ } }
    draft.attachments.splice(idx, 1);
  }
  renderAttachments();
}

function clearDraft() {
  draft.attachments.forEach((a) => { if (a.objUrl) { try { URL.revokeObjectURL(a.objUrl); } catch (e) { /* ignore */ } } });
  draft.attachments = [];
  draft.quote = null;
  $('input').value = '';
  $('email-body').value = '';
  autoGrowInput();
  autoGrowEmail();
  renderAttachments();
  renderQuote();
}

function autoGrowInput() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

function autoGrowEmail() {
  const ta = $('email-body');
  const minH = 180;
  const maxH = Math.max(180, Math.round(window.innerHeight * 0.4));
  ta.style.height = 'auto';
  ta.style.height = Math.min(Math.max(ta.scrollHeight, minH), maxH) + 'px';
}

/* ---------------- 附件上传（/api/upload） ---------------- */
async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!backendOnline) { toast('离线模式暂不支持附件，请连上本地服务后再发'); return; }
  let total = draft.attachments.reduce((s, a) => s + (a.size || 0), 0);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = f.name || ('图片-' + Date.now() + (isImageFile(f) ? '.png' : '.bin'));
    if (f.size > MAX_ATTACH_BYTES) { toast('附件「' + name + '」超过 16MB，已跳过'); continue; }
    if (total + f.size > MAX_TOTAL_ATTACH_BYTES) { toast('附件合计不能超过 24MB，已跳过剩余文件'); break; }
    total += f.size;
    const item = {
      id: null,
      name,
      size: f.size,
      mime: f.type || (isImageMime('', name) ? 'image/*' : 'application/octet-stream'),
      objUrl: URL.createObjectURL(f),
      uploading: true,
    };
    draft.attachments.push(item);
    renderAttachments();
    uploadOne(item, f);
  }
}

async function uploadOne(item, file) {
  let res;
  try {
    res = await fetch('/api/upload?name=' + encodeURIComponent(item.name), {
      method: 'POST',
      headers: { 'Content-Type': item.mime || 'application/octet-stream' },
      body: file,
    });
  } catch (e) {
    backendOnline = false;
    removeDraftAttachment(item);
    updateOfflineBanner();
    toast('离线模式暂不支持附件，请连上本地服务后再发');
    return;
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  backendOnline = true;
  if (!res.ok || !data || !data.ok) {
    removeDraftAttachment(item);
    toast((data && data.error) || ('附件上传失败（HTTP ' + res.status + '）'));
    return;
  }
  item.id = data.id;
  if (data.name) item.name = data.name;
  if (data.size != null) item.size = data.size;
  if (data.mime) item.mime = data.mime;
  item.uploading = false;
  renderAttachments();
}

/* ---------------- AI 状态 ---------------- */
let aiStatusOffline = false;   // /api/ai/status 不可用
let aiStatusError = '';
let aiPollTimer = null;

function aiReady() {
  const a = state.ai;
  return !!(a && a.enabled && a.model_ready);
}

function updateAiUi() {
  const a = state.ai;
  const ready = aiReady();
  const btn = $('btn-ai-title');
  if (btn) btn.style.display = ready ? '' : 'none';
  const hint = $('email-ai-state');
  if (!hint) return;
  if (!backendOnline) { hint.textContent = '本地服务未运行'; hint.className = 'email-ai-state'; return; }
  if (ready) { hint.textContent = 'AI 标题已就绪'; hint.className = 'email-ai-state on'; return; }
  if (a && a.enabled) { hint.textContent = 'AI 模型未就绪，将使用启发式标题'; hint.className = 'email-ai-state'; return; }
  hint.textContent = '';
  hint.className = 'email-ai-state';
}

function renderAiStatusBox() {
  const el = $('ai-status');
  if (!el) return;
  const a = state.ai;
  if (aiStatusOffline) { el.textContent = '本地服务未运行'; el.className = 'ai-status'; return; }
  if (aiStatusError && !a) { el.textContent = 'AI 不可用：' + aiStatusError; el.className = 'ai-status err'; return; }
  if (!a) { el.textContent = '状态未知（接口未返回 AI 状态）'; el.className = 'ai-status'; return; }
  if (a.model_ready) {
    el.textContent = '已就绪' + (a.total_bytes ? '（' + fmtMB(a.total_bytes) + '）' : '');
    el.className = 'ai-status ok';
    return;
  }
  if (a.downloading) {
    const pct = a.percent || 0;
    const sizePart = a.total_bytes
      ? '（' + fmtMB(a.downloaded_bytes) + ' / ' + fmtMB(a.total_bytes) + '）'
      : (a.downloaded_bytes ? '（' + fmtMB(a.downloaded_bytes) + '）' : '');
    el.textContent = '下载中 ' + pct + '%' + sizePart;
    el.className = 'ai-status doing';
    return;
  }
  if (a.error) { el.textContent = '错误：' + a.error; el.className = 'ai-status err'; return; }
  el.textContent = '未下载';
  el.className = 'ai-status';
}

function updateAiButtons() {
  const a = state.ai;
  // 离线时不直接禁用下载/取消：点击后由 aiDownload/aiCancel 给出 toast 提示
  const dl = $('btn-ai-download');
  const cancel = $('btn-ai-cancel');
  dl.disabled = !a || !!a.model_ready || !!a.downloading;
  cancel.disabled = !a || !a.downloading;
}

function stopAiPoll() {
  if (aiPollTimer) { clearInterval(aiPollTimer); aiPollTimer = null; }
}

function startAiPoll() {
  if (aiPollTimer) return;
  aiPollTimer = setInterval(async () => {
    const r = await api('/api/ai/status', 'GET');
    if (r && r.ai) { state.ai = r.ai; aiStatusOffline = false; aiStatusError = ''; }
    else { aiStatusOffline = !!r.offline; aiStatusError = r.error || ''; }
    renderAiStatusBox();
    updateAiButtons();
    updateAiUi();
    if (!state.ai || !state.ai.downloading) stopAiPoll();
  }, 1000);
}

async function loadAiStatusForSettings() {
  aiStatusOffline = false;
  aiStatusError = '';
  if (!backendOnline) {
    aiStatusOffline = true;
    renderAiStatusBox();
    updateAiButtons();
    return;
  }
  const r = await api('/api/ai/status', 'GET');
  if (r && r.ai) { state.ai = r.ai; }
  else { aiStatusOffline = !!r.offline; aiStatusError = r.error || '接口不可用'; }
  renderAiStatusBox();
  updateAiButtons();
  updateAiUi();
  if (state.ai && state.ai.downloading) startAiPoll(); else stopAiPoll();
}

async function aiDownload() {
  if (!backendOnline) { toast('本地服务未运行，无法下载模型'); return; }
  $('btn-ai-download').disabled = true;
  const r = await api('/api/ai/download', 'POST', {});
  if (r && r.ai) { state.ai = r.ai; aiStatusOffline = false; aiStatusError = ''; }
  if (!r || r.offline) {
    aiStatusOffline = true;
    toast('本地服务未运行，无法下载模型');
  } else if (!r.ok) {
    toast(r.error || '下载启动失败');
  } else if (r.already) {
    toast('模型已就绪，无需下载');
  } else {
    toast('已开始下载模型，可关闭设置窗口继续');
  }
  renderAiStatusBox();
  updateAiButtons();
  updateAiUi();
  if (state.ai && state.ai.downloading) startAiPoll();
}

async function aiCancel() {
  const r = await api('/api/ai/cancel', 'POST', {});
  if (r && r.ai) { state.ai = r.ai; aiStatusOffline = false; aiStatusError = ''; }
  if (!r || r.offline) { toast('本地服务未运行'); }
  else if (!r.ok) toast(r.error || '取消失败');
  else toast('已取消下载');
  renderAiStatusBox();
  updateAiButtons();
  updateAiUi();
  if (!state.ai || !state.ai.downloading) stopAiPoll();
}

async function aiGenerateTitle() {
  if (!activePeer || sending) return;
  const btn = $('btn-ai-title');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '生成中…';
  const r = await api('/api/ai/title', 'POST', {
    text: $('email-body').value,
    subject: $('email-subject').value.trim(),
  });
  btn.disabled = false;
  btn.textContent = old;
  if (!r || r.offline) { toast('本地服务未运行，无法生成标题'); return; }
  if (r.ok && r.subject) {
    $('email-subject').value = r.subject;
    if (r.source === 'ai') toast('已生成 AI 标题');
    else toast('AI 不可用，已使用启发式标题' + (r.note ? '：' + r.note : ''));
  } else {
    toast(r.error || '生成标题失败');
  }
}

/* ---------------- 侧边栏 ---------------- */
function renderStatus(poll) {
  const dot = $('status-dot'), txt = $('status-text');
  if (!backendOnline) {
    dot.className = 'dot err';
    txt.textContent = '离线模式 · 本地服务未运行';
    txt.title = '已安装的 PWA 可离线打开：显示缓存消息，发送将排队，服务恢复后自动补发';
    updateOfflineBanner();
    return;
  }
  dot.className = 'dot' + (poll && poll.ok ? ' ok' : poll && (poll.error || state.configured) ? ' err' : '');
  if (!state.configured) { txt.textContent = '未配置账户'; return; }
  if (!poll || !poll.last_ts) { txt.textContent = '等待首次收信…'; return; }
  const t = fmtTime(poll.last_ts);
  if (poll.ok) txt.textContent = `已连接 · 上次 ${t} 收 ${poll.fetched} 条`;
  else txt.textContent = `收信异常 · ${t}（${poll.error || ''}）`;
  if (poll.error) txt.title = poll.error;
}

function renderSidebar() {
  const list = $('friend-list');
  const friends = (state.friends || []).filter((f) => !searchTerm || (f.name + f.email).toLowerCase().includes(searchTerm.toLowerCase()));
  list.innerHTML = friends.map((f) => {
    const name = f.name || f.email;
    // 预览用后端 last_text（已处理 [已撤回] / [图片] / [文件] / 邮件主题）
    const preview = f.last_text || (f.unread ? '' : '还没有消息');
    // 未读红点贴在头像右上角（WeChat 风格）；0 条不显示
    const unread = Number(f.unread) || 0;
    const badge = unread > 0 ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : '';
    return `<div class="friend-item${f.email === activePeer ? ' active' : ''}" data-email="${esc(f.email)}">
      <div class="avatar-wrap">
        <div class="avatar" style="background:${avatarColor(f.email)}">${esc(initialOf(name))}</div>
        ${badge}
      </div>
      <div class="friend-info">
        <div class="friend-name">${esc(name)}</div>
        <div class="friend-preview">${esc(preview)}</div>
      </div>
      <div class="friend-meta">
        <div class="friend-time">${fmtTime(f.last_ts)}</div>
      </div>
    </div>`;
  }).join('');
  $('friend-empty').style.display = friends.length ? 'none' : 'block';
  list.querySelectorAll('.friend-item').forEach((el) => {
    el.addEventListener('click', () => openChat(el.dataset.email));
  });
}

/* ---------------- 聊天区 ---------------- */
async function openChat(email) {
  closeContextMenu();
  if (activePeer !== email) {
    // 切换会话时丢弃上一会话的引用目标（避免引用到别人的消息）
    draft.quote = null;
    renderQuote();
  }
  activePeer = email;
  lastRenderKey = '';
  renderSidebar();
  $('chat-empty').style.display = 'none';
  $('chat-active').style.display = 'flex';
  const f = (state.friends || []).find((x) => x.email === email);
  const name = (f && f.name) || email;
  $('chat-name').textContent = name;
  $('chat-note').textContent = (f && f.note) || email;
  const av = $('chat-avatar');
  av.style.background = avatarColor(email);
  av.textContent = initialOf(name);
  await api('/api/read', 'POST', { with: email });
  await refreshMessages(true);
}

function messageKey(m) {
  return [
    m.id,
    m.recalled ? 'r' : '',
    m.pending ? 'p' : '',
    m.kind || '',
    (m.text || '').length,
    m.subject || '',
    m.quote ? 'q' : '',
    (m.attachments || []).length,
  ].join(':');
}

async function refreshMessages(forceScroll) {
  if (!activePeer) return;
  const data = await api('/api/messages?with=' + encodeURIComponent(activePeer), 'GET');
  let list;
  if (data && data.messages) {
    list = data.messages;
    lsSet(LS_MSGS(activePeer), list);
  } else {
    list = lsGet(LS_MSGS(activePeer), []);
  }
  // 离线排队的消息以“待发送”气泡形式追加显示
  const pending = getOutbox().filter((x) => x.to === activePeer);
  if (pending.length) {
    list = list.concat(pending.map((x, i) => ({
      id: 'pending-' + i, dir: 'out', kind: 'chat', text: x.text, ts: x.ts,
      time: fmtTime(x.ts), quote: x.quote || null, pending: true,
    })));
  }
  const msgs = $('messages');
  const atBottom = !forceScroll && msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
  messagesCache = list;
  const key = list.length + '|' + list.map(messageKey).join(',');
  if (key !== lastRenderKey || forceScroll) {
    lastRenderKey = key;
    renderMessages();
  }
  if (atBottom || forceScroll) {
    msgs.scrollTop = msgs.scrollHeight;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
    }
  }
}

/* ---------------- 消息渲染 ---------------- */
function renderMessages() {
  const msgs = $('messages');
  const peerName = peerDisplayName(activePeer);
  let out = '';
  let lastTs = 0;
  messagesCache.forEach((m, idx) => {
    const ts = m.ts || 0;
    if (!lastTs || ts - lastTs > 30 * 60) {
      out += `<div class="divider">${esc(ts ? fmtTime(ts) : '')}</div>`;
    }
    lastTs = ts || lastTs;
    const mine = m.dir === 'out';
    if (m.recalled) {
      out += `<div class="recall-line">${mine ? '你撤回了一条消息' : '对方撤回了一条消息'}</div>`;
      return;
    }
    out += `<div class="msg ${mine ? 'out' : 'in'}" data-idx="${idx}">
      <div class="avatar" style="background:${avatarColor(mine ? ((state.account && state.account.email) || 'me') : (activePeer || 'peer'))}">${esc(initialOf(mine ? '我' : peerName))}</div>
      <div class="msg-col${m.kind === 'email' ? ' wide' : ''}">
        ${renderMsgActions(m, idx)}
        ${renderBubble(m)}
        <div class="meta">${esc(m.pending ? '待发送 ⏳' : fmtTime(m.ts))}</div>
      </div>
    </div>`;
  });
  if (!messagesCache.length) {
    out = '<div class="divider">添加好友后，对方来信会自动出现在这里</div>';
  }
  msgs.innerHTML = out;
}

function canRecallMessage(m) {
  return !!m && m.dir === 'out' && !m.recalled && !m.pending &&
    !!m.mid && typeof m.id === 'number';
}

function renderMsgActions(m, idx) {
  if (m.pending || m.id == null) return '';
  const quoteBtn = `<button data-act="quote" data-idx="${idx}" title="引用这条消息">引用</button>`;
  const recallBtn = canRecallMessage(m)
    ? `<button data-act="recall" data-idx="${idx}" class="danger" title="撤回这条消息">撤回</button>`
    : '';
  return `<div class="msg-actions">${quoteBtn}${recallBtn}</div>`;
}

function renderBubble(m) {
  const cls = ['bubble'];
  if (m.pending) cls.push('pending');
  let inner = '';
  if (m.quote) inner += renderQuoteCard(m.quote);
  if (m.kind === 'email') {
    cls.push('email-bubble');
    inner += '<div class="email-tag">邮件</div>';
    if (m.subject) inner += `<div class="email-subject">${esc(m.subject)}</div>`;
    inner += '<div class="email-divider"></div>';
    if (m.text) inner += `<div class="email-text">${esc(m.text)}</div>`;
  } else if (m.text) {
    inner += `<span class="bubble-text">${esc(m.text)}</span>`;
  }
  inner += renderMessageAttachments(m.attachments);
  if (!inner) inner = '<span class="bubble-empty">（空消息）</span>';
  return `<div class="${cls.join(' ')}">${inner}</div>`;
}

function renderQuoteCard(q) {
  return `<div class="quote-card"><div class="quote-card-head">引用 ${esc(q.from || '对方')}</div>` +
    `<div class="quote-card-text">${esc(q.text || '')}</div></div>`;
}

function renderMessageAttachments(atts) {
  if (!atts || !atts.length) return '';
  const imgs = atts.filter(isImageAtt);
  const files = atts.filter((a) => !isImageAtt(a));
  let out = '';
  if (imgs.length) {
    out += `<div class="att-grid${imgs.length === 1 ? '' : ' multi'}">` + imgs.map((a) => {
      const url = a.url || '';
      return '<div class="att-thumb"><img class="att-img" src="' + esc(url) + '" alt="' + esc(a.name || '图片') +
        '" data-full="' + esc(url) + '" data-name="' + esc(a.name || '') + '" loading="lazy"></div>';
    }).join('') + '</div>';
  }
  out += files.map((a) => '<a class="file-card" href="' + esc(a.url || '#') + '" download="' + esc(a.name || 'file') +
    '" title="下载 ' + esc(a.name || '') + '"><span class="file-icon">📄</span><span class="file-info">' +
    '<span class="file-name">' + esc(a.name || '附件') + '</span><span class="file-size">' + esc(fmtSize(a.size)) +
    '</span></span><span class="file-dl">下载</span></a>').join('');
  return out;
}

/* ---------------- 引用 / 撤回 / 图片预览 ---------------- */
function quoteMessage(m) {
  if (!activePeer || !m) return;
  const mine = m.dir === 'out';
  let text = (m.text || '').trim();
  if (!text) {
    if (m.kind === 'email' && m.subject) text = m.subject;
    else if (m.attachments && m.attachments.length) {
      text = isImageAtt(m.attachments[0]) ? '[图片]' : '[文件] ' + (m.attachments[0].name || '');
    } else {
      text = '（空消息）';
    }
  }
  draft.quote = {
    text: truncateText(text, 500),
    from: mine ? selfDisplayName() : peerDisplayName(activePeer),
    ts: m.ts || Math.floor(Date.now() / 1000),
    mid: m.mid || '',
  };
  renderQuote();
  toast('已引用，发送时附带');
  focusComposer();
}

async function recallMessage(m) {
  if (!activePeer || !m || m.dir !== 'out' || !m.mid) return;
  if (!confirm('撤回后将向对方客户端发送撤回通知。\n若对方已读，或使用其它邮箱客户端，无法保证内容被删除。\n\n确定撤回这条消息吗？')) return;
  const r = await api('/api/recall', 'POST', { with: activePeer, id: m.id });
  if (r && r.ok) {
    toast('已撤回');
    await refreshMessages(true);
    await loadState(false);
  } else {
    toast((r && r.error) || '撤回失败');
  }
}

function openLightbox(src, name) {
  if (!src) return;
  const box = $('lightbox');
  const img = $('lightbox-img');
  img.src = src;
  img.alt = name || '图片预览';
  box.style.display = 'flex';
}
function closeLightbox() {
  const box = $('lightbox');
  box.style.display = 'none';
  $('lightbox-img').src = '';
}

/* ---------------- 右键菜单（消息 / 好友） ---------------- */
let ctxMenuItems = [];

function isContextMenuOpen() {
  const menu = $('ctx-menu');
  return !!menu && menu.style.display !== 'none';
}

function closeContextMenu() {
  const menu = $('ctx-menu');
  if (!menu) return;
  if (menu.style.display === 'none') { ctxMenuItems = []; return; }
  menu.style.display = 'none';
  menu.innerHTML = '';
  ctxMenuItems = [];
}

function showContextMenu(x, y, items) {
  const menu = $('ctx-menu');
  if (!menu || !items || !items.length) return;
  ctxMenuItems = items;
  menu.innerHTML = items.map((it, i) => (it && it.sep)
    ? '<div class="ctx-sep"></div>'
    : `<button type="button" role="menuitem" class="ctx-item${it && it.danger ? ' danger' : ''}" data-ctx="${i}">${esc((it && it.label) || '')}</button>`
  ).join('');
  // 先放到屏幕外测量尺寸，再夹到视口内（菜单不出视口）
  menu.style.display = 'block';
  menu.style.left = '-9999px';
  menu.style.top = '-9999px';
  const rect = menu.getBoundingClientRect();
  const pad = 8;
  let left = x;
  let top = y;
  if (left + rect.width + pad > window.innerWidth) left = window.innerWidth - rect.width - pad;
  if (top + rect.height + pad > window.innerHeight) top = window.innerHeight - rect.height - pad;
  menu.style.left = Math.max(pad, Math.round(left)) + 'px';
  menu.style.top = Math.max(pad, Math.round(top)) + 'px';
}

function onCtxMenuClick(e) {
  const t = e.target;
  const btn = t && t.closest ? t.closest('[data-ctx]') : null;
  if (!btn) return;
  const idx = parseInt(btn.getAttribute('data-ctx'), 10);
  const item = ctxMenuItems[idx];
  closeContextMenu();
  if (item && typeof item.onSelect === 'function') item.onSelect();
}

function copyTextToClipboard(text) {
  const fallback = () => {
    // 兼容不支持 Clipboard API 的环境（旧 WebView / 非安全上下文 / 页面未聚焦）
    let ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      toast(ok ? '已复制' : '复制失败，请手动选择文字');
    } catch (err) {
      toast('复制失败，请手动选择文字');
    } finally {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => fallback());
    return;
  }
  fallback();
}

function copyMessageText(m) {
  const text = String((m && m.text) || '');
  if (!text.trim()) { toast('该消息没有可复制的文字'); return; }
  copyTextToClipboard(text);
}

function onMessagesContextMenu(e) {
  const t = e.target;
  const msgEl = t && t.closest ? t.closest('#messages .msg') : null;
  if (!msgEl) return;
  e.preventDefault();
  closeContextMenu();
  const idx = parseInt(msgEl.getAttribute('data-idx'), 10);
  const m = messagesCache[idx];
  if (!m) return;
  const items = [{ label: '复制文字', onSelect: () => copyMessageText(m) }];
  if (!m.pending) items.push({ label: '引用', onSelect: () => quoteMessage(m) });
  if (canRecallMessage(m)) items.push({ label: '撤回', danger: true, onSelect: () => recallMessage(m) });
  showContextMenu(e.clientX, e.clientY, items);
}

function onFriendListContextMenu(e) {
  const t = e.target;
  const item = t && t.closest ? t.closest('.friend-item') : null;
  if (!item) return;
  e.preventDefault();
  closeContextMenu();
  const email = item.getAttribute('data-email');
  if (!email) return;
  showContextMenu(e.clientX, e.clientY, [
    { label: '删除好友', danger: true, onSelect: () => removeFriendByEmail(email) },
  ]);
}

/* ---------------- 输入框：收起态 / 邮件模式 ---------------- */
function focusComposer() {
  if (ui.emailMode) $('email-body').focus();
  else $('input').focus();
}

function expandToEmail() {
  if (ui.emailMode || sending) return;
  $('email-body').value = $('input').value;
  ui.emailMode = true;
  $('composer').style.display = 'none';
  $('email-panel').style.display = 'flex';
  renderAttachments();
  renderQuote();
  updateAiUi();
  autoGrowEmail();
  const ta = $('email-body');
  ta.focus();
  ta.selectionStart = ta.selectionEnd = ta.value.length;
}

function collapseEmail() {
  if (!ui.emailMode) return;
  $('input').value = $('email-body').value;
  ui.emailMode = false;
  $('email-panel').style.display = 'none';
  $('composer').style.display = 'flex';
  autoGrowInput();
  renderAttachments();
  renderQuote();
  updateToolbar();
  $('input').focus();
}

function insertTab(ta) {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  if (typeof ta.setRangeText === 'function') {
    ta.setRangeText('\t', start, end, 'end');
  } else {
    ta.value = ta.value.slice(0, start) + '\t' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + 1;
  }
}

/* 粘贴/拖拽图片与文件 */
function filesFromClipboard(e) {
  const out = [];
  const cd = e.clipboardData;
  if (!cd) return out;
  if (cd.files && cd.files.length) {
    for (let i = 0; i < cd.files.length; i++) out.push(cd.files[i]);
    return out;
  }
  if (cd.items && cd.items.length) {
    for (let i = 0; i < cd.items.length; i++) {
      const it = cd.items[i];
      if (it.kind === 'file') {
        const f = it.getAsFile && it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

function onPasteFiles(e) {
  const files = filesFromClipboard(e);
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
}

function bindDropZone(el) {
  if (!el) return;
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('dragover');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('dragover');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
}

/* ---------------- 发送：小输入框（kind=chat，旧算法） ---------------- */
async function sendMessage() {
  if (!activePeer || sending) return;
  const input = $('input');
  const text = input.value.trim();
  const atts = draft.attachments;
  if (!text && !atts.length) return;
  if (hasUploadingAttachment()) { toast('附件上传中，请稍候'); return; }
  if (state && state.configured === false) { toast('请先配置邮箱账户'); openSettings(); return; }

  let bodyText = text;
  if (bodyText.length > 4000) { bodyText = bodyText.slice(0, 4000); toast('消息超过 4000 字符，已截断'); }

  const payload = { to: activePeer, text: bodyText, kind: 'chat' };
  if (draft.quote) payload.quote = draft.quote;
  if (atts.length) payload.attachments = atts.map((a) => ({ id: a.id, name: a.name }));

  const useAi = aiReady();
  setSending(true, useAi ? '生成标题中…' : '发送中…');
  if (useAi) toast('正在生成邮件标题并发送，请稍候…');
  const r = await api('/api/send', 'POST', payload);
  setSending(false);

  if (r && r.ok) {
    clearDraft();
    await refreshMessages(true);
    await loadState(true);
    if (r.ai && r.subject) toast('已发送 · AI 主题：' + r.subject);
    return;
  }
  if (r && r.offline) {
    if (atts.length) { toast('离线模式暂不支持附件，请连上本地服务后再发'); return; }
    const q = getOutbox();
    q.push({ to: activePeer, text: bodyText, ts: Math.floor(Date.now() / 1000), tries: 0, quote: draft.quote || undefined });
    setOutbox(q);
    clearDraft();
    toast('离线模式：消息已排队，服务恢复后自动发送');
    await refreshMessages(true);
    return;
  }
  toast((r && r.error) || '发送失败');
}

/* ---------------- 发送：邮件模式（kind=email） ---------------- */
async function sendEmail() {
  if (!activePeer || sending) return;
  const body = $('email-body').value.trim();
  const subject = $('email-subject').value.trim();
  const cc = $('email-cc').value.trim();
  const bcc = $('email-bcc').value.trim();
  if (!body && !draft.attachments.length) { toast('正文和附件不能同时为空'); $('email-body').focus(); return; }
  if (hasUploadingAttachment()) { toast('附件上传中，请稍候'); return; }
  if (state && state.configured === false) { toast('请先配置邮箱账户'); openSettings(); return; }

  let bodyText = body;
  if (bodyText.length > 16000) { bodyText = bodyText.slice(0, 16000); toast('邮件正文超过 16000 字符，已截断'); }

  const payload = { to: activePeer, text: bodyText, kind: 'email' };
  if (subject) payload.subject = subject;
  if (cc) payload.cc = cc;
  if (bcc) payload.bcc = bcc;
  if (draft.quote) payload.quote = draft.quote;
  if (draft.attachments.length) payload.attachments = draft.attachments.map((a) => ({ id: a.id, name: a.name }));

  const useAi = aiReady() && !subject;
  setSending(true, useAi ? '生成标题中…' : '发送中…');
  const r = await api('/api/send', 'POST', payload);
  setSending(false);

  if (r && r.ok) {
    clearDraft();
    $('email-subject').value = '';
    $('email-cc').value = '';
    $('email-bcc').value = '';
    collapseEmail();
    toast(r.ai && r.subject ? '邮件已发送 · AI 主题：' + r.subject : '邮件已发送');
    await refreshMessages(true);
    await loadState(true);
    return;
  }
  if (r && r.offline) { toast('本地服务未运行，邮件模式暂不支持离线发送'); return; }
  toast((r && r.error) || '发送失败');
}

/* 服务恢复后自动补发离线队列 */
// 互斥标志：loadState 每 3s 调用一次本函数，而单次补发可能超过 3s
//（SMTP 慢 / AI 生成标题），若不加锁，第二次调用会用同一份队列快照再发一遍。
let flushing = false;

// 离线队列项没有 id，用 (to, text, ts) 定位；补发期间新入队的项追加在尾部，不会被误删。
function outboxIndexOf(items, item) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && it.to === item.to && it.text === item.text && it.ts === item.ts) return i;
  }
  return -1;
}

function removeOutboxItem(item) {
  const q = getOutbox();
  const idx = outboxIndexOf(q, item);
  if (idx < 0) return;
  q.splice(idx, 1);
  setOutbox(q);
}

function markOutboxRetry(item, tries) {
  const q = getOutbox();
  const idx = outboxIndexOf(q, item);
  if (idx < 0) return;
  q[idx] = Object.assign({}, q[idx], { tries });
  setOutbox(q);
}

async function flushOutbox() {
  if (flushing) return;              // 已在补发中：直接返回，避免并发重复发送
  const snapshot = getOutbox();
  if (!snapshot.length) return;
  flushing = true;
  let sent = 0;
  try {
    for (let i = 0; i < snapshot.length; i++) {
      const item = snapshot[i];
      const payload = { to: item.to, text: item.text, kind: 'chat' };
      if (item.quote) payload.quote = item.quote;
      const r = await api('/api/send', 'POST', payload);
      if (r && r.ok) {
        // 成功项立即出队：本轮再慢，后续 flush 也拿不到它，不会重复发送
        sent++;
        removeOutboxItem(item);
        continue;
      }
      if (r && r.offline) break;     // 后端不可用：本轮停止，队列原样保留
      const tries = (item.tries || 0) + 1;
      if (tries < 5) {
        markOutboxRetry(item, tries);
      } else {
        removeOutboxItem(item);
        toast('有一条离线消息多次发送失败，已丢弃：' + ((r && r.error) || ''));
      }
    }
    if (sent > 0) {
      toast(`已自动补发 ${sent} 条离线消息`);
      await refreshMessages(false);
      // 此时 flushing 仍为 true，loadState 里的 flushOutbox 会直接返回，不会重复补发
      await loadState(false);
    }
  } finally {
    flushing = false;
  }
}

/* ---------------- 设置 ---------------- */
function openSettings() {
  const modal = $('modal-settings');
  if (modal.style.display === 'flex') {
    // 已打开，不覆盖用户正在编辑的内容
    if (state.ai && state.ai.downloading) startAiPoll();
    return;
  }
  modal.style.display = 'flex';
  const a = state.account || {};
  $('cfg-mode').value = (a.mode === 'pop3') ? 'pop3' : 'imap';
  $('cfg-email').value = a.email || '';
  $('cfg-name').value = a.display_name || '';
  $('cfg-pass').value = a.password || '';
  $('cfg-imap-host').value = (a.imap && a.imap.host) || '';
  $('cfg-imap-port').value = (a.imap && a.imap.port) || 993;
  $('cfg-imap-ssl').checked = !a.imap || a.imap.ssl !== false;
  $('cfg-pop3-host').value = (a.pop3 && a.pop3.host) || '';
  $('cfg-pop3-port').value = (a.pop3 && a.pop3.port) || 995;
  $('cfg-pop3-ssl').checked = !a.pop3 || a.pop3.ssl !== false;
  $('cfg-smtp-host').value = (a.smtp && a.smtp.host) || '';
  $('cfg-smtp-port').value = (a.smtp && a.smtp.port) || 465;
  $('cfg-smtp-ssl').checked = !a.smtp || a.smtp.ssl !== false;
  $('cfg-interval').value = a.poll_interval || 8;
  $('cfg-auto').checked = a.auto_poll !== false;  // 回填自动收信开关
  const aiCfg = a.ai || {};
  $('cfg-ai-enabled').checked = !!aiCfg.enabled;
  $('cfg-ai-mirror').value = aiCfg.mirror || 'https://hf-mirror.com';
  $('cfg-ai-model-url').value = aiCfg.model_url || '';
  $('test-result').textContent = '';
  $('test-result').className = 'test-result';
  loadAiStatusForSettings();
}
function closeSettings() {
  $('modal-settings').style.display = 'none';
  stopAiPoll();
}

async function saveSettings() {
  const email = $('cfg-email').value.trim();
  if (email && email.indexOf('@') < 0) { toast('邮箱格式不正确'); return; }
  if (!email) { toast('请填写邮箱地址'); return; }
  const aiEnabled = $('cfg-ai-enabled').checked;
  const body = {
    email,
    display_name: $('cfg-name').value.trim(),
    password: $('cfg-pass').value,
    mode: $('cfg-mode').value,
    poll_interval: parseInt($('cfg-interval').value, 10) || 8,
    auto_poll: $('cfg-auto').checked,
    imap: { host: $('cfg-imap-host').value.trim(), port: parseInt($('cfg-imap-port').value, 10) || 993, ssl: $('cfg-imap-ssl').checked },
    pop3: { host: $('cfg-pop3-host').value.trim(), port: parseInt($('cfg-pop3-port').value, 10) || 995, ssl: $('cfg-pop3-ssl').checked },
    smtp: { host: $('cfg-smtp-host').value.trim(), port: parseInt($('cfg-smtp-port').value, 10) || 465, ssl: $('cfg-smtp-ssl').checked },
    ai: {
      enabled: aiEnabled,
      mirror: $('cfg-ai-mirror').value.trim(),
      model_url: $('cfg-ai-model-url').value.trim(),
    },
  };
  const r = await api('/api/config', 'POST', body);
  if (r && r.ok) {
    const ready = !!(state.ai && state.ai.model_ready);
    if (aiEnabled && !ready) toast('设置已保存；AI 模型尚未下载，请先点「下载模型」');
    else toast('设置已保存');
    closeSettings();
    await loadState(true);
  } else {
    toast((r && r.error) || '保存失败');
  }
}

async function testConnection() {
  const el = $('test-result');
  el.textContent = '正在测试（若失败会自动探测可用的备用服务器，最多约 8 秒）…';
  el.className = 'test-result';
  const r = await api('/api/test', 'POST', {});
  if (!r || r.offline) { el.textContent = '测试失败：无法访问本地服务'; el.className = 'test-result err'; return; }
  const sOk = r.smtp && r.smtp.ok ? 'SMTP 发送：成功' : 'SMTP 发送：失败 - ' + ((r.smtp && r.smtp.error) || '');
  const rOk = r.recv && r.recv.ok ? '收件：成功' : '收件：失败 - ' + ((r.recv && r.recv.error) || '');
  let text = sOk + '\n' + rOk;
  if (Array.isArray(r.hints) && r.hints.length) {
    const good = r.hints.filter((h) => h.ok);
    if (good.length) {
      text += '\n\n可用服务器（点「自动检测服务器」可自动填入）：\n' +
        good.map((h) => `  ✓ ${h.kind.toUpperCase()} ${h.host}:${h.port}${h.ssl ? ' SSL' : ''}`).join('\n');
    } else {
      text += '\n\n自动检测：候选服务器全部连不上 —— 端口可能被网络/校园网封锁，或管理员未开启 IMAP/SMTP。换手机热点再试可区分。';
    }
  }
  el.textContent = text;
  el.className = 'test-result ' + (r.ok ? 'ok' : 'err');
}

/* 自动检测服务器：并发探测常见主机/端口，把能连通的自动填进表单 */
async function probeServers() {
  const el = $('probe-result');
  const email = $('cfg-email').value.trim();
  if (email.indexOf('@') < 0) { toast('请先填写你的邮箱地址（用于推断服务器）'); return; }
  el.textContent = '正在并发检测常见服务器，最多约 6 秒…';
  el.className = 'test-result';
  const r = await api('/api/probe', 'POST', { email });
  if (!r.results) {
    el.textContent = r.error || '检测失败：本地服务不可用';
    el.className = 'test-result err';
    return;
  }
  const best = {};
  const lines = r.results.map((it) => {
    const tag = it.ok ? '✓' : '✗';
    const line = `${tag} ${it.kind.toUpperCase()} ${it.host}:${it.port}${it.ssl ? ' SSL' : ''}` +
                 (it.ok ? `（${it.elapsed_ms}ms）` : ` — ${it.error || ''}`);
    if (it.ok && !best[it.kind]) best[it.kind] = it;
    return line;
  });
  el.textContent = lines.join('\n');
  const okAny = Object.keys(best).length > 0;
  el.className = 'test-result ' + (okAny ? 'ok' : 'err');
  const fill = (kind, hostId, portId, sslId) => {
    if (!best[kind]) return;
    $(hostId).value = best[kind].host;
    $(portId).value = best[kind].port;
    $(sslId).checked = !!best[kind].ssl;
  };
  fill('imap', 'cfg-imap-host', 'cfg-imap-port', 'cfg-imap-ssl');
  fill('pop3', 'cfg-pop3-host', 'cfg-pop3-port', 'cfg-pop3-ssl');
  fill('smtp', 'cfg-smtp-host', 'cfg-smtp-port', 'cfg-smtp-ssl');
  toast(okAny ? '已把检测到的可用服务器填入表单，记得点「保存」' : '没有检测到可用服务器，请看下方明细');
}

/* ---------------- 好友 ---------------- */
function openFriendModal() {
  $('fr-email').value = '';
  $('fr-name').value = '';
  $('fr-note').value = '';
  $('modal-friend').style.display = 'flex';
  $('fr-email').focus();
}
function closeFriendModal() { $('modal-friend').style.display = 'none'; }

async function addFriend() {
  const email = $('fr-email').value.trim();
  if (!email || email.indexOf('@') < 0) { toast('请输入正确的邮箱地址'); return; }
  const r = await api('/api/friends', 'POST', { action: 'add', email, name: $('fr-name').value.trim(), note: $('fr-note').value.trim() });
  if (r && r.ok) {
    toast('已添加好友：' + email);
    closeFriendModal();
    await loadState(true);
  } else {
    toast((r && r.error) || '添加失败');
  }
}

/* 删除好友（聊天头部 ✕ 与好友右键菜单共用）：
   仅清除本地聊天记录/白名单，不删除、不移动邮箱里的邮件，也不改邮箱已读状态 */
async function removeFriendByEmail(email) {
  if (!email) return;
  if (!confirm('确定删除好友 ' + email + ' 吗？\n邮箱里的邮件不会被删除，聊天记录会清除。')) return;
  const r = await api('/api/friends', 'POST', { action: 'remove', email });
  if (r && r.ok) {
    toast('已删除好友：' + email);
    if (activePeer === email) {
      activePeer = null;
      messagesCache = [];
      lastRenderKey = '';
      $('messages').innerHTML = '';
      $('chat-active').style.display = 'none';
      $('chat-empty').style.display = 'flex';
    }
    await loadState(true);
  } else {
    toast((r && r.error) || '删除失败');
  }
}

async function removeFriend() {
  if (!activePeer) return;
  await removeFriendByEmail(activePeer);
}

/* ---------------- 主循环 ---------------- */
async function loadState(showSettingsIfMissing) {
  const s = await api('/api/state', 'GET');
  if (!s || s.offline) {
    // 离线精简模式：用本地缓存渲染，不弹设置框
    const cached = lsGet(LS_STATE, null);
    if (cached) state = cached;
    backendOnline = false;
    renderSidebar();
    renderStatus(null);
    updateOfflineBanner();
    updateAiUi();
    if (activePeer) await refreshMessages(false);
    return;
  }
  backendOnline = true;
  aiStatusOffline = false;
  await flushOutbox();
  if (s.friends) {
    const wasConfigured = state.configured;
    state = s;
    lsSet(LS_STATE, s);
    renderSidebar();
    renderStatus(s.poll);
    updateOfflineBanner();
    updateAiUi();
    if (activePeer) {
      const still = s.friends.some((f) => f.email === activePeer);
      if (!still) { activePeer = null; $('chat-active').style.display = 'none'; $('chat-empty').style.display = 'flex'; }
      else await refreshMessages(false);
    }
    if (showSettingsIfMissing && !s.configured) openSettings();
    else if (s.configured && wasConfigured === false) closeSettings();
  }
}

/* ---------------- 事件绑定 ---------------- */
function onMessagesClick(e) {
  const target = e.target;
  if (!target || !target.closest) return;
  const act = target.closest('[data-act]');
  if (act) {
    const idx = parseInt(act.getAttribute('data-idx'), 10);
    const m = messagesCache[idx];
    if (!m) return;
    const kind = act.getAttribute('data-act');
    if (kind === 'quote') quoteMessage(m);
    else if (kind === 'recall') recallMessage(m);
    return;
  }
  const img = target.closest('img.att-img');
  if (img) openLightbox(img.getAttribute('data-full') || img.getAttribute('src'), img.getAttribute('data-name') || '');
}

function onChatActiveClick(e) {
  const t = e.target;
  if (!t || !t.closest) return;
  const delAtt = t.closest('[data-att-del]');
  if (delAtt) {
    const idx = parseInt(delAtt.getAttribute('data-att-del'), 10);
    const item = draft.attachments[idx];
    if (item) removeDraftAttachment(item);
    return;
  }
  if (t.closest('[data-quote-clear]')) {
    draft.quote = null;
    renderQuote();
  }
}

function bindEvents() {
  $('btn-friend').addEventListener('click', openFriendModal);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('btn-close-friend').addEventListener('click', closeFriendModal);
  $('btn-save').addEventListener('click', saveSettings);
  $('btn-test').addEventListener('click', testConnection);
  $('btn-probe').addEventListener('click', probeServers);
  $('btn-fr-save').addEventListener('click', addFriend);
  $('btn-send').addEventListener('click', sendMessage);
  $('btn-email-send').addEventListener('click', sendEmail);
  $('btn-remove').addEventListener('click', removeFriend);
  $('btn-expand').addEventListener('click', expandToEmail);
  $('btn-collapse-email').addEventListener('click', collapseEmail);
  $('btn-attach').addEventListener('click', () => $('file-input').click());
  $('btn-email-attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  $('btn-ai-title').addEventListener('click', aiGenerateTitle);
  $('btn-ai-download').addEventListener('click', aiDownload);
  $('btn-ai-cancel').addEventListener('click', aiCancel);
  $('btn-poll').addEventListener('click', async () => {
    await api('/api/poll', 'POST', {});
    await loadState(false);
  });
  $('search-input').addEventListener('input', (e) => { searchTerm = e.target.value.trim(); renderSidebar(); });
  $('messages').addEventListener('click', onMessagesClick);
  $('chat-active').addEventListener('click', onChatActiveClick);

  // 右键菜单：消息气泡（in/out）与好友列表项
  $('messages').addEventListener('contextmenu', onMessagesContextMenu);
  $('friend-list').addEventListener('contextmenu', onFriendListContextMenu);
  $('ctx-menu').addEventListener('click', onCtxMenuClick);
  // 点击菜单外部关闭（捕获阶段，保证先于其它点击处理）
  document.addEventListener('mousedown', (e) => {
    if (!isContextMenuOpen()) return;
    const t = e.target;
    if (t && t.closest && t.closest('#ctx-menu')) return;
    closeContextMenu();
  }, true);
  // 页面/消息列表滚动、窗口尺寸变化时关闭，避免菜单悬空
  document.addEventListener('scroll', () => { if (isContextMenuOpen()) closeContextMenu(); }, true);
  window.addEventListener('resize', () => closeContextMenu());

  const input = $('input');
  input.addEventListener('keydown', (e) => {
    // 旧算法保持不变：Enter 发送、Shift+Enter 换行（输入法组合中不发送）
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', autoGrowInput);
  input.addEventListener('paste', onPasteFiles);

  const emailBody = $('email-body');
  emailBody.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      insertTab(emailBody);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendEmail();
    }
  });
  emailBody.addEventListener('input', autoGrowEmail);
  emailBody.addEventListener('paste', onPasteFiles);

  bindDropZone($('composer'));
  bindDropZone($('email-panel'));

  // 图片加载失败时显示占位（离线缓存时常见）
  $('messages').addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.classList.contains('att-img')) {
      if (t.parentElement) t.parentElement.classList.add('broken');
      t.style.display = 'none';
    }
  }, true);

  // 图片加载完成后，如果原本就在底部则继续贴底（避免图片撑高后看不到最新消息）
  $('messages').addEventListener('load', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.classList.contains('att-img')) {
      const msgs = $('messages');
      if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 400) msgs.scrollTop = msgs.scrollHeight;
    }
  }, true);

  $('lightbox').addEventListener('click', () => closeLightbox());

  document.querySelectorAll('.modal-backdrop').forEach((bd) => {
    bd.addEventListener('mousedown', (e) => {
      if (e.target !== bd) return;
      if (bd.id === 'modal-settings') closeSettings();
      else bd.style.display = 'none';
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isContextMenuOpen()) { closeContextMenu(); return; }
    if ($('lightbox').style.display !== 'none') { closeLightbox(); return; }
    if ($('modal-settings').style.display === 'flex') { closeSettings(); return; }
    if ($('modal-friend').style.display === 'flex') { closeFriendModal(); return; }
    if (ui.emailMode) collapseEmail();
  });

  // 阻止把文件拖到窗口其它地方时浏览器直接打开文件
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => { e.preventDefault(); });
}

function registerSW() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

bindEvents();
updateToolbar();
updateAiUi();
registerSW();
loadState(true);
setInterval(() => loadState(false), 3000);
