# Email Chatter 2.0 — 功能扩展规格书（团队唯一事实来源）

> 工作区根目录：`C:\Users\splay\Documents\email-automate`
> 项目源码根目录：`source/`（下文路径均相对 `source/`）
> Baseline 已提交到 git（`8ed6c1f`），可用 `git diff` 复查改动。
> 本文件由 Lead 维护；实现中如发现规格有歧义，先按最合理解释实现，并在完成消息里报告偏离点。

---

## 0. 目标与范围

在现有 Email Chatter（C++ 后端 + `web/` 前端 + Electron/Node 后端，共享同一套 REST API 与 UI）上新增：

1. **扩展邮件编辑器（expand）**：输入框左上角 expand 按钮 → 完整邮件模式（主题/抄送/密送/附件/引用，Enter 换行≠发送、Tab 可用、Ctrl+Enter 发送）。发出的邮件内容为正常邮件（可被普通邮箱用户阅读）。
2. **小输入框（旧算法）保持聊天语义**，但支持**附加文件**（图片/任意文件）。
3. **图片收发**：发送图片（选择/拖拽/粘贴）、接收 MIME 附件中的图片并在聊天中缩略图显示、点击大图；非图片附件显示文件卡片可下载。
4. **引用功能**：对任意消息"引用"后发送，接收端显示引用卡片（邮件正文里也有普通邮箱用户可读的引用块）。
5. **撤回功能**：撤回自己发出的消息；通过 EmailChatter 私有邮件通知对端客户端删除/标记该消息（对普通邮箱用户无法真正收回，UI 需提示）。
6. **可选 AI 标题**（设置里开启，**默认关闭**）：从 HuggingFace 镜像下载 Qwen2.5-0.5B-Instruct GGUF（Q4_K_M）到 `data/models/`，本地推理，为发出的消息生成邮件主题。关闭时：
   - 小输入框仍用旧固定主题 `email-chatter 消息`；
   - 扩展邮件模式主题留空时用启发式标题（取正文首段截断）。
   AI 开启时：小输入框消息主题 = AI 生成（失败回落旧固定主题）；扩展邮件模式主题留空 = AI 生成（失败回落启发式）。
7. **C++ 与 Electron/Node 两个后端 API 行为一致**；前端共用。

**非目标**：多人群聊、HTML 富文本邮件、OAuth、真正的邮件服务器端撤回、大附件分片上传、AI 模型上传/微调。

**约束**：
- 不引入任何第三方运行时依赖/原生模块（C++ 仅标准库 + 现有可选 OpenSSL；Node 仅内置模块）。
- 不破坏现有 e2e 行为与旧数据文件（旧 `messages.json` / `config.json` 可无损加载）。
- 所有用户可见字符串用简体中文；代码注释中文/英文均可。
- C++17；MSVC 2026 / GCC 均可编译；Linux 下无 OpenSSL 时除"下载模型"外功能可用。
- 前端保持零构建（原生 JS/CSS，无打包器）。

---

## 1. 文件所有权（写入范围，避免并发冲突）

| 成员 | 独占写入文件 |
|---|---|
| Lead | `README.md`、`../FEATURE-SPEC.md`、发布打包、最终验证；不改实现文件 |
| web | `web/index.html`、`web/app.js`、`web/style.css`、`web/sw.js` |
| cpp-core | `src/app.cpp`、`src/app.hpp`、`src/mime.cpp`、`src/mime.hpp`、`src/proto.cpp`、`src/proto.hpp`、`src/http.cpp`、`src/http.hpp`、`src/util.cpp`、`src/util.hpp` |
| cpp-ai | 新建 `src/ai.cpp`、`src/ai.hpp`、`src/gguf.cpp`、`src/gguf.hpp`；`CMakeLists.txt`；`tools/ai_*`（测试/模型工具） |
| node-core | `electron/backend.js`、`electron/package.json` |
| node-ai | 新建 `electron/ai.js`、`electron/ai-worker.js`、`electron/gguf.js`；`tools/node-ai-*` |
| verifier | `tests/e2e_test.py`、`tests/e2e_node.js`、`tests/mock_mail.py`、`tests/seed_demo.py`、`tools/ref_llama.py` 等测试工具 |

规则：
- 只改自己范围内的文件；需要别人接口时先读其文件/消息，不要代改。
- 不提交 git（Lead 统一检查 diff）。
- 并发构建：cpp-core 用 `build/`，cpp-ai 用 `build-ai/`；不要删别人的产物。
- 测试端口：`tests/e2e_*` 固定端口，禁止在实现期间跑完整 e2e；自测用临时端口/临时目录。
- 完成后向 Lead 报告：改了哪些文件、接口、如何自测、遗留问题。

---

## 2. 数据模型（`data/messages.json` / REST 返回的 message 对象）

保持旧字段兼容，新增字段全部可选：

```jsonc
{
  "id": 42,                     // 自增，保持不变
  "dir": "in" | "out",
  "kind": "chat" | "email",     // 缺省视为 "chat"（旧数据）
  "text": "正文纯文本",          // 旧字段；image-only 消息可为 ""，但存盘时用空串（不要用 "(空消息)" 覆盖附件消息）
  "subject": "邮件主题",         // 仅 kind=email 有意义；chat 消息也持久化实际发出的主题（AI 或固定主题），可选
  "ts": 1730000000,
  "time": "10-24 12:00",        // 仅 /api/messages 返回时生成
  "mid": "<message-id>",        // 收件必有；本版本起发件也记录（撤回/引用依赖）
  "quote": {                    // 可选：本条消息引用的消息
    "text": "被引用的正文（后端截断到 500 字符）",
    "from": "昵称或邮箱",
    "ts": 1729990000,
    "mid": "<原 message-id，可为空>"
  },
  "attachments": [              // 可选；按发送顺序
    {
      "name": "photo.png",      // 原始文件名（UTF-8，已清洗路径分隔符）
      "mime": "image/png",
      "size": 12345,
      "file": "1730000000-ab12-photo.png",   // data/attachments/ 下的文件名（后端生成）
      "url": "/api/attachment?file=1730000000-ab12-photo.png", // /api/messages 返回时生成
      "inline": true            // 图片恒 true，其它文件 false
    }
  ],
  "recalled": false             // true 时前端显示"对方/你撤回了一条消息"
}
```

- `kind=email` 的 `text` 是去掉引用块后的正文（后端在收到带 `X-Email-Chatter-Quote` 的邮件时，剥离正文里 `\n\n--- 引用 ---\n` 之后的部分，避免引用重复显示）。
- 发件消息的 `subject`：chat 模式 = 实际写入邮件的主题（AI 标题或旧固定主题）；email 模式 = 用户主题或自动标题。
- 旧 `messages.json` 中无这些字段的记录按默认值加载；`data/config.json` 旧文件可加载、新字段写回。
- 会话保留上限保持 300 条；正文上限：chat 4000 字符，email 16000 字符（按 UTF-8 字符截断）；超出时截断并提示。
- `last_text` 预览规则：`recalled` → `[已撤回]`；有图片附件 → `[图片]`；有其它附件 → `[文件] 名称`；kind=email → `subject`（空则 text 首行）；否则 text 首行。

### 2.1 配置（`data/config.json`）新增

```jsonc
"ai": {
  "enabled": false,                                   // 默认关闭
  "mirror": "https://hf-mirror.com",                  // 可改
  "model_url": "",                                     // 可选：完整覆盖下载 URL（用户高级设置）
  "model_file": "qwen2.5-0.5b-instruct-q4_k_m.gguf"   // 固定文件名（data/models/ 下）
}
```

- 缺失时视为默认值；`/api/config` 接受并保存 `ai` 对象（只覆盖提供的字段，与现有"部分保存"语义一致）。
- `/api/state` 的 `account.ai` 返回该配置；同时 `/api/state` 顶层返回 `ai` 状态对象（见 §4.6）。

---

## 3. 邮件线格式（MIME）

### 3.1 自定义头（保持"对普通邮箱用户是正常邮件"）

| 头 | 值 | 说明 |
|---|---|---|
| `X-Email-Chatter` | `1` | 旧头保留 |
| `X-Email-Chatter-Kind` | `chat` / `email` / `recall` | 缺省视为 `chat` |
| `X-Email-Chatter-Quote` | base64(UTF-8 JSON `{text,from,ts,mid}`) | 引用元数据；76 字符折行，续行以单个空格开头；解析时删除所有空白再 base64 解码 |
| `X-Email-Chatter-Recall` | 原消息 `Message-ID` | 撤回通知；收到后处理并**不**生成聊天消息 |
| `X-Email-Chatter-Subject` | — | 不需要；主题走标准 `Subject:` |

- 所有头值经 CR/LF 注入清洗；`X-Email-Chatter-Quote` 的 base64 只含 `A-Za-z0-9+/=`，安全。
- 撤回邮件：`Subject: 撤回了一条消息`，`X-Email-Chatter-Kind: recall`，正文 `对方撤回了一条消息`，无附件；普通邮件客户端只会看到一封简短通知邮件（可接受）。
- 引用正文块（普通邮箱用户可读，附加在用户正文之后）：
  ```
  \n\n--- 引用 ---\n> 发件人：<from>\n> 时间：<YYYY-MM-DD HH:MM>\n> <quote 每行前缀 "> ">
  ```
  后端在生成正文时追加；解析端若存在 `X-Email-Chatter-Quote` 头则剥离该块（从 `\n\n--- 引用 ---\n` 起到正文末尾）。

### 3.2 正文与附件（multipart）

- 无附件：`Content-Type: text/plain; charset=UTF-8` + base64（现有实现）。
- 有附件：`Content-Type: multipart/mixed; boundary="=ec_<随机>_<计数>"`：
  1. 第一部分 `text/plain; charset=UTF-8`，`Content-Transfer-Encoding: base64`；
  2. 每个附件：`Content-Type: <mime>; name="<encoded>"`，`Content-Disposition: attachment; filename="<encoded>"`（RFC2231/2047 均可，文件名含非 ASCII 时用 RFC2047 B 编码），`Content-Transfer-Encoding: base64`，base64 按 76 字符折行。
- 图片：mime 为 `image/png|jpeg|gif|webp|bmp`；`inline: true` 元数据由接收端按 mime 判断，不要求 `Content-ID`。
- 接收限制：单附件 ≤ 16MB，合计 ≤ 24MB；超出跳过该附件（消息仍写入）。单封邮件解析上限沿用 IMAP 的 50MB。
- `Reply-To`/`Date`/`Message-ID`/`MIME-Version` 保持现有生成方式；`Cc` 头在发送时写入（`Bcc` 只进 SMTP 信封，不写头）。

### 3.3 发信 API（proto 层）

- C++：新增
  ```cpp
  bool smtp_send_raw(const SmtpConfig& cfg, const std::vector<std::string>& rcpts,
                     const std::string& raw_message, std::string& err);
  ```
  旧 `smtp_send(cfg,to,subject,body,err)` 保留（内部走 raw + 单个 rcpt），供旧测试/兼容。
- Node：`smtpSendRaw(cfg, rcpts, raw)`，旧 `smtpSend` 保留。
- 收件人列表 = to + cc + bcc（去重、去空、校验含 `@`，最多各 5 个）。

---

## 4. REST API（C++ 与 Node 必须一致）

通用：JSON；`/api/*` 沿用 Host/Origin 校验；错误 `{"ok":false,"error":"中文原因"}`。
`/api/messages` 返回的 message 见 §2（含 `time/url`），`/api/state` 保持旧字段并追加。

### 4.1 `POST /api/send`

```json
{
  "to": "friend@x.com",
  "text": "正文（可含换行/Tab）",
  "kind": "chat",                        // 可选，默认 chat
  "subject": "主题",                      // 仅 email 模式使用
  "cc": "a@x.com, b@x.com",              // 可选，email 模式
  "bcc": "c@x.com",                      // 可选，email 模式
  "quote": {"text":"...","from":"...","ts":123,"mid":"<...>"},  // 可选
  "attachments": [{"id":"u_1730_ab12","name":"photo.png"}]      // 可选，来自 /api/upload
}
```

行为：
1. 校验 to 是好友、账户已配置、SMTP 已配置；text 与附件不可同时为空（email 模式允许 text 为空但需有附件，正文补 `（无正文）`）。
2. 解析 attachments：从 `data/uploads/` 取暂存文件，校验存在与总大小；成功后复制到 `data/attachments/`（`<epoch>-<4hex>-<sanitized-name>`，文件名只保留 `[A-Za-z0-9._-]` 与中文，去路径分隔符，≤80 字符；重名追加序号）。
3. 决定主题：
   - kind=chat：`ai.enabled && model_ready && subject=="chat"` → AI 标题（失败/未就绪回落 `email-chatter 消息`）；否则固定 `email-chatter 消息`。
   - kind=email：`subject` 非空用它（trim，≤200 字符，CR/LF 清洗）；否则 AI（开启且就绪）→ 失败回落启发式标题。
4. 组装 raw（§3），SMTP 发送（多收件人）。失败：返回错误，不写本地消息、不移动暂存附件（可重试）。
5. 发送成功后写本地 out 消息（含 kind/subject/mid/quote/attachments/recalled=false），清理暂存文件，保存 messages.json。
6. 返回 `{"ok":true,"id":<id>,"subject":"<实际主题>","ai":<bool 是否AI生成>}`。

- 同步接口：AI 生成可能耗时（C++ 数秒、Node 数十秒），前端发送期间显示"生成标题中…"并禁用发送按钮；HTTP 超时设置 ≥ 180s。
- 未配置/离线时前端逻辑见 §5。

### 4.2 `POST /api/upload?name=<urlencoded filename>`（raw body）

