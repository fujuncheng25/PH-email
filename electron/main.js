'use strict';
/*
 * Email Chatter - Electron main process.
 * Starts the pure-Node backend (same REST API as the C++ build) and opens
 * the shared web/ UI in a standalone window. No native modules, so no
 * antivirus / Gatekeeper hassles.
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, shell, dialog } = require('electron');
const { startServer, stopServer } = require('./backend');

const isMac = process.platform === 'darwin';
let win = null;
let server = null;

/*
 * 安全边界：数据目录必须在「程序目录」内，程序目录之外 0 读取 / 0 写入。
 *   默认 <程序目录>/data；--data 也必须是程序目录内的路径。
 *   程序目录不可写时直接报错退出（不再回退到 %APPDATA%）。
 */
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function pickDataDir(explicit, progDir) {
  const dir = explicit ? path.resolve(explicit) : path.join(progDir, 'data');
  if (!isInside(dir, progDir)) {
    return { error: '数据目录必须在程序目录内\n\n程序目录: ' + progDir + '\n指定目录: ' + dir };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    return { error: '程序目录不可写，无法创建数据目录\n\n' + dir + '\n请把程序放到可写目录（例如 D:\\Apps\\EmailChatter）。' };
  }
  return { dir };
}

// 部分第三方打包的 Electron 运行时在单实例锁上会异常，失败时降级为允许多开
let gotLock = true;
try {
  gotLock = app.requestSingleInstanceLock();
} catch (e) {
  console.error('[email-chatter] single-instance lock unavailable, continuing:', e && e.message);
  gotLock = true;
}

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  function createWindow() {
    win = new BrowserWindow({
      width: 1100,
      height: 720,
      minWidth: 780,
      minHeight: 520,
      title: 'Email Chatter',
      backgroundColor: '#191919',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadURL('http://127.0.0.1:' + server.port + '/');
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    win.on('closed', () => { win = null; });
  }

  app.whenReady().then(async () => {
    const argOf = (name) => {
      const i = process.argv.indexOf(name);
      return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
    };
    const portArg = parseInt(argOf('--port'), 10);
    const dataArg = argOf('--data');
    const headless = process.argv.includes('--headless');
    const progDir = path.dirname(app.getPath('exe'));
    const webDir = path.join(app.getAppPath(), 'web');

    const picked = pickDataDir(dataArg, progDir);
    if (picked.error) {
      console.error('[email-chatter] ' + picked.error);
      if (!headless) dialog.showErrorBox('Email Chatter 无法启动', picked.error);
      app.quit();
      return;
    }
    const dataDir = picked.dir;

    if (!fs.existsSync(path.join(webDir, 'index.html'))) {
      const msg = '找不到界面资源：' + path.join(webDir, 'index.html') +
                  '\n\n请保持 web 文件夹与程序在一起，不要单独移动 exe。';
      console.error('[email-chatter] ' + msg);
      if (!headless) dialog.showErrorBox('Email Chatter 无法启动', msg);
      app.quit();
      return;
    }

    try {
      server = await startServer({ port: portArg > 0 ? portArg : 0, dataDir, webDir });
    } catch (e) {
      console.error('[email-chatter] backend failed:', e);
      app.quit();
      return;
    }
    if (headless) {
      console.log('[email-chatter] headless mode: http://127.0.0.1:' + server.port + '/');
      console.log('[email-chatter] dataDir=' + dataDir);
      return;
    }
    createWindow();
    app.on('activate', () => {
      if (win === null && server) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });

  app.on('will-quit', () => {
    if (server) stopServer(server);
  });
}