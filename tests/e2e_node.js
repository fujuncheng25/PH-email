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
const SMTP = 25331, POP3 = 25332, IMAP = 25333;
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

(async () => {
  cleanupTmp();
  const mock = spawn(PY, [path.join(__dirname, 'mock_mail.py'), '--smtp', String(SMTP), '--pop3', String(POP3), '--imap', String(IMAP)], {
    stdio: 'ignore',
  });
  mocks.push(mock);
  await waitMock();

  const dataDir = path.join(TMP, 'node-data');
  fs.rmSync(dataDir, { recursive: true, force: true });
  const webDir = path.join(__dirname, '..', 'web');
  const inst = await startServer({ port: 25341, webDir, dataDir });
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
  check('N10 已读标记生效无重复', msgs4.length === 2, String(msgs4.length));

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
  cleanupTmp();

  console.log(`== NODE BACKEND RESULT: ${passed.length} passed, ${failed.length} failed ==`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  mocks.forEach((m) => { try { m.kill(); } catch (err) { /* ignore */ } });
  cleanupTmp();
  console.error('FATAL:', e);
  process.exit(2);
});