- `Content-Type` 任意；body ≤ 16MB（http 层把限制从 8MB 提升到 32MB，见 §7）。
- 保存到 `data/uploads/<id>`，`id = "u_" + epoch + "_" + 8hex`；同请求另存元数据（内存 map 即可，进程重启后暂存文件可清理）。
- 返回 `{"ok":true,"id":"u_...","name":"photo.png","size":12345,"mime":"image/png"}`。
- 启动时清理 `data/uploads/` 中超过 24h 的文件。

### 4.3 `GET /api/attachment?file=<basename>`

- 只允许 `data/attachments/<basename>`；`basename` 不得含 `/ \ ..`；不存在→404。
- Content-Type 按扩展名（png/jpg/jpeg/gif/webp/bmp/pdf/zip/txt/json/mp4…，未知 octet-stream）；`Content-Disposition`：图片 `inline`，其它 `attachment; filename*=UTF-8''<peek>`（可选）；`Cache-Control: no-store` 沿用 http 层；支持 HEAD（可选）。

### 4.4 `POST /api/recall`

```json
{"with": "friend@x.com", "id": 42}
```

- 找到 `conversations[peer]` 中 id 匹配、dir=out、未撤回、`mid` 非空的记录；否则 `{"ok":false,"error":"该消息不支持撤回（缺少邮件标识或已撤回）"}`。
- 发送撤回邮件（§3.1，kind=recall，`X-Email-Chatter-Recall: <mid>`）。SMTP 失败→返回错误、不改本地状态。
- 成功：该消息 `recalled=true`（保留 text/subject/attachments 原始数据但前端不显示），保存，返回 `{"ok":true}`。
- 接收端处理（poll_once）：对每封来信，若含 `X-Email-Chatter-Recall`：
  - 在对应会话中查找 `dir=in && mid==该值` 的消息：找到则置 `recalled=true`（不改变顺序、不计未读）；找不到则记入 `pending_recalls`（持久化于 config.json，`set`），今后收到该 mid 的来信直接丢弃。
  - 该邮件本身不生成聊天消息。
- 撤回没有时间窗限制；前端确认框提示"若对方已读或使用其它邮箱客户端，无法保证删除"。

### 4.5 引用

- 发送时由 `/api/send` 的 `quote` 字段携带（无需单独接口）。后端把 quote 截断到 500 字符，写入 `X-Email-Chatter-Quote` 头与正文引用块，并在本地 out 消息存 `quote`。
- 接收：解析头→`quote` 对象；剥离正文引用块（§3.1）；存 `quote`。头解析失败则忽略，正文原样显示（不影响收信）。

### 4.6 AI 接口与状态

`ai` 状态对象（`/api/state` 顶层 `ai`、`/api/ai/status` 的 `ai`、`/api/config` 返回等一致）：

```json
{
  "enabled": false,
  "model_ready": false,
  "downloading": false,
  "downloaded_bytes": 0,
  "total_bytes": 0,
  "percent": 0,
  "error": "",
  "model_file": "qwen2.5-0.5b-instruct-q4_k_m.gguf",
  "mirror": "https://hf-mirror.com",
  "busy": false,
  "engine": "qwen2.5-0.5b-instruct-q4_k_m"
}
```

- `GET /api/ai/status` → `{"ok":true,"ai":{...}}`
- `POST /api/ai/download` → 启动后台下载（若已就绪返回 `{"ok":true,"ai":{...},"already":true}`）；立即返回，不阻塞。
- `POST /api/ai/cancel` → 取消下载/删除 `.part`；返回最新状态。
- `POST /api/ai/title` body `{"text":"...","subject":""}` → 同步生成，最多 180s：
  - 成功：`{"ok":true,"subject":"...","source":"ai"}`
  - 模型未下载/未启用/推理失败：`{"ok":true,"subject":"<启发式标题>","source":"heuristic","note":"<原因>"}`（不返回 http 错误，保证扩展模式总能发信）
  - `text` 为空 → 启发式 `无主题`。
- 下载任务与标题生成同一时刻只允许一个；`busy=true` 时新请求返回明确错误或等待（实现可简单：互斥锁，HTTP 线程阻塞等待，但 `/api/ai/status` 必须始终快速返回）。

---

## 5. 前端 UI 规格（`web/`）

### 5.1 布局与输入框（关键需求）

保持现有微信风格。`#composer` 重构：

