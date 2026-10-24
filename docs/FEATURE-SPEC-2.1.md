# Email Chatter 2.1 增补规格（在 2.0 基础上）

> 工作区根：`C:\Users\splay\Documents\email-automate`；源码根：`source/`。
> 2.0 的 `docs/FEATURE-SPEC-2.0.md` 仍然有效，本文件只描述本轮新增/变更。
> 改动目标：C++ 后端、Node 后端、`web/` 前端、`tests/` 行为保持一致；不破坏 2.0 已有功能。

---

## A. 邮箱已读/未读语义（重点）

### 现状问题（2.0）
- `imap_fetch` 使用 `UID FETCH <uid> (RFC822)`：按 RFC 3501，`RFC822` 等价于 `BODY[]`，**获取正文会让服务器自动置 `\Seen`**；
  随后还显式 `UID STORE +FLAGS.SILENT (\Seen)`。
- 因此非好友邮件、以及聊天里还没读的邮件，都会在用户邮箱里被标成已读。

### 新语义（C++/Node 必须一致）
1. **收信只读，不改服务器状态**：IMAP 拉取改用 **`BODY.PEEK[]`**（`UID FETCH <uid> (BODY.PEEK[])`），**删除 fetch 后的 `+FLAGS (\Seen)`**。
   - 非好友邮件：照旧加入 `seen_imap` 去重，但**绝不对服务器做任何 STORE/DELETE/移动**，邮箱里保持未读。
   - 好友邮件：拉取后同样保持未读；只有用户在聊天里打开该会话（`/api/read`）时才标记已读。
2. **消息记录 IMAP UID**：`message` 新增可选字段 `"uid": "123"`（收件为 IMAP 且存在时；POP3 无）。持久化到 `messages.json`，旧数据缺省即可。
3. **打开会话 = 标记已读**：
   - `POST /api/read {with}`：本地未读清零（现有行为）之外，把该会话内 **dir=in 且带 uid 的消息 uid** 放入内存集合 `pending_seen_imap`；
     清空本地未读后调用 `trigger_poll()`（不阻塞 HTTP 响应）。
   - 下一次轮询的 IMAP 会话中，先批量发送 `UID STORE <uid列表> +FLAGS.SILENT (\Seen)`（每 ~50 个 uid 一条命令，避免逐条往返）；
     成功后再把这些 uid 从 `pending_seen_imap` 移除；失败则保留，下次轮询重试。
   - 标记已读只针对好友会话（`/api/read` 只会在打开好友会话时调用）。
4. **删除好友**：
   - 不删除、不移动、不标记邮箱里的任何邮件；未读的邮件因为从未被标 seen，天然保持未读（已读过的保持已读，符合“聊天里未读的邮件在邮箱里也应未读”）。
   - 聊天本地仍按现有行为清除该好友会话/未读（保持 2.0 语义，README 已有说明）。
5. **POP3**：协议没有已读标志，客户端无法设置邮箱已读/未读；本次不改 POP3 拉取逻辑（不删除服务器邮件）。UI/README 说明即可。
6. **旧版本已误标记的邮件**：2.1 不做“批量恢复未读”（可能影响用户其它客户端），只保证升级后不再误标。
7. 拉取时遇到超限（>50MB）邮件：不 STORE（保持未读），仅记 `seen_imap` 防重复下载。

### 涉及代码
- C++：`src/proto.hpp/.cpp`（imap_fetch 增加 pending_seen 参数、BODY.PEEK[] 解析、imap_mark_seen 批量 STORE）、
  `src/mime.hpp`（Msg 增加 `uid`）、`src/app.cpp/.hpp`（Message.uid 持久化、pending_seen_imap、/api/read 收集 uid + trigger_poll、poll_once 传参/清理）。
- Node：`electron/backend.js` 对应实现（imapFetchOne 改 BODY.PEEK[]、imapFetch 接收 markSeenUids、App.apiRead 收集 + triggerPoll）。
- 测试：`tests/mock_mail.py` 需支持 `BODY.PEEK[]`（返回 `BODY[] {len}` literal，不置 seen）与多条/逗号分隔 UID STORE；`SEARCH UNSEEN` 已按 imap_seen 过滤。

---

## B. 未读新消息红点（WeChat 风格，前端）

