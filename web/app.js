'use strict';
/* Email Chatter - WeChat-like email IM client UI */

const $ = (id) => document.getElementById(id);

let state = { friends: [], configured: false, account: {} };
let activePeer = null;
let messagesCache = [];
let searchTerm = '';
let backendOnline = true;

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

async function api(path, method, body) {
  try {
    const opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const data = await res.json();
    backendOnline = true;
    return data;
  } catch (e) {
    backendOnline = false;
    return { ok: false, offline: true, error: '本地服务未运行：离线模式（仅缓存与排队）' };
  }
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
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
  const friends = state.friends.filter((f) => !searchTerm || (f.name + f.email).toLowerCase().includes(searchTerm.toLowerCase()));
  list.innerHTML = friends.map((f) => {
    const name = f.name || f.email;
    const last = f.last_text || (f.unread ? '' : '还没有消息');
    const preview = f.last_text ? esc(last) : esc(last);
    const badge = f.unread > 0 ? `<span class="badge">${f.unread > 99 ? '99+' : f.unread}</span>` : '';
    return `<div class="friend-item${f.email === activePeer ? ' active' : ''}" data-email="${esc(f.email)}">
      <div class="avatar" style="background:${avatarColor(f.email)}">${esc(initialOf(name))}</div>
      <div class="friend-info">
        <div class="friend-name">${esc(name)}</div>
        <div class="friend-preview">${preview}</div>
      </div>
      <div class="friend-meta">
        <div class="friend-time">${fmtTime(f.last_ts)}</div>${badge}
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
  activePeer = email;
  renderSidebar();
  $('chat-empty').style.display = 'none';
  $('chat-active').style.display = 'flex';
  const f = state.friends.find((x) => x.email === email);
  const name = (f && f.name) || email;
  $('chat-name').textContent = name;
  $('chat-note').textContent = (f && f.note) || email;
  const av = $('chat-avatar');
  av.style.background = avatarColor(email);
  av.textContent = initialOf(name);
  $('chat-empty').style.display = 'none';
  await api('/api/read', 'POST', { with: email });
  await refreshMessages(true);
}

async function refreshMessages(forceScroll) {
  if (!activePeer) return;
  const data = await api('/api/messages?with=' + encodeURIComponent(activePeer), 'GET');
  let list;
  if (data.messages) {
    list = data.messages;
    lsSet(LS_MSGS(activePeer), list);
  } else {
    list = lsGet(LS_MSGS(activePeer), []);
  }
  // 离线排队的消息以“待发送”气泡形式追加显示
  const pending = getOutbox().filter((x) => x.to === activePeer);
  if (pending.length) {
    list = list.concat(pending.map((x, i) => ({ id: 'pending-' + i, dir: 'out', text: x.text, ts: x.ts, time: fmtTime(x.ts), pending: true })));
  }
  const prevLen = messagesCache.length;
  const msgs = $('messages');
  const atBottom = !forceScroll && msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
  messagesCache = list;
  if (prevLen !== messagesCache.length || forceScroll) renderMessages();
  if (atBottom || forceScroll) msgs.scrollTop = msgs.scrollHeight;
}

function renderMessages() {
  const msgs = $('messages');
  const name = activePeer;
  let out = '';
  let lastTs = 0;
  messagesCache.forEach((m) => {
    if (!lastTs || m.ts - lastTs > 30 * 60) {
      const d = m.ts ? fmtTime(m.ts) : '';
      out += `<div class="divider">${esc(d)}</div>`;
    }
    lastTs = m.ts;
    const mine = m.dir === 'out';
    out += `<div class="msg ${mine ? 'out' : 'in'}">
      <div class="avatar" style="background:${avatarColor(mine ? state.self || 'me' : name)}">${esc(initialOf(mine ? '我' : name))}</div>
      <div>
        <div class="bubble${m.pending ? ' pending' : ''}">${esc(m.text)}</div>
        <div class="meta">${esc(m.pending ? '待发送 ⏳' : fmtTime(m.ts))}</div>
      </div>
    </div>`;
  });
  if (!messagesCache.length) {
    out = '<div class="divider">添加好友后，对方来信会自动出现在这里</div>';
  }
  msgs.innerHTML = out;
}

/* ---------------- 发送 ---------------- */
async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!activePeer || !text) return;
  if (state && !state.configured) { toast('请先配置邮箱账户'); openSettings(); return; }
  const btn = $('btn-send');
  btn.disabled = true;
  const r = await api('/api/send', 'POST', { to: activePeer, text });
  btn.disabled = false;
  if (r.ok) {
    input.value = '';
    input.style.height = 'auto';
    await refreshMessages(true);
    await loadState(true);
    return;
  }
  if (r.offline) {
    const q = getOutbox();
    q.push({ to: activePeer, text, ts: Math.floor(Date.now() / 1000), tries: 0 });
    setOutbox(q);
    input.value = '';
    input.style.height = 'auto';
    toast('离线模式：消息已排队，服务恢复后自动发送');
    await refreshMessages(true);
    return;
  }
  toast(r.error || '发送失败');
}

/* 服务恢复后自动补发离线队列 */
async function flushOutbox() {
  const q = getOutbox();
  if (!q.length) return;
  const rest = [];
  let sent = 0;
  let offline = false;
  for (let i = 0; i < q.length; i++) {
    const item = q[i];
    if (offline) { rest.push(item); continue; }
    const r = await api('/api/send', 'POST', { to: item.to, text: item.text });
    if (r.ok) { sent++; continue; }
    if (r.offline) { offline = true; rest.push(item); continue; }
    const tries = (item.tries || 0) + 1;
    if (tries < 5) rest.push(Object.assign({}, item, { tries }));
    else toast('有一条离线消息多次发送失败，已丢弃：' + (r.error || ''));
  }
  setOutbox(rest);
  if (sent > 0) {
    toast(`已自动补发 ${sent} 条离线消息`);
    await refreshMessages(false);
    await loadState(false);
  }
}

/* ---------------- 设置 ---------------- */
function openSettings() {
  $('modal-settings').style.display = 'flex';
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
  $('test-result').textContent = '';
  $('test-result').className = 'test-result';
}
function closeSettings() { $('modal-settings').style.display = 'none'; }

async function saveSettings() {
  const email = $('cfg-email').value.trim();
  if (email && email.indexOf('@') < 0) { toast('邮箱格式不正确'); return; }
  if (!email) { toast('请填写邮箱地址'); return; }
  const body = {
    email,
    display_name: $('cfg-name').value.trim(),
    password: $('cfg-pass').value,
    mode: $('cfg-mode').value,
    poll_interval: parseInt($('cfg-interval').value, 10) || 8,
    auto_poll: $('cfg-auto').checked,
    imap: { host: $('cfg-imap-host').value.trim(), port: parseInt($('cfg-imap-port').value, 10) || 993, ssl: $('cfg-imap-ssl').checked },
    pop3: { host: $('cfg-pop3-host').value.trim(), port: parseInt($('cfg-pop3-port').value, 10) || 995, ssl: $('cfg-pop3-ssl').checked },
    smtp: { host: $('cfg-smtp-host').value.trim(), port: parseInt($('cfg-smtp-port').value, 10) || 465, ssl: $('cfg-smtp-ssl').checked }
  };
  const r = await api('/api/config', 'POST', body);
  if (r.ok) {
    toast('设置已保存');
    closeSettings();
    await loadState(true);
  } else {
    toast(r.error || '保存失败');
  }
}

async function testConnection() {
  const el = $('test-result');
  el.textContent = '正在测试（若失败会自动探测可用的备用服务器，最多约 8 秒）…';
  el.className = 'test-result';
  const r = await api('/api/test', 'POST', {});
  if (r.ok === undefined) { el.textContent = '测试失败：无法访问本地服务'; el.className = 'test-result err'; return; }
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
  if (r.ok) {
    toast('已添加好友：' + email);
    closeFriendModal();
    await loadState(true);
  } else {
    toast(r.error || '添加失败');
  }
}

async function removeFriend() {
  if (!activePeer) return;
  if (!confirm('确定将 ' + activePeer + ' 从好友白名单中删除吗？\n（对方发来的邮件将不再显示）')) return;
  const r = await api('/api/friends', 'POST', { action: 'remove', email: activePeer });
  if (r.ok) {
    activePeer = null;
    $('chat-active').style.display = 'none';
    $('chat-empty').style.display = 'flex';
    await loadState(true);
  } else {
    toast(r.error || '删除失败');
  }
}

/* ---------------- 主循环 ---------------- */
async function loadState(showSettingsIfMissing) {
  const s = await api('/api/state', 'GET');
  if (s.offline) {
    // 离线精简模式：用本地缓存渲染，不弹设置框
    const cached = lsGet(LS_STATE, null);
    if (cached) state = cached;
    renderSidebar();
    renderStatus(null);
    updateOfflineBanner();
    if (activePeer) await refreshMessages(false);
    return;
  }
  backendOnline = true;
  await flushOutbox();
  if (s.friends) {
    const wasConfigured = state.configured;
    state = s;
    lsSet(LS_STATE, s);
    renderSidebar();
    renderStatus(s.poll);
    updateOfflineBanner();
    if (activePeer) {
      const still = s.friends.some((f) => f.email === activePeer);
      if (!still) { activePeer = null; $('chat-active').style.display = 'none'; $('chat-empty').style.display = 'flex'; }
      else await refreshMessages(false);
    }
    if (showSettingsIfMissing && !s.configured) openSettings();
    else if (s.configured && wasConfigured === false) closeSettings();
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
  $('btn-remove').addEventListener('click', removeFriend);
  $('btn-poll').addEventListener('click', async () => {
    await api('/api/poll', 'POST', {});
    await loadState(false);
  });
  $('search-input').addEventListener('input', (e) => { searchTerm = e.target.value.trim(); renderSidebar(); });

  const input = $('input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  document.querySelectorAll('.modal-backdrop').forEach((bd) => {
    bd.addEventListener('mousedown', (e) => { if (e.target === bd) bd.style.display = 'none'; });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSettings(); closeFriendModal(); }
  });
}

function registerSW() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

bindEvents();
registerSW();
loadState(true);
setInterval(() => loadState(false), 3000);