**收起态（默认，小输入框）**
- 文本域左侧上方/左侧有：`📎 附件`、`⤢ 展开（expand）` 两个小按钮（expand 必须在文本输入框**左上角**，title="展开为邮件模式"）。
- 行为完全沿用旧算法：Enter 发送、Shift+Enter 换行、自动高度；发送 = kind=chat。
- 新增附件：点击📎选择文件（multiple），或拖拽文件到输入框，或粘贴剪贴板图片（`paste` 事件 `clipboardData.files`）。已选附件以 chips 显示在输入框上方（缩略图/文件名/大小/×）；发送时小输入框可带附件。附件上传走 `/api/upload`，发送 `/api/send` 带 attachments。上传中禁用发送。
- 离线（后端不可用）时：文字消息仍按旧逻辑排队；**带附件的消息不允许离线排队**，toast "离线模式暂不支持附件，请连上本地服务后再发"。
- 引用条：若当前有引用目标，输入框上方显示 `引用 <昵称>：<文本截断>` + ×，发送中带上 quote。

**展开态（邮件模式）**
- 点击 expand → 弹出/展开邮件编辑面板（可占据聊天区下半部或全屏 overlay，要求：明显、可编辑、不遮挡好友列表且可返回）。
  - 头部：`邮件模式` 标题 + `收起` 按钮（收起到小输入框，保留草稿）。
  - 字段行：`主题`（input）、`抄送`（input，placeholder "多个用逗号分隔，可留空"）、`密送`（input，可留空）。可加 `+ 抄送/密送` 折叠按钮，但字段本身要存在可用。
  - 正文：大 textarea（min-height 180px，可增长）：**Enter 换行**、**Tab 插入制表符**（`\t`，阻止默认焦点切换）、Ctrl+Enter / Cmd+Enter 发送；拖拽/粘贴图片与附件同样支持。
  - 附件 chips 与主题区的 ✨按钮（AI 开启且模型就绪时显示）：点击调 `/api/ai/title`，把结果填进主题，显示"生成中…"；也可以留空由后端在发送时自动生成。
  - 底部：`发送` 主按钮 + 提示"Enter 换行 · Ctrl+Enter 发送 · 内容将作为普通邮件发出"。发送 = kind=email。
  - 校验：主题可空（后端/前端自动生成）；正文与附件不能同时为空。
- 展开态与收起态共用同一份草稿（切换时不丢正文）；主题/抄送/密送状态保留。
- 发送期间按钮禁用并显示"发送中…"（AI 生成可能耗时，需 toast/状态提示）。

### 5.2 消息渲染

- 旧 chat 气泡保持；新增：
  - **引用卡片**：气泡内/上方显示浅灰底引用块 `引用 <from>` + 最多 3 行文本（超出省略）。
  - **图片附件**：气泡内缩略图网格（单图最大 240×240，多图小格），点击打开 lightbox（全屏遮罩，Esc/点击关闭，`<img src=url>`）；收到和发出的图片都要显示。
  - **非图片附件**：文件卡片（📄 名称 + 大小，点击 `<a download href=url>` 下载）。
  - **邮件卡片（kind=email）**：气泡样式区分（白底描边/主题加粗 + 分隔线 + 正文 + 附件），最大宽度 72%；顶部小字 `邮件`。
  - **撤回态**：居中灰色小字 `对方撤回了一条消息` / `你撤回了一条消息`（替换气泡，不显示内容/附件）。
  - 自己的消息悬停时显示操作按钮：`引用`（全部可引用）、`撤回`（仅 dir=out、未撤回、有 mid）；另外右键气泡弹出同样菜单（可选）。撤回前 `confirm()` 提示不可保证对方已读消息被删除。
  - 邮件模式收到消息若 `kind=email` 显示为邮件卡片；chat 不显示主题。
- 好友列表预览使用后端 `last_text`（已按 §2 规则），前端无需重复计算；会话内新消息后照旧刷新。
- 离线缓存：`localStorage` 缓存消息结构保持原样（新字段自然随 JSON 缓存）；离线时图片请求会失败，显示占位即可。

### 5.3 设置弹窗新增「AI 标题（可选）」区块

- 复选框：`启用 AI 生成邮件标题（本地 Qwen2.5-0.5B）`，**默认不勾选**。
- 说明文字：`首次使用需从 HuggingFace 镜像下载约 400MB 模型，保存在程序目录 data/models/；下载后可离线使用。生成一条标题 C++ 版约需数秒，Electron 版可能需 1–2 分钟。`
- 状态行：`未下载` / `下载中 45%（183.2 MB / 405.0 MB）` / `已就绪（405.0 MB）` / `错误：...`；打开设置时拉 `/api/ai/status`，下载中每 1s 轮询。
- 按钮：`下载模型`（disabled：已就绪/下载中）、`取消下载`（下载中可用）。
- 高级：镜像地址 input（默认 `https://hf-mirror.com`，可改，保存到 config.ai.mirror；空则用默认）；可选模型直链 input（config.ai.model_url，留空用内置候选 URL）。
- 保存设置时把 `ai.enabled/mirror/model_url` 一起 POST `/api/config`（与现有字段一起）；勾选启用但模型未下载时 toast 提醒先下载（不阻止保存）。
- 设置弹窗变长，保持可滚动（modal 已 max-height+overflow）。

