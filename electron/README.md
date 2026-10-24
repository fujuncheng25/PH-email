# Email Chatter · Electron 版（Windows / macOS / Linux）

纯 Node.js 后端 + Electron 外壳，复用仓库根目录 `web/` 的同一套界面。
**没有任何原生模块**（不依赖 node-gyp / 编译链），打包后不会因“自编译二进制”被杀毒软件启发式拦截。

## 目录

```
electron/
  main.js        主进程：启动后端、开窗口（支持 --headless/--port/--data）
  backend.js     纯 Node 后端：HTTP + SMTP/POP3/IMAP + MIME（无第三方依赖）
  package.json   electron + electron-builder 配置
  build-win.bat  Windows 一键构建
```

## 本机运行（开发）

```bat
cd electron
npm install
npm start
```

## 打包 Windows

```bat
cd electron
npm install
npm run dist:win
```

产物在 `electron/dist/`：`Email Chatter Setup <版本>.exe`（NSIS 安装包）。
也可用 `npm run dist:mac` / `dist:linux` 在对应平台打包。

## 无界面自检（不弹窗，只验证后端）

```bat
"dist\win-unpacked\Email Chatter.exe" --headless --port 48731 --data .\tmp-data
```

然后用浏览器打开 `http://127.0.0.1:48731/api/state` 应返回 JSON。

## 说明

- 后端仅监听 `127.0.0.1`，出站只连接用户自己配置的邮件服务器。
- 数据只写**程序目录**下的 `data/`（便携式）：`data/config.json`（含**明文授权码**）+
  `data/messages.json`；不写用户目录、不写注册表。**程序目录之外 0 读取、0 写入**：
  `--data` 若指向程序目录外会弹错退出；程序目录不可写时同样报错，不会回退到 `%APPDATA%`
  （请把程序放到可写目录，如 `D:\Apps\EmailChatter`）。
- 渲染进程 `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`，只加载本地 `http://127.0.0.1` 页面。
- 界面与 C++ 版完全一致（同一份 `web/`）。