- 好友列表里，未读数 badge 显示在**头像（avatar）右上角**（红色圆角小框，数字，>99 显示 99+），不再放在列表右侧时间下方。
- 结构建议：`<div class="avatar-wrap"><div class="avatar">…</div><span class="badge">3</span></div>`；
  `avatar-wrap{position:relative}`，`badge{position:absolute;top:-6px;right:-6px;…}`。
- 0 条不显示；保留现有 `unread` 数据与点击行为、好友列表排序逻辑不变。
- 离线模式缓存渲染同样显示 badge。

---

## C. 右键菜单（前端）

1. **消息右键菜单**（`#messages` 内气泡，in/out 均支持；同时保留现有悬停“引用/撤回”按钮）：
   - `复制文字`：复制消息正文（`navigator.clipboard.writeText`，失败降级 `document.execCommand('copy')`；无文字时提示“该消息没有可复制的文字”）。
   - `引用`：同现有引用逻辑（显示引用条，发送时带 quote）。
   - `撤回`：仅自己、未撤回、有 mid 的消息显示；行为同现有悬停撤回（confirm 提示）。
   - 菜单出现在鼠标位置，点击外部/Esc/滚动关闭；不遮挡、不出屏幕；样式沿用现有配色。
2. **好友右键菜单**（好友列表项）：`删除好友`（同现有 ✕ 删除逻辑，confirm 文案提示：邮箱里的邮件不会被删除；聊天记录会清除）。
   - 聊天头部现有 ✕ 按钮保留。
3. 不新增第三方依赖；所有注入的前端文本继续使用 esc()。

---

## D. 引用 = 邮件 reply（关键行为变更）

- 发送带 `quote{mid,…}` 的消息时，邮件必须表现为**回复**：
  - 若 quote.mid 是合法 Message-ID（`<...>`，无 CR/LF，长度 ≤ 320），邮件增加：
    - `In-Reply-To: <quote.mid>`
    - `References: <quote.mid>`
  - 主题自动加 `Re: ` 前缀（不区分大小写判断，已经以 `Re:` 开头则不重复加）：
    - 扩展邮件模式：用户主题/AI 主题/启发式主题 → `Re: …`；
    - 小输入框聊天模式：`Re: email-chatter 消息`（AI 主题则 `Re: <AI 主题>`）。
  - 原有的 `X-Email-Chatter-Quote` 头和正文 `--- 引用 ---` 引用块**保留**（本客户端显示引用卡片用）。
- 无 quote.mid（旧消息/外部引用无 Message-ID）时：仍带 quote 头与引用块，但不加 `In-Reply-To/References`、不加 `Re:`（避免伪造线程）。
- 收到的普通邮件即使带 In-Reply-To/References，也**不**自动生成引用卡片（保持 2.0 行为，避免正文重复）。
- `mime::build_message`/`ComposeOptions` 与 Node `buildRawMessage` 都要支持；本地存储的发件消息 `subject` 记录带 `Re:` 后的实际主题。
- 测试：chat/email 两种模式带 quote 发送，断言 raw 中 `Subject: Re: …`（RFC2047 解码后）、`In-Reply-To`、`References` 正确；无 mid 的 quote 不含这两个头。

---

## E. 验收与回归

- 现有 C++ 141 项 / Node 74 项测试更新后全绿，并新增：
  - 非好友邮件注入 → 轮询后 mock 邮箱 `imap_seen` 不包含该 uid（保持未读），且客户端不显示该邮件。
  - 好友邮件注入 → 轮询后未读；调用 `/api/read` 后再轮询 → mock 邮箱对应 uid 变为 seen；邮箱其它邮件不受影响。
  - 删除好友：mock 邮箱 raw 数量与 seen 状态不变；未读好友邮件仍 unseen。
  - reply：quote.mid → raw 含 In-Reply-To/References、Subject Re:；无 mid → 不含。
- 前端人工验收：未读 badge 在头像右上角；消息右键菜单复制/引用/撤回可用且不破坏悬停按钮；好友右键删除可用。
- 既有 AI / 附件 / 引用 / 撤回 / 删除好友 / Host-Origin 防护等 2.0 功能不回归。

---

## F. 文件所有权（本轮）

| 成员 | 文件 |
|---|---|
| cpp-core | `src/proto.*`、`src/mime.*`、`src/app.*` |
| node-core | `electron/backend.js` |
| web | `web/index.html`、`web/app.js`、`web/style.css` |
| verifier | `tests/e2e_test.py`、`tests/e2e_node.js`、`tests/mock_mail.py` |
| Lead | 本文件、README、集成构建、最终测试、打包 |