**离线**：所有新增管理接口在离线时给出 toast；AI 相关 UI 在离线时显示"本地服务未运行"。

---

## 6. AI 本地推理引擎（重点，C++ 与 Node 各一份，行为一致）

### 6.1 模型与下载

- 默认模型：`Qwen/Qwen2.5-0.5B-Instruct-GGUF` 的 `qwen2.5-0.5b-instruct-q4_k_m.gguf`（约 400MB）。
- 下载 URL 候选（依次尝试，任一成功即可；`model_url` 非空时只用它）：
  1. `{mirror}/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf?download=true`
  2. `{mirror}/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf?download=true`
  3. `{mirror}/unsloth/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf?download=true`
- 保存 `data/models/qwen2.5-0.5b-instruct-q4_k_m.gguf`（先写 `.part`，校验首 4 字节 `GGUF` 且大小 ≥ 50MB 后改名；失败删除）。支持 HTTP 301/302/307/308 重定向（≤5 次）、`Content-Length` 进度、`Transfer-Encoding: chunked`、HTTPS 证书校验（沿用现有 TLS 实现/OpenSSL）。
- C++ 走现有 `proto::Net`（TLS + 主机名校验）；Node 用 `https`/`http` 模块。无 TLS 构建时返回明确错误。
- 取消：原子 flag；取消后删除 `.part`。下载线程不得阻塞轮询/HTTP。
- 下载进度：`downloaded_bytes/total_bytes` 原子更新；`/api/ai/status` 随时可读。

### 6.2 推理引擎（GGUF + Qwen2）

支持最低集合（目标模型 Q4_K_M 只会用到 Q4_K/Q6_K/F32，另加 Q8_0/F16/BF16 便于测试）：
- GGUF v2/v3 解析：magic/version、metadata KV（全部类型）、tensor info（name/dims/type/offset）、`general.alignment`（默认 32）对齐；数据区按 tensor offset 读取。
- 张量类型：`F32(0)`、`F16(1)`、`BF16(30)`、`Q8_0(8)`、`Q4_K(12)`、`Q6_K(14)`；如容易再支持 `Q4_0(2)`、`Q5_K(13)`。
- Qwen2 结构（从 metadata 读取）：`qwen2.block_count`、`qwen2.embedding_length`、`qwen2.feed_forward_length`、`qwen2.attention.head_count`、`qwen2.attention.head_count_kv`、`qwen2.attention.layer_norm_rms_epsilon`、`qwen2.rope.freq_base`（缺省 1e6）。
- 张量命名：`token_embd.weight`、`output.weight`（可能缺失 → 与 `token_embd` 共享/转置使用）、`blk.{i}.attn_norm.weight`、`blk.{i}.attn_q.weight/.bias`、`attn_k.weight/.bias`、`attn_v.weight/.bias`、`attn_output.weight`、`blk.{i}.ffn_norm.weight`、`ffn_gate.weight`、`ffn_up.weight`、`ffn_down.weight`。
- 前向：RMSNorm → QKV（带 bias）→ RoPE（**GGML NORM 模式：前后半对旋转，即 (i, i+head_dim/2) 成对；不是 interleaved**；base=rope.freq_base，Qwen2 无 scaling。node-ai 已用真实 Qwen2.5-1.5B Q8_0 对 llama.cpp 验证一致；C++ 必须同样实现）→ GQA 因果注意力（KV cache）→ 输出投影 → 残差 → SwiGLU MLP → 残差；末层 RMSNorm → lm_head logits。
- 生成：贪心（temperature=0），`n_predict ≤ 24`，遇到 `<|im_end|>`(151645) 或 `\n` 停止；tokenizer 采用 GGUF 内置 GPT-2 byte-level BPE（`tokenizer.ggml.tokens/merges/token_type`；按 `tokenizer.ggml.pre = qwen2` 的正则预切分，参考 Qwen 正则：`(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+`；ByteLevel 映射需完整实现，含 byte→unicode 表）。
- 内存：整文件读入内存（0.5B Q4_K_M ≈ 400–500MB）；KV cache 8MB 级；加载后空闲 5 分钟可卸载（C++ 在轮询线程 tick；Node 可用定时器/worker 空闲超时）。
- 并发：同一时刻只允许一个推理；C++ 用 mutex，Node 用 worker 队列。`/api/ai/status.busy` 反映。

### 6.3 标题提示词（两种后端必须一致）

```
<|im_start|>system
你是一个邮件主题生成助手。根据用户消息生成一个简洁、准确、不夸张的中文邮件主题，不超过20个字；只输出主题本身，不要引号、不要"标题："前缀、不要解释、不要句号。<|im_end|>
<|im_start|>user
{消息正文，UTF-8 截断到 600 字符}<|im_end|>
<|im_start|>assistant
```

后处理：trim → 去前缀 `标题[:：]` → 去包裹引号 `"“”'「」` → 去尾部 `。．.!！?？` → 换行合并为空格 → 截断 40 字符；空则启发式标题。

启发式标题（无模型/失败时，C++/Node/前端一致）：取正文第一个非空行，去除 markdown 标记与多余空白，截断 30 字符（超长加 `…`）；空则 `无主题`。

### 6.4 性能与实现要求

- C++ Release 构建下，0.5B Q4_K_M，提示 100 token + 生成 20 token 目标 ≤ 15s（单线程，允许用多线程加速 matvec 但非必须）。
- Node 允许慢，但必须（a）不阻塞 HTTP 服务与轮询 → 推理必须在 `worker_threads` 中；（b）进度/超时可控（请求可等待最多 180s，超时返回启发式 + note）。
- 引擎与下载逻辑封装成独立模块，不依赖 app/backend 内部状态，便于单测。

### 6.5 接口契约

C++ `src/ai.hpp`（cpp-ai 提供，cpp-core 引用）：
```cpp
namespace ai {
struct Config { bool enabled=false; std::string mirror="https://hf-mirror.com";
                std::string model_url; std::string model_file="qwen2.5-0.5b-instruct-q4_k_m.gguf"; };
struct Status { bool enabled=false, model_ready=false, downloading=false, busy=false;
                long long downloaded_bytes=0,total_bytes=0; std::string error, mirror, model_file, engine; };
class Manager {
 public:
  void init(const std::string& data_dir);       // 建 data/models 等；可重复调用
  void set_config(const Config& c);
  Config config() const;
  Status status() const;
  bool start_download(std::string& err);
  void cancel_download();
  // 阻塞生成；始终返回标题：模型不可用时 source="heuristic" 且 note 说明原因
  std::string generate_title(const std::string& text, std::string& source, std::string& note);
  void idle_tick();                              // 空闲卸载（poller 每次调用）
};
Manager& manager();
std::string heuristic_title(const std::string& text);
}
```
Node `electron/ai.js`：
```js
module.exports = {
  init(dataDir), setConfig(cfg), getConfig(), status(),
  startDownload() -> {ok, error?}, cancelDownload(),
  generateTitle(text) -> Promise<{title, source:'ai'|'heuristic', note}>,
  heuristicTitle(text),
};
```

---

## 7. 基础设施改动

- `http.cpp`：`Content-Length` 上限从 8MB 提升到 **32MB**；`content_type_for` 增加 jpg/jpeg/gif/webp/bmp/pdf/zip/mp4/mp3/ogg/txt/csv/docx/xlsx 等；新增 `Response::set_bytes`（含 content_type）或等效能力（API handler 需要返回二进制）。
- static 文件服务保持原样（附件走 `/api/attachment`）。
- `app.cpp` 新 API 路由：`/api/upload`、`/api/attachment`、`/api/recall`、`/api/ai/status|download|cancel|title`；其余沿用。
- C++ `App::api_send` 改为接受完整 body（`util::Json`），保留 `api_send(to,text)` 供旧调用（可选）。
- `poll_once` 处理撤回/附件/引用/kind；附件落盘后才写消息；保存失败回滚（简单：先写文件再写消息，失败跳过附件并记录）。
- 启动时创建 `data/attachments/`、`data/uploads/`、`data/models/`。
- Node 后端同样处理（`backend.js`）。
- `electron/package.json` 的 `files` 加入新的 ai 文件。
- sw.js 缓存版本号升级（`email-chatter-v3`）。

---

## 8. 构建与测试环境（Windows 本机）

```powershell
# 构建 C++（在 source/ 下）
$cmake='C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
$vcvars='C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
cmd /c "`"$vcvars`" >nul 2>&1 && `"$cmake`" -S . -B build -G `"Visual Studio 18 2026`" -A x64 -DOPENSSL_ROOT_DIR=`"C:\Users\splay\anaconda3\Library`""
cmd /c "`"$vcvars`" >nul 2>&1 && `"$cmake`" --build build --config Release"

# C++ e2e（需 PYTHONIOENCODING=utf-8；本机无外网，Scenario E/G 等依赖外网超时的用例可能失败，属基线环境问题）
$env:PYTHONIOENCODING='utf-8'; C:\Users\splay\anaconda3\python.exe tests\e2e_test.py

# Node 后端 e2e
$env:PYTHON='C:\Users\splay\anaconda3\python.exe'
$env:PATH='C:\Users\splay\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;' + $env:PATH
node tests/e2e_node.js
```

### AI 引擎验证资产（本机离线已有，勿修改/删除）

- 真实参考模型（Qwen2.5 架构，Q8_0）：`C:\Users\splay\.lmstudio\models\lmstudio-community\Qwen2.5-1.5B-Instruct-GGUF\Qwen2.5-1.5B-Instruct-Q8_0.gguf`
- Q4_K_M 参考（用于 Q4_K dequant 对照，架构不同不能跑生成）：`C:\Users\splay\.lmstudio\models\lmstudio-community\Qwen3.5-4B-GGUF\Qwen3.5-4B-Q4_K_M.gguf`
- llama.cpp 参考实现：`C:\Users\splay\.lmstudio\extensions\backends\llama.cpp-win-x86_64-avx2-2.23.1\llama-server.exe`（`llama.dll` 导出 `llama_tokenize/llama_decode/llama_model_quantize`）。
  - 启动：`llama-server.exe -m <gguf> --port 25390 --host 127.0.0.1 -c 2048 -t 4`
  - `POST /tokenize {"content": "..."}` → 参考 token ids；`POST /completion {"prompt": "...", "n_predict": 20, "temperature": 0, "cache_prompt": false}` → 参考生成。
  - 注意：llama-server 必须作为**后台作业**运行（前台命令结束时子进程会被杀）。
- 本机无外网（hf-mirror 不可达），下载只能做"失败路径/取消/进度"测试；**不要**为了测试去真实下载。
- 引擎自测 CLI（cpp-ai 提供）+ Node 自测脚本，用上面的本地模型验证：
  1. tokenizer 与 llama-server `/tokenize` 多句对比（中英混合、标点、换行）；
  2. 对 Qwen2.5-1.5B Q8_0 用同一 raw prompt 生成，比较 token 序列/文本（允许 llama.cpp 的细微差异，但首 8 个 token 应基本一致）；
  3. Q4_K 路径：用 Python 把 Q8_0 的某几层/整模型转成 Q4_K_M GGUF 后，llama-server 能正常加载生成 + 我们的引擎结果与 llama-server 一致（至少完成 tiny 模型/整模型二选一）。
- 注意本机内存/时间：1.5B Q8_0 文件约 1.6GB；测试时用 `-t 4`、单次生成 token 数 ≤ 16。

---

## 9. 验收清单

功能（人工/自动化）：
1. 小框 Enter 发送、Shift+Enter 换行行为不变；小框可加图片/文件并成功发送、对端可显示/下载。
2. expand 进入邮件模式：主题/抄送/密送可填；Enter 换行、Tab 插入、Ctrl+Enter 发送；发出的邮件在 mock SMTP 原始报文里是标准 multipart 邮件，普通邮箱客户端可读。
3. 收到他人用普通邮箱发的带附件/带主题的邮件（白名单内）能被解析；图片显示、文件可下载。
4. 引用任意消息发送，双方显示引用卡片，原始邮件含可读引用块。
5. 撤回自己的消息：对端（EmailChatter）收到撤回通知后该消息变为"撤回"态；本端同样；对端重新收信不会复活；普通邮箱用户仍看到原邮件（UI 有提示）。
6. 设置默认不启用 AI；开启但未下载时发送有明确回落与提示；下载接口在无网环境下优雅报错/可取消；`/api/ai/status` 字段完整。
7. AI 引擎用本地 Qwen2.5-1.5B Q8_0 自测通过（tokenizer 与生成）；0.5B Q4_K_M 路径代码覆盖 Q4_K/Q6_K 解码（用本地 Q4_K_M 参考模型或量化对照验证）。
8. C++ `tests/e2e_test.py` 新增用例通过；Node `tests/e2e_node.js` 通过；旧有用例不回归（网络相关的基线超时除外）。
9. 两个后端对同一请求返回结构一致（字段名、错误语义）。
10. `README.md` 更新功能说明、使用方式、AI 模型下载与隐私说明（Lead 负责）。

---

## 10. 协作约定

- 接口以本规格 + §6.5 头文件/模块契约为准；先写接口骨架，立即用 `send_message` 通知 Lead 和相关成员（cpp-ai ↔ cpp-core、node-ai ↔ node-core）。
- 遇到规格冲突：以本文件为准；如需偏离，先在完成报告里说明，Lead 决定是否回改。
- 每完成一个阶段（骨架/核心实现/自测通过）向 Lead 发一条简短进度消息。
- 不要新增第三方依赖；不要修改本文件之外的所有权表。
