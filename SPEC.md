# DSH Mini（手机桥）技术文档 — Codex-Mini 同款适配 DeepSeek Harness Desktop

> 状态：SPEC v0.5（v1.2.0 已实现 M1 闭环 + M2 增强 + M3 部分打磨：附件 / 按会话模型切换 / 余额徽章 / 推理档 / 网关设置 + 侧栏二维码 / APK 壳工程；详见第 14 节）
> 日期：2026-08-16  
> 参考项目：[CoimgRain/Codex-Mini](https://github.com/CoimgRain/Codex-Mini)（v5.5.4）  
> 本地基础：本仓库 `openclaw-dsh-bridge/`（已验证可用的 DSH 插件骨架）

---

## 0. 一句话目标

把 Codex-Mini 的「手机浏览器 ↔ 电脑端 AI 会话」桥接体验，复刻到 **DeepSeek Harness Desktop（DSH）** 上：在手机上发文字 / 图片 / 文件，实时看到 DSH agent 的思考过程、工具调用与最终回复，并能管理会话、切换模型、停止生成。

---

## 1. 原项目 Codex-Mini 解剖

Codex-Mini 是「手机 ↔ 本地服务 ↔ ChatGPT/Codex 桌面端」的桥。

| 维度       | 实现方式                                                                            |
| -------- | ------------------------------------------------------------------------------- |
| 本地服务     | 纯 Node `http` 服务，端口 8787，零第三方依赖，手机网页带 token 调用                                  |
| 控制 Codex | macOS `osascript` + `cliclick` 模拟键鼠、`codex://threads/<id>` deep link、剪贴板粘贴 + 回车 |
| 读回回复     | 解析本地 JSONL 会话文件 `~/.codex/sessions/*.jsonl`（非 GUI 抓取）                           |
| 鉴权       | `x-mobile-typer-token` / `?token=` / cookie 三选一                                 |
| 网络       | 同 Wi-Fi 走局域网直连；Pro 会员走外网中转服务器                                                   |

**继承的价值点（同款要保留）：**

- 手机随手发、线程列表同步、流式看过程
- 模型切换、推理模式切换、停止生成
- 局域网免费 + 外网中继双通道
- 液态玻璃手机 UI、可加到主屏、iPad 横屏布局

**原项目的弱点（DSH 版可彻底解决）：**

- 仅 macOS；依赖 GUI 自动化，脆弱易碎
- 无真 API，回复靠文件解析，延迟高、易丢步
- 跨平台能力差

---

## 2. 为什么 DSH 适配更优（可行性基础）

DSH（DeepSeek Harness）暴露了**真正的 agent 编程 API**，`openclaw-dsh-bridge` 已在真实 `dsh web` 实例中验证可用：

```js
const agents    = ctx.get("agents");            // agent 池
const sessions  = ctx.get("sessions");          // 会话服务
const defaultModel = ctx.get("agentDefaultModel");
const persistence  = ctx.get("sessionPersistence");

// 新建会话
const { agent } = await agents.create({
  sessionId: SessionId("session-" + randomUUID()),
  meta: { cwd }, agentOptions, setup,
});
// 接管已有会话（Codex-Mini 式「接着桌面线程」）
await agents.create({ resumeSessionId: existingId, ... });

// 注入用户消息
await agent.followup(createUserMessage({
  content: [{ type: "text", text }],
  source: { kind: "user" },
}));
await agent.whenIdle();                         // 等本轮结束

// 实时事件流：思考 / 工具调用 / 助手消息 / 状态
for (const event of agent.session.events) { /* seq + turn/start | assistant/message | turn/end */ }
```

插件机制：Cordis 插件运行在 DSH `webServer` 内，`ctx.webServer.register({ kind, path, handler })` 注册路由；设置页用 `installSettingsSection(ctx, NS, Config, config, {...})` 注册配置栏。

**结论：** DSH 版无需 GUI 自动化、天然跨平台（Win/Linux/macOS）、事件流即「思考/工具/回复」天然同步，能力优于 Codex-Mini 的文件解析方案。

---

## 3. 总体架构（已确认：混合控制 + 先只做局域网 + 原生 Android APK）

```
                        ┌─────────────────────┐
   手机 (PWA app)       │   外网中继 Relay      │   用户自建 / 隧道
   public/ 液态玻璃 UI  │   WS 隧道 + 设备签名   │
        │  │            └─────────┬───────────┘
   局域网 │  │ 外网                         │ 出站长连
        │  └──────────► 局域直连 ◄─────────┘
        │                  │
        ▼                  ▼
┌──────────────────────────────────────────┐
│  DSH Cordis 插件 (本桥)  lib/index.js       │
│  /dsh-mini/* 路由 + token 鉴权             │
│   · 列表 / 接管 / 新建 —— 全部是电脑上的真实 DSH 会话  │
│        │ agent API                         │
│        ▼                                    │
│  DSH Agent 会话（真实工作区）               │
└──────────────────────────────────────────┘
        运行在 DSH webServer 内
```

- **手机端 UI**：高保真可安装 **PWA**（液态玻璃、美观优先），由插件静态托管；手机浏览器打开 `http://<电脑IP>:<port>/dsh-mini/` 即连，可加到主屏作为 app。外网场景经中继可达。
- **服务端插件**：运行在 DSH `webServer` 内，混合控制（list 全部会话 + attach 接管 + new 新建），驱动真实 agent、归一化事件、推送手机端。
- **事件流**：`agent.session.events` 经 SSE 实时推回手机，天然呈现思考 / 工具 / 回复。
- **控制模型（关键澄清）**：本桥**不存在「手机私有会话」**。所有会话都是电脑端 DSH 里的真实 agent 会话，手机只是其中一个远程参与方——
  - **新建**：手机点「新建」→ 插件在电脑端 `agents.create` 一个真实 DSH 会话（工作目录落在 `~/.dsh/dsh-mini/workspace/<key>`，会出现在 DSH 会话列表里）。
  - **双向可控**：该会话在电脑桌面 DSH 与手机端**同时可见、同时可发消息**。任一方 `followup` 注入，事件都会经 `agent.session.events` 推给**双方**（手机走 SSE，桌面走原生 UI）。
  - **接管（attach）**：手机也可 attach 接管桌面上已有的 DSH 会话（`resumeSessionId`），同样双向可控。
  - **并发与冲突**：同一会话两端同时发消息时，采用 **last-writer-wins**——后到的 `followup` 排队进同一 agent；DSH 单 agent 串行处理回合，天然不会交错损坏。两端看到的事件流一致。
- **外网中继（后置/可选）**：P4 阶段再做；DSH 插件出站长连中继，手机经公网入口进，避免 PC 暴露公网端口，做设备绑定 + 签名鉴权。当前 P0–P3 仅局域网直连。

---

## 4. 功能清单 / 实现目标（分阶段）

### M1 — 核心闭环（已交付 1.2.0）

- [x] 线程列表：列出 DSH 已有会话（live + 持久化），含 id / 标题 / 工作目录 / 模型
- [x] 发文字消息 → `agent.followup` 注入当前/指定会话
- [x] 流式回复：SSE 推送 `agent.session.events`，手机端实时渲染思考 / 工具 / 最终答案
- [x] 停止生成：`agent` 终止本轮
- [x] 新建会话：`agents.create`

### M2 — 同款增强（已交付 1.2.0）

- [x] 附件：手机发图片 / 文件，落到会话工作区并以文件引用或视觉能力送达 agent
- [x] 模型切换：`agent` 切换 provider/model
- [x] 会话接管（attach）：手机接管桌面上正在用的 DSH 会话（用 `resumeSessionId`）

### M3 — 体验打磨（已交付 1.2.0 大部分）

- [x] 推理档切换（模型菜单内按模型提供档位）
- [x] 余额圆环：复用 `dsh-balance` 的 Desktop 壳事件，经 client 半边转发 host 缓存，手机读取
- [x] iPad / 横屏布局
- [x] 液态玻璃 UI 细化、加到主屏引导
- [x] 网关设置（DSH 设置页分节）+ 侧栏手机图标 → 二维码弹窗（未配置跳设置页）
- [x] Android APK 壳工程（含应用内扫码；工程源码 + CI 构建交付）

---

## 5. 服务端插件设计（`lib/index.js`）

沿用 `openclaw-dsh-bridge` 的 Cordis 插件骨架（纯 ESM、零构建、peerDeps 随 DSH 提供）。

**路由表（初版）**

| 方法   | 路径                                  | 说明                                    |
| ---- | ----------------------------------- | ------------------------------------- |
| GET  | `/dsh-mini/api/health`              | 健康检查 + 服务就绪                           |
| GET  | `/dsh-mini/api/threads`             | 会话列表                                  |
| GET  | `/dsh-mini/api/threads/:id/history` | 某会话历史消息                               |
| GET  | `/dsh-mini/api/threads/:id/stream`  | **SSE**：该会话实时事件流（**含桌面端触发的消息**，双向同步）  |
| POST | `/dsh-mini/api/threads/:id/send`    | 注入用户消息（text + 附件引用），返回 `202 Accepted` |
| POST | `/dsh-mini/api/threads/:id/stop`    | 停止本轮                                  |
| POST | `/dsh-mini/api/threads/new`         | 新建会话                                  |
| POST | `/dsh-mini/api/threads/:id/model`   | 切换模型                                  |
| GET  | `/dsh-mini/api/balance`             | 余额（复用 balance.js）                     |

**鉴权**：回环地址（127.0.0.1 / ::1）免 token；非回环必须 `Authorization: Bearer <token>` 或 `x-dsh-mini-token`，同 openclaw 模型。

**双向渲染模型（关键）**：手机对每个「打开的会话」保持一条**常驻 SSE**（`GET /stream`）。`POST /send` 只负责把 `followup` 注入 agent 并立即返回 `202 Accepted`，**渲染全部走 `/stream`**——因此桌面端 DSH 发的消息、工具调用、回复也会实时出现在手机上。手机端打开会话时先拉 `GET /history` 回填历史，再接 `/stream` 接后续增量。

**事件归一化**：把 `agent.session.events` 映射为手机端 step 类型  
`{ seq, type: "thinking"|"tool"|"assistant"|"status", text, tool?, status }`。

**依赖**：`@deepseek-ai/dsh-llm`（`createUserMessage`）、`@deepseek-ai/dsh-session`（`SessionId`）、`@deepseek-ai/dsh-settings`（`installSettingsSection`）、`@deepseek-ai/dsh-agent`（`installModelSelection`）。

---

## 6. 手机端 UI 设计（`public/` → 封进原生 Android APK，美观为硬指标）

目标：一个**高保真、可安装、液态玻璃风格**的手机 app（PWA），体验对标 Codex-Mini V5 的移动端。

- **界面结构**：线程列表 / 聊天视图 / 输入区 / 模型+推理菜单 / 停止 / 附件选择；iPad 横屏布局（M3）。
- **视觉**：液态玻璃（毛玻璃卡片、圆角、深色科技风），与 DSH Desktop 风格统一；动效克制流畅。
- **实时**：SSE 订阅当前会话事件流，思考/工具/回复分步渲染；断线指数退避重连。
- **可安装（终态）**：封装为**原生 Android APK**（WebView 壳，像 Codex-Mini），可安装到手机主屏；开发期可用手机浏览器直接开 `http://<电脑IP>:<port>/dsh-mini/` 预览（PWA 形态仅作调试）。
- **托管**：插件静态托管 `public/`，手机访问 `http://<电脑IP>:<port>/dsh-mini/` 即加载；外网经中继可达。

---

## 7. 通信协议（草版）

发消息：

```json
POST /dsh-mini/api/threads/:id/send
{ "text": "帮我把这个月日志按天分组", "attachments": ["/abs/path/in/workspace/x.png"] }
```

SSE 事件：

```
event: step
data: {"seq":12,"type":"thinking","text":"先列目录结构…"}
event: step
data: {"seq":13,"type":"tool","tool":"bash","text":"ls -R"}
event: step
data: {"seq":14,"type":"assistant","text":"已按天分组完成：\n…"}
event: status
data: {"status":"complete"}
```

---

## 8. 安全模型

- 回环免 token；非回环强制 Bearer token（环境变量 `DSH_MINI_TOKEN` 或自动生成持久化）
- 手机新建的会话只是把工作目录默认放在 `~/.dsh/dsh-mini/workspace/<key>`，**仍是电脑端 DSH 的真实会话**，会出现在 DSH 会话列表里、桌面也能打开；不触达用户桌面文件
- 可选微信式白名单：仅放行指定来源
- DSH Desktop 更新会清掉 `assets/plugins` 副本与 `cordis.patch.yml` 条目 → 提供幂等 `install.ps1` 重同步（同 openclaw）

---

## 9. 与 openclaw-dsh-bridge 的关系

- **复用**：Cordis 插件骨架、`install.ps1` 安装/白名单补丁、设置节注册、鉴权模型、agent API 用法。
- **区别**：concern 不同——openclaw 接微信/网关，本桥接手机浏览器 UI；二者独立插件，互不干扰，可并存。
- **不重复造轮子**：事件归一化、会话驱动逻辑直接借鉴 `lib/index.js`。

---

## 10. 决策记录与待确认项

### 已确认（用户 2026-08-16）

- **控制模式**：**混合**——list 全部 DSH 会话 + attach 接管桌面线程 + new 新建。关键：**不存在手机私有会话**，所有会话都是电脑端 DSH 的真实 agent 会话；手机「新建」即在电脑端 `agents.create` 一个真实会话，电脑桌面与手机**双向可见、双向可控**，事件流经 `agent.session.events` 同步给双方。
- **首版范围**：**分阶段 MVP**（M1 闭环 → M2 增强 → M3 打磨）。
- **网络访问**：**先只做局域网**（同 Wi-Fi 直连，免 token；中继后置为可选 P4）。
- **手机端**：**原生 Android APK**（WebView 壳封装，要求美观），开发期用手机网页预览。

### 待确认（已全部确认）

- 中继托管方式 → 选定 **先只做局域网**，中继后置为可选 P4（届时默认 Cloudflare Tunnel / frp 穿透，无需用户 PC 有公网 IP）。
- 手机端形态 → 选定 **原生 Android APK**（WebView 壳封装，像 Codex-Mini），开发期用手机网页预览。

### 已采纳的默认假设（非提问项，可纠正）

- **附件处理**：手机图片/文件落到会话工作区；图片优先走视觉能力（如 `dsh-vision` 的 `view_image`），文件以路径引用让 agent 读取。
- **鉴权**：回环免 token；非回环（中继/跨机）强制 Bearer token + 设备签名。

---

## 11. 实施里程碑（草案）

| 阶段             | 产出                                | 验收                         |
| -------------- | --------------------------------- | -------------------------- |
| P0 脚手架         | `dsh-mini/` 插件骨架 + `install.ps1`  | 插件装入 DSH，`/health` 可达      |
| P1 M1 闭环       | 路由 + agent 驱动 + SSE + 极简手机页       | 手机发文字、流式看到回复、可停止、可新建       |
| P2 M2 增强       | 附件 + 模型切换 + attach 桌面会话           | 图片/文件可达 agent；可切模型；可接管桌面会话 |
| P3 M3 打磨       | 推理档 + 余额圆环 + iPad 布局 + 玻璃 UI      | 体验对齐 Codex-Mini V5         |
| P4 中继（后置/可选）   | 外网中继（隧道/独立服务）+ 设备签名鉴权             | 离开局域网可用                    |
| P5 原生 APK（已确认） | WebView 壳封装 public/ 为 Android 安装包 | 可安装到手机主屏                   |

---

## 12. 命名与许可

- 产品名（暂定）：**DSH Mini（手机桥）**；插件包名 `@deepseek-ai/dsh-mini`。
- 许可：MIT（与 DSH 核心包、`openclaw-dsh-bridge` 一致）。
- 对 Codex-Mini 的借鉴仅限架构思路；按其 LICENSE 在文档保留「灵感来源：Codex-Mini by CoimgRain」署名。

---

## 13. 实现状态与已验证 API（2026-08-16）

> M1 已实现并语法校验通过：`lib/index.js`（插件）、`public/index.html`（手机端）、`scripts/install.ps1`（装载）。
> 所有 API 均对照用户**实际安装的 DSH v0.3.5（rc.6）源码**逐项验证，非凭记忆。

### 已验证的 DSH 插件 API（证据来源 = 本机 `dsh_desktop/dsh-desktop`）

| API | 形状 | 证据 |
| --- | --- | --- |
| 注册 HTTP 路由 | `ctx.webServer.register({ kind:'prefix'\|'exact', path, handler })`，包在 `ctx.effect()` 内 | `assets/plugins/dsh-file-changes/lib/index.js`、`dsh-better-sidebar/src/index.ts` |
| 订阅会话事件（官方标准） | `ctx.on('session/event', (session, event) => {})`，host 级监听收**所有**会话 | `dsh-better-sidebar`、`dsh-user-approval`、`dsh-tools` 均如此 |
| 创建会话 | `ctx.agents.create({ sessionId: SessionId(...), meta:{cwd}, agentOptions:{provider,model,reasoningEffort?}, setup })` → `{ agent }` | `node_modules/@deepseek-ai/dsh-agent/lib/index.js:543` + openclaw 验证 |
| 接管会话 | `ctx.agents.resume({ resumeSessionId, agentOptions, setup })` → `{ agent }` | 同上 `:556` + openclaw |
| 取活体 agent | `ctx.agents.get(id)` → `Agent \| undefined` | `dsh-agent/lib/types/index.d.ts:349`、`.lib/index.js:688` |
| 历史事件 | `ctx.sessions.get(id).events`（数组）+ `.header`（cwd/title/model） | `dsh-better-sidebar/lib/index.js:1951,2045` |
| 默认模型 | `ctx.agentDefaultModel.currentSelection()` → `{ provider, model, reasoningEffort? }` | `dsh-agent-default-model/README.md`、`.lib/index.js` |
| 会话清单 | `ctx.sessionPersistence.list()` → headers[] | openclaw 验证 |
| 注入消息 | `agent.followup(createUserMessage({ content:[{type:'text',text}], source:{kind:'user'} }))` | cookbook + openclaw |
| 等待空闲 / 停止 / 销毁 | `agent.whenIdle()` / `agent.cancel({ kind:'user' })` / `agent.dispose()` | `dsh-agent/lib/types/runtime-types.d.ts:80,157`；`AgentCancelCause` 见 `dsh-session` types.d.ts:118 |
| 事件类型 | `assistant/chunk`(`chunk.type`:`text-delta`/`reasoning-delta`)、`assistant/message`、`tool/call`(`data.name/arguments/callId`)、`tool/result`(`data.message.source.callId`)、`turn/start`、`turn/end` | `router-bootstrap.mjs:214-215`、`dsh-better-sidebar/lib/index.js:1852-1906` |
| 设置分节（M3 用） | `installSettingsSection(ctx, NS, Config, config, {setSource,onChange})` + `settingsNamespace` + `z`(schemastery) | `dsh-prompt-custom`、`dsh-vision`、`dsh-agent-default-model` |

### 相对初稿的实现取舍

- **事件源改用官方 `ctx.on('session/event')`**，而非初稿写的 `agent.session.events` 迭代器。官方插件（better-sidebar 等）都用全局监听，且天然覆盖「手机端 + 桌面端」双向活动——一份监听同时服务双向流式，无需为每端分别拉流。
- **SSE 鉴权兼容 `?token=`**：`EventSource` 不能设请求头，LAN 手机带 token 走 query 参数；`POST` 走 `Authorization: Bearer`。
- **单一路由前缀 `/dsh-mini` + 内部派发**：避免注册两个重叠前缀（`/dsh-mini/api` 与 `/dsh-mini`）带来的多匹配歧义。
- **M1 范围**：线程列表 / 新建 / 发文字 / 双向 SSE 流式（思考·工具·回复）/ 停止。附件、模型切换、推理档、余额、iPad 布局留 M2/M3。
- **装载**：`install.ps1` 复制到 `assets/plugins/dsh-mini` + 同步到 `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-mini`，并向 `cordis.patch.yml` 追加 `insert` 块（id `dsh-mini` / name `@deepseek-ai/dsh-mini`）。M1 不含设置分节，故不 patch `WEB_SETTINGS_NAMESPACES`（待 M3 需要时再加）。

---

## 14. v1.2.0 实现记录（2026-08-16，SPEC v0.5）

### 14.1 运行时兼容性修复（对照 0.1.0-rc.6 源码逐项验证）

| 问题 | 修复 |
| --- | --- |
| persistence header 无 title/model/updatedAt | 标题/模型改为日志 fold：`session/title` 事件取标题（live 用 `ctx.sessionTitle.get(session)`）、`request/header`/`request/context` 事件取模型；`updatedAt` 取日志最后事件时间，fallback `header.createdAt` |
| 会话日志默认 `session.jsonl.zstd`（node:zlib zstd 帧） | 自实现多帧扫描 `scanFrame` + `zstdDecompressSync` 增量解帧（dsh-side-session 同款模式），带 mtime/size/frameEnd 缓存；明文 `.jsonl` 为 fallback |
| host 重启后 `session.events` 冻结在 rehydration 边界 | 历史接口双源合并：store events + 自建 live mirror 缓冲（`ctx.on('session/event')` 按 seq 去重，每会话上限 3000 条） |
| `turn/end` reason.kind 全集 | completed/blocked/aborted/interrupted/error/max-tokens 全透传（手机端区分「本轮完成/出错/已停止」） |
| `webServer.register` 重复路由 throw | 注册挂 `ctx.effect` + 冲突时先摘旧（`ctx.webServer.prefixes.delete`）再注册（热重载自愈） |
| 无图片类事件 | 图片走 `view_image` 工具（dsh-vision）路径引用；附件注入绝对路径 + 图片提示语 |
| balance 无 host API | 桌面 client 半边监听 `window "dsh-balance-changed"` + 周期 `refreshBalance()` → `POST /balance/report`（仅回环）→ host 内存缓存 → 手机 `GET /balance` |

### 14.2 路由表（1.2.0 全集）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-mini/api/health` | 健康检查 |
| GET | `/dsh-mini/api/gateway` | 网关状态：token/lanEnabled/host/port/lanIps/reachable/url(maxUploadMb,version,bindWarn) |
| POST | `/dsh-mini/api/gateway/config` | `{lanEnabled?, maxUploadMb?}`（仅回环），持久化 `~/.dsh/dsh-mini/config.json` |
| POST | `/dsh-mini/api/gateway/token/reset` | 重置 token（仅回环），写 `~/.dsh/dsh-mini/token.txt` |
| GET | `/dsh-mini/api/models` | 模型目录：`ctx.llm.listProviders()+listModels()+resolveModelInfo()`（60s TTL 缓存），含 reasoning.efforts |
| POST | `/dsh-mini/api/upload?session=&name=` | 原始 body 上传到 `~/.dsh/dsh-mini/uploads/<sessionId>/<ts>_<name>`（限额 maxUploadMb） |
| GET | `/dsh-mini/api/threads` | 会话列表（含 zstd 日志折叠的标题/模型/updatedAt + live 标记） |
| POST | `/dsh-mini/api/threads/new` | 新建真实 DSH 会话（`agents.create`，cwd 默认 `~/.dsh/dsh-mini/workspace/<key>`） |
| POST | `/dsh-mini/api/threads/:id/attach` | 接管（`agents.resume` + `installModelSelection`） |
| GET | `/dsh-mini/api/threads/:id/history` | 历史（live：store+mirror 去重；非 live：zstd 日志折叠，上限 4000 事件） |
| GET | `/dsh-mini/api/threads/:id/stream` | SSE：`meta`（标题+模型）+ `step`（含 user/title/model 新类型） |
| POST | `/dsh-mini/api/threads/:id/send` | `{text, attachments:[{name,path}]}` → 组装引用文本 + `followup`，202 |
| POST | `/dsh-mini/api/threads/:id/stop` | `agent.cancel({kind:'user'})` |
| GET | `/dsh-mini/api/threads/:id/model` | 当前模型（优先级：手机切换存储→session requestHeader→日志 fold→全局默认，带 source） |
| POST | `/dsh-mini/api/threads/:id/model` | `{provider,model,reasoningEffort?}` 按会话切换：写 `sessions.json` + 改 live selection 对象 `.current`（下次请求生效） |
| GET | `/dsh-mini/api/balance` | 余额缓存（client 半边喂入） |
| POST | `/dsh-mini/api/balance/report` | 余额上报（仅回环，Desktop 壳 → host） |
| GET | `/dsh-mini/*` | 静态托管 `public/`（手机 UI + jsQR） |

### 14.3 模型切换机制（M2 关键设计）

- `installModelSelection(agentCtx, selection)` 仍为官方挂载点；`selection` 是**调用方持有的可变对象** `{current, assembled}`，attach/create 时创建并存于 `liveSelections` Map。
- 切换 = 写 `~/.dsh/dsh-mini/sessions.json` + 改 `selection.current`；下次 `agent/request` 快照生效；并发切换时快照先于 request config 生效，两面不分裂。
- 重启后 `request/header(reason=change)` 的 fold + 我们的 sessions.json 双保险恢复。
- 桌面端切换（`api.sessions.selectModel` RPC）走 request/header 事件，手机经 `request/header`→step `type:"model"` 实时看到徽章变化。

### 14.4 桌面 client 半边（`lib/client.js`，零构建手写 CJS）

- 槽：`sidebar.footer.action`（id `dsh-mini`，order **210**，渲染在 side-session「临时会话」order 220 上方）→ 手机图标；点击：`GET /gateway` → `lanEnabled!==true` 时**自动跳转设置页**（点 `button.VOzbGW_trigger`，fallback aria-label 匹配），否则弹二维码面板。
- 槽：`settings.section`（order 70，标签「DSH Mini 手机桥」）：局域网网关开关 / 绑定与端口 + `0.0.0.0` 告警 / 二维码预览 / token 显示与重置 / 上传限额 / 状态自检。
- 二维码：vendored MIT `qrcode-generator`（Kazuhiko Arase）内联进 bundle，canvas 渲染 `gateway.url`（含 token）。
- 余额转发：`dsh-balance-changed` 事件 + 60s 周期 `window.dshDesktop.refreshBalance()` → `POST /balance/report`。
- 组装：`src/client.js`（模板）+ `vendor/qrcode.js` → `lib/client.js`（`scripts/build.sh` 自动完成）。

### 14.5 手机端 UI（`public/index.html`，单文件）

- M1 全部保留 + 新增：附件（📎 文件多选/拍照 → `/upload` 胶囊预览 → 发送时注入引用，图片附 `view_image` 提示）、模型菜单（`/models` 目录分组 + 推理档 chips → `/model` 切换）、余额徽章（60s 轮询 + 点击刷新）、扫码连接（设置页「📷 扫码连接」：系统相机拍照 → jsQR 解码 → 自动填 URL/token；另有「📋 粘贴链接」）、实时事件（meta/model/title/user 步进）。
- jsQR（vendored MIT，`public/jsQR.min.js`）走 `<input capture>` 拍照方案——不受非安全上下文（LAN http）限制，APK WebView 同样可用。

### 14.6 APK（`apk/`，工程源码交付）

- `MainActivity.java`：WebView 壳（记住上次地址、`onShowFileChooser` 透传相机/相册、保持亮屏、返回键导航）+ `DshMiniBridge` JS 桥。
- `assets/connect.html` + `jsQR.min.js`：内置「拍照扫码/手动输入」连接页，纯 Web 解码，Android 侧零相机代码。
- Manifest：`usesCleartextTraffic` + `http(s)://…/dsh-mini` 的 VIEW intent-filter（系统相机扫桌面二维码可直接唤起本应用）。
- 构建：Android Studio / 命令行（JDK 17 + SDK 34 + Gradle 8.9）/ `.github/workflows/build-apk.yml` CI。**本机无 Java/Gradle/SDK，无法本地出包**（见 `apk/README-APK.md`）。

### 14.7 本机验证结果（2026-08-16）

- 注入器装配：host ✓ + client ✓；`smoke.ps1` 全绿：health / gateway / models(18) / new / upload / send(带附件) / history(zstd fold 标题+模型) / model get+set / attach / list / balance。
- SSE 实时投递单独验证：先连流后发消息，9 步事件（user/title/model/assistant/status），turn-end/completed，「收到收到」流式到达。
- 标题/模型折叠数据经 UTF-8 逐字符校验正确（PowerShell 控制台乱码为日志伪影）。
- 未验证项（需用户）：桌面 UI 图标/二维码/设置卡视觉与点击、真机扫码与局域网访问、余额推送实际数据、APK 构建。

### 14.8 决策记录（1.2.0 增量）

- 工作流：注入器开发（dev_inject/dev_reload 热重载），发布保留 install.ps1/zip 双通道。
- 网关设置 = 自管 `config.json`（不引入 schemastery/ctx.settings）：lanEnabled + maxUploadMb；token 沿用 token.txt。
- 「网关未配置」定义 = `lanEnabled !== true`；点击手机图标自动跳设置页。
- 二维码内容 = `http://<LAN IP>:<port>/dsh-mini/?token=<token>`（系统相机与 APK 通用）。
- 手机可达性判定 = `lanEnabled && ctx.webServer.host === '0.0.0.0'`；127.0.0.1 绑定时设置卡/弹窗显示告警与指引。
- 图片附件不落 DSH attachment 服务（无图片事件），走上传目录 + 绝对路径 + `view_image` 提示。

## 15. v1.3.0 实现记录（第三阶段：液态玻璃 UI + 原生扫码 APK，SPEC v0.6）

### 15.1 阶段决策（用户 2026-08-16 确认）

- 第三阶段 = 本轮 UI 打磨（M3 重做）：液态玻璃 + 沉浸式 + 字体中文渲染；第四阶段 = 功能扩展（真实余额数据 · PWA · iPad 完善）；**不做 P4 中继**。
- 扫码方案 = Native 实时相机 + 开源 ZXing（CameraX 预览 + zxing-core 解码，免 GMS，华为机可用）。connect.html 移除旧 jsQR 拍照选图。
- 液态玻璃范围 = 仅 `public/index.html` 聊天界面（connect.html 保持玻璃风门面但不深化）。
- webview-polish = 沉浸式状态栏/导航栏 + 字体与中文渲染优化。

### 15.2 APK 重封装（`apk/`，version 1.3.0 / versionCode 5）

- 新增 `ScanActivity.java`：CameraX `ProcessCameraProvider` 后置预览 + `ImageAnalysis`(1080x1920, KEEP_ONLY_LATEST) + zxing `QRCodeMultiReader` 解码；自绘取景框（暗角+圆角框+四角标+呼吸扫描线）；识别含 `/dsh-mini` 的 http(s) URL → 震动 + `setResult` 回主界面；`LifecycleOwner` 用 `LifecycleRegistry` 手工分发（Activity 非 AppCompatActivity 也能喂 CameraX）。
  - 编译坑三连：①`QRCodeMultiReader` 无 `setHints()`（zxing 3.5.3）→ hints 直接传 `decodeMultiple(bitmap, hints)`；②`image.getPlanes()[0]` 返回 `ImageProxy.PlaneProxy` 而非 `android.media.Image.Plane`；③CameraX `bindToLifecycle` 需要 `LifecycleOwner`。
- `MainActivity.java` 增强：沉浸式（透明状态栏/导航栏 + LAYOUT_FULLSCREEN + 去 LIGHT_STATUS_BAR）；`REQ_SCAN=4243` + `launchScanIfPermitted()` + 权限回调（拒绝对话 `__dshMiniScanCb(null,"NO_CAMERA_PERMISSION")`）；Bridge 新增 `startScan()` 与 **`getSafeTop()`**（读 `status_bar_height` 资源，供页面设 `--dsh-safe-top`）。
- `themes.xml`：透明系统栏 + `windowDrawsSystemBarBackgrounds` + `windowLayoutInDisplayCutoutMode shortEdges`。
- `connect.html` 重写：液态玻璃门面；「📷 扫码连接」→ `DshMiniBridge.startScan()`；`__dshMiniScanCb(url)` → `testThenConnect(parseTarget(url))`；无相机（模拟器/虚拟机）走地址输入 + lastUrl 回填 + `testUrl` 原生连通自检（file:// 页面 fetch 会被 CORS 拦，桥走 Java `HttpURLConnection`）。

### 15.3 手机端 UI 液态玻璃（`public/index.html`，单文件，零 JS 改动）

- 不整体重写（1094 行 JS 逻辑多），系统性替换 CSS 视觉基础：body 深色渐变 + `body::before` 固定径向光斑层（z-index 0，`.app` 升 z-index 1 透出光斑）；`--glass-border/--glass-highlight` 变量；`.topbar`(rgba .62 + blur 22px)、`.thread-menu`/`.model-menu`(rgba .66 + blur 24px saturate 160%)、`.composer`(rgba .6 + blur 20px)、`.message.user .bubble`（蓝渐变 rgba + blur 16px + 浅蓝描边）、`.markdown pre/table`、`.attach-chip`/`.process-tool` 半透明 + inset 高光；`thread-option[aria-current]`/`.model-row.sel` 白 10% 高光。
- 字体渲染：`-webkit-font-smoothing: antialiased`、`-webkit-text-size-adjust: 100%`、font-family 增补 `Noto Sans SC`、全局 `letter-spacing .01em`。
- 沉浸式安全区：Android WebView `env(safe-area-inset-top)` 恒 0 → `getSafeTop()` 桥 → 页面/连接页 JS 设 `--dsh-safe-top`，topbar height/padding、thread-menu、model-menu、设置卡 `top` 全部改 `max(env(safe-area-inset-top), var(--dsh-safe-top))`。

### 15.4 本机工具链与仓库

- 用户装 Android Studio 后本机可构建：JDK 21.0.12（Oracle）+ Gradle 8.9（腾讯镜像）+ SDK cmdline-tools 19 / platform-34 / build-tools 36；构建命令模板见 14.6 上文的 `gradle.bat --no-daemon :app:assembleDebug`。
- 源码已推送 GitHub：`hzhz314159/dsh-mini`（public，main，单 commit `ae6bf6a` v1.2.0，66 files）。系统代理 127.0.0.1:7890（Clash）下 curl 超时、Invoke-WebRequest 走 WinINET 可用；git 配 http.proxy。

### 15.5 真机验证（华为 nova7se CDY-AN00，Android 10，2026-08-16）

- USB adb 安装 `app-debug.apk` 成功；WebView 调试经 `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` + `scripts/cdp-eval.cjs`（Node 原生 WebSocket + CDP `Runtime.evaluate returnByValue awaitPromise`）执行 JS。
- CDP 实测全绿：页面自动续连 last_url（`http://192.168.2.3:46322/dsh-mini/?token=…`，install -r 保留 prefs）；`--dsh-safe-top = 108px`（桥生效）；body 渐变 + 光斑层、topbar rgba(18,22,33,.62)+blur(22px) 高 140px、composer rgba(28,33,46,.6)+blur(20px)、user bubble 蓝渐变+blur(16px)+浅蓝描边——全部 computed 样式符合预期。
- `ScanActivity` 为 `exported=false`（仅应用内 `startActivityForResult` 启动），shell 直启被系统 SecurityException 拒绝属预期安全行为；扫码实测需用户真机操作（相机权限弹窗）。
- 构建迭代 5 次全绿（`BUILD SUCCESSFUL`），产物 `apk/app/build/outputs/apk/debug/app-debug.apk`。

### 15.6 待用户复测项（第三阶段）

1. 真机「扫码连接」：相机权限授权弹窗 → CameraX 实时扫码 → 自动进手机端页。
2. 真机沉浸式观感：状态栏/导航栏透明、刘海避开、液态玻璃视觉效果。
3. 虚拟机/模拟器调试（无相机）：地址输入 + `testUrl` 自检 → 连接（见 `apk/README-APK.md`「虚拟机调试」）。

## 16. v1.3.x 问题清单与解决方案设计（2026-08-16，用户反馈 5 项）

> 本轮只做方案设计，用户确认后再实施。证据均来自真机 CDP 实测与源码阅读。

### 16.1 问题① 页面不能自适应适配

**现状证据**：手机端 UI 尺寸多为固定 px（`--topbar-row-height: 52px`、输入 15px、`min(760px, 86%)` 等）；仅 3 个断点：`max-width:700px` 紧凑、`min-width:900px` iPad 双栏、横屏未处理。Android WebView `env(safe-area-inset-bottom)` 恒为 0（与顶部同坑：只有 `--dsh-safe-top` 桥，无 `--dsh-safe-bottom`）→ 底部手势条区域可能被遮挡。小屏（≤360px）chip 溢出、大屏（平板/横屏）留白不均衡。

**方案（待确认）**：
1. 安全区补齐：Bridge 新增 `getSafeBottom()`（读 `navigation_bar_height`），页面 JS 设 `--dsh-safe-bottom`；`--composer-bottom-pad` 等所有底部偏移改 `max(env(safe-area-inset-bottom), var(--dsh-safe-bottom))`；键盘位移公式在原有基础上再叠加 safe-bottom。
2. 尺寸归一化：关键尺寸改 `clamp()`（如 `--topbar-row-height: clamp(44px, 12vw, 56px)`、气泡/字体 `clamp(14px, 4.2vw, 17px)`），小屏自动收敛、平板放大，不再依赖单一断点。
3. 断点扩展：`≤360px` 更紧凑（隐藏次要 chip、行距收紧）；`700–900px` 中间档（内容宽度 `min(100vw-32px, 720px)` 居中）；继续 `≥900px` 双栏；横屏（`orientation:landscape`）时 content 居中限宽 + 顶栏保留。
4. 真机验收：360/375/412/768/1024 五档直接 CDP 注入视口验证无溢出/无遮挡。

### 16.2 问题② 没有思考折叠 / 工具调用折叠 / 没有任务表

**现状证据**：`applyStep`（public/index.html:659+）将 thinking 渲染为 `process-thinking` 直出（不折叠），工具渲染为 `process-tool` 胶囊横滚（不折叠），均无头部/展开收起；`KNOWN_SESSION_EVENT_TYPES` 无 plan/任务事件——SSE 里只有 thinking/tool/assistant/user/title/model/status。

**方案（待确认）**：
1. **思考折叠**：`curThinking` 块包一层 `<details class="think-block">`（或自定义折叠头）：头部「💭 思考过程 + 耗时/轮次」，默认收起，展开显示流式内容；流式期间自动展开（`update` 时若未用户手动收起则 open），结束后保持用户最后状态。
2. **工具调用折叠**：每条 assistant 消息的 `process-tool-row` 改为可折叠块（头部「🛠 工具调用 ×N」+ 状态摘要 ✓/✕/…，默认收起，展开显示胶囊明细）。
3. **任务表**：UI 从 SSE 流聚合（host 不加事件）——`status:turn-start` 建任务容器，`tool:call/result` 逐条填充（图标+工具名+状态：进行中/完成/失败），`turn-end` 收束并显示「任务 ×N · 完成 M」。控件样式复用 thread-menu 玻璃卡；长会话分片渲染时任务表也折叠省空间。
4. 验收：一轮含 2+ 工具调用的回复，思考/工具默认折叠、可展开、任务表逐条更新。

### 16.3 问题③ 唤起键盘后输入框不随键盘上滚

**现状证据（根因已坐实）**：`public/index.html:1144-1151` 的位移公式 `shift = Math.max(0, vv.height - window.innerHeight)` ——**方向写反**。`interactive-widget=overlays-content` 下键盘弹起时 `visualViewport.height` 缩小（800→560）而 `window.innerHeight` 不变 → `shift = 560-800 = -240 → max(0,-240)=0` → 恒 0，composer 不移位，键盘盖住输入框。

**方案（待确认）**：
1. 修正公式：`shift = Math.max(0, window.innerHeight - vv.height)`，并监听 `vv.resize` + `window.resize`（兜底 WebView 不触发 vv 事件的场景）；位移叠加 safe-bottom。
2. APK 侧：MainActivity `windowSoftInputMode` 显式 `adjustResize`（键盘弹起重排 WebView 视口，双重保险）；`android:windowSoftInputMode="adjustResize"` 写入 Manifest。
3. 真机验收：输入框聚焦 → composer 平滑上移贴键盘顶（实测 keyboard-open 类 + shift px 正确、blur 回位）。

### 16.4 问题④ 历史会话载入过于缓慢

**现状证据（瓶颈定位）**：真机 CDP 实测长会话 `4597 steps / 282KB`，网络仅 **119ms**；卡顿在前端：`loadHistory` 逐 step `applyStep` → 每 step 一次 `scrollDown()`（`scrollTop=scrollHeight` 强制同步布局 ×4597）→ DOM 反复 append/重排，数秒白屏。

**方案（待确认，按收益排序）**：
1. **渲染期挂起滚动**（见效最快）：标记 `renderingHistory=true`，历史批量渲染期间跳过全部 `scrollDown()`，末尾一次性 `scrollTop=scrollHeight`；同步合并相邻同类型 step（assistant 连续 N 条 → 一条）。
2. **分片渲染**：`requestAnimationFrame` 每帧处理 ≤200 个 step（帧间让出主线程），进度条（「载入历史 45%…」）。
3. **步数降载（host 侧）**：`/history` 响应将相邻同 type/同消息 step 合并为 `{type, text[]}` 或直接返回平铺文本段，4597 条 → 数百条；desktop 端无影响（只改 /dsh-mini 私有端点）。
4. **本地缓存**：`localStorage` 缓存 `history:<id>`（含 updatedAt/step 数），会话未变化时秒开，SSE 增量补齐（依赖 live 双源去重已具备）。
5. 验收：4597-step 会话打开 <1s（CDP 计时），首屏无需等待全部渲染。

### 16.5 问题⑤ 手机上新建的会话电脑端没有同步

**现状证据与根因推断**：`newSession`（lib/index.js:788+）用 `agents.create`（core DSH 服务，必然产生 session 事件），创建会话 `meta.cwd = ~/.dsh/dsh-mini/workspace/<hash>`（非桌面工作区）→ 桌面会话列表按工作区维度展示（官方 UI 以 workspace 为容器），**手机工作区不在桌面当前工作区 → 桌面看不到**；此外手机端「新建」后无任何桌面可见反馈。

**方案（待确认，二选一或组合）**：
1. **cwd 对齐桌面工作区（推荐）**：手机「新建会话」时 host 默认取桌面当前工作区：`ctx.get('workspaces')`（若服务存在）→ 当前 workspace 路径；无则取**桌面最近活跃会话的 cwd** 或 `process.cwd()`；仍无则回退 MINI_HOME/workspace。→ 新会话落在桌面当前工作区，侧栏即时可见。
2. **工作区选择器**：手机端新建弹窗列出最近工作区（host 新增 `GET /workspaces` 端点：聚合桌面 workspace 服务 + 历史会话 cwd 去重），用户自选。
3. **联动提示**：新建成功 → 手机端提示 + client 半边监听 `session/event`（session 创建类事件）→ 桌面侧栏无感刷新（若事件桥可用）；最低限度在手机端显示「已创建：可在桌面左侧栏查看」。
4. 验收：手机新建 → 桌面侧栏 5s 内出现该会话（同工作区）；点开即双向可用。

### 16.6 实施顺序与范围

- 顺序：③（根因一行，收益最大）→ ④（1+2，立刻提速）→ ②（折叠/任务表 UI）→ ①（安全区+clamp+断点）→ ⑤（同步）。
- host 改动：仅 16.4-3 步数合并与 16.5（newSession cwd 对齐 + 可选 /workspaces 端点），其余纯 `public/index.html` + APK（getSafeBottom 桥 + adjustResize）。
- 不动：lib/index.js 事件系统、桌面 client 半边结构（除非 16.5-3 需要）。

### 16.7 实施记录（v1.3.x，用户确认方案后完成）

**用户决策**：⑤=仅工作区选择器（不做 cwd 自动对齐）；②=三件都做；④=全套 4 项。

**③ 键盘修复**（public/index.html + APK）：
- `shift = Math.max(0, window.innerHeight - vv.height + safeBottom())`（原 `vv.height - innerHeight` 方向反恒 0）；`vv.resize` + `vv.scroll` + `window.resize` 三监听；`--keyboard-shift` 叠加 `--dsh-safe-bottom`。
- MainActivity `setSoftInputMode(SOFT_INPUT_ADJUST_RESIZE)` + Manifest `android:windowSoftInputMode="adjustResize"`。
- Bridge 新增 `getSafeBottom()`（navigation_bar_height，真机实测 120px）；`initSafeTop` 扩为 `initSafeAreas`（同时设 `--dsh-safe-top/--dsh-safe-bottom`）；`--composer-bottom-pad` 改 `max(56px, calc(max(env(safe-area-inset-bottom), var(--dsh-safe-bottom)) + 30px))`。

**④ 历史提速**（lib/index.js + public/index.html）：
- host：`buildSegments(steps)` 合并相邻 thinking/assistant/tool 段（各带 `seqMax`），`getHistory` 返回 `{steps, segments, revision}`；实测 19740 steps → 219 segments（85×），host 响应 482ms。
- 前端：`renderSegments(segs, batched)` rAF 每帧 ≤100 段；`renderBatch` 挂起 scrollDown（applyStep/scrollDown 均判）；`lastSeqMax` 增量基准（applyStep 同步推进）；`loadHistory` 三态：cacheHit（localStorage `dshhist:<id>` {rev,segments,title,model} 秒开渲染 + 后台 fetch 核 rev 相同不重渲）/ 全量 / merge（`segments.filter(sg => sg.seqMax > lastSeqMax)` 只补新段）。
- 实测：15380-step 会话分片渲染 ~1s，滚底正常。
- **SSE 流式节流**（防 WebView 卡死，曾实测卡死）：step 事件进 `sseQueue`，`setTimeout 50ms` 批量 `sseFlush`（renderBatch 包批 + 一次 scrollDown）。

**② 折叠 + 任务表**（public/index.html）：
- `newThinkingBlock(expand)`：`.think-block`（toggle「💭 思考过程」+ `.think-body` max-height 过渡，`thinkUserCollapsed` 记录用户手动选择）；历史/批量默认折叠、live 流式默认展开、turn-end `closeThinkBlocks()`（未手动操作才自动折叠）。
- 工具折叠：`.tools-block`（toggle「🛠 工具调用 ×N」+ `.tools-body` 默认 closed），`renderToolPill` 计数。
- 任务表：`taskCardReset/Add/Finish`（turn-start 建卡、tool call/result 填充「进行中/完成/失败」（callId 匹配，无则顺序）、turn-end 收束「×N · 完成 M」+ closed）；**仅 live applyStep 触发**，历史批量渲染不建卡。
- **关键 bug 修复**：原 `newAssistantBlock` 里 `curThinking.remove()` 把思考块从消息流删除（旧「思考并入回复」语义残留）→ 改为收成折叠态保留在回复上方。

**① 自适应**（public/index.html）：
- `--topbar-row-height: clamp(44px, 11vw, 52px)`；新增 700–900px 中间档（内容限宽 720px 居中）、≤360px 紧凑档（40px 行高、chip 收敛）、横屏矮视口兜底档（居中限宽 680px）；真机 360px 宽命中紧凑档（topbarH=40px）。

**⑤ 工作区选择器**（lib/index.js + public/index.html）：
- host `GET /dsh-mini/api/workspaces`：`listWorkspaces(ctx)` = 默认工作区（MINI_HOME/workspace）+ `ctx.get("workspaceRegistry").list()`（实测返回桌面「DSH Zone」）+ 历史会话 cwd 去重（排除纯 hash 目录）。
- 手机端：`openWsPicker()` bottom-sheet（`.ws-menu` 玻璃卡，safe-bottom 定位）→ 选工作区 → `newThreadWithCwd(cwd)` POST /threads/new {cwd} → 新会话落所选工作区 → 桌面侧栏按工作区可见。实测 6 行（默认 + DSH Zone + 4 历史）。

**品牌统一**：桌面 client 半边全部用户可见文案改 **DSH-Mobile**（二维码弹窗标题「手机连接 DSH-Mobile」、扫码提示、设置卡 label「DSH-Mobile 手机桥」）；README 标题、package.json description 同步；包名 `@deepseek-ai/dsh-mini` 与装配链不动。

**真机验证（华为 nova7se，Android 10）全绿**：历史 85× 压缩分片渲染滚底 ✓；think=9 保留折叠 + 点击展开（212 字内容）✓；tools 全折叠 ✓；任务卡 live 出现 + turn-end 收束 ✓；SSE 节流（esState=1 不断流）✓；ws 选择器 6 行 ✓；safe-bottom=120px ✓；紧凑档命中 ✓。桌面端 DSH-Mobile 改名待用户刷新可见（键盘随动需真机实测）。

---

## 17. 用户反馈：页面尺寸不对 / 键盘上滚不生效 / 学 Codex-Mini 折叠与任务显示（调研完成，方案待确认）

用户原话：「页面尺寸不对，键盘上滚不生效；https://github.com/CoimgRain/Codex-Mini 自习学习人家的折叠和任务显示是怎么做的，整理进 spec 文档，给我改动计划，有不明白的问我」

### 17.1 页面尺寸根因（CDP 真机坐实）

- 实测：innerW=360 innerH=800 dpr=3（screenH=800=2400/3）；appH=800 正常；**topbarH=138px 超高、composerH=218px 超大**（thread 区仅 443px）。
- 根因：Bridge `getSafeTop()`=108、`getSafeBottom()`=120 返回**物理像素**，页面 JS 直接当 CSS px 用（未除 dpr=3）。应为 36px / 40px。后果：topbar padding 108px（应 36）、`--composer-bottom-pad=max(56px, 120+30)=150px`（应 70px）→ 顶栏太高、底部大留白、内容区被压扁。
- 修复：`initSafeAreas` 内 `px / window.devicePixelRatio`（兜底 ≥1）。

### 17.2 键盘上滚不生效根因（CDP 真机坐实）

- 实测：聚焦 textarea 键盘弹起后 innerHeight=800 **不变**、vv.height=800 **不变**（vv.resize 永不触发）→ shift 恒 0。
- 根因：华为 WebView 中 `SOFT_INPUT_ADJUST_RESIZE` 与沉浸式 `SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN/LAYOUT_HIDE_NAVIGATION` **冲突被系统忽略**（flag 组合官方不兼容）。
- 修复（正解）：**native 布局监听桥**——MainActivity `decorView.getViewTreeObserver().addOnGlobalLayoutListener` + `getWindowVisibleDisplayFrame()`（与软键盘模式无关，永远反映可见区域）→ 键盘 CSS px = `(screenH - visibleBottom) / density` → `web.evaluateJavascript("window.__dshSetKb && window.__dshSetKb(" + cssPx + ")")`；页面 `window.__dshSetKb(cssPx)` 设 `--keyboard-shift` + `keyboard-open` class；vv 逻辑保留作 iOS/Chrome 兜底。composer-shell transform 已接 `--keyboard-shift`（public/index.html :230-234）。

### 17.3 Codex-Mini 折叠/任务实现调研（v5.5.4，克隆于 E:\DSH Zone\work\codex-mini-ref）

核心文件：`macos/CodexMini/CodexMini/Resources/CodexMiniProject/public/index.html`（5228 行）+ server.js。

- **无独立任务卡**。任务显示 = process feed 内 start/complete/error 状态行 + 工具胶囊行 + 线程列表状态字段。
- server.js step.kind 模型（:1641-1662）：`failureText→{kind:'error',label:'失败'}`；`payload.type==='task_started'→{kind:'start',label:'开始',text:'开始处理这条消息'}`；`'task_complete'→{kind:'complete',label:'完成',text:'回复完成'}`；`'agent_reasoning'→{kind:'thinking',label:'思考'}`；`'agent_tool_call'→{kind:'tool',label:'工具',callId:call_id}`；assistant phase commentary→thinking；phase final_answer→{kind:'final'}。turn 聚合（:1787-1813）：statusSteps 有序聚合 start/thinking/tool/complete/error；failed=completed&&!final → 兜底 push error step；status 字段 running/complete/error/idle 供线程列表。
- 前端折叠（index.html :3528-3566 `addDetails(message, steps)`）：消息尾部建 `<details class="process"><summary>查看详细过程</summary><ul class="steps"><li>标签：文本</li>…</ul></details>`（默认收起=无 open 属性，追加到 .bubble-wrap）；`captureVisibleProcessSteps` 扫描 bubble 内 .process-start/complete/error/thinking/tool 节点 → {label:思考/工具/开始/完成/失败, text}，无过程但有正文 →「已生成内容」。live 时先 `renderProcessSteps(el, steps)`（:3283-3377）在 bubble 内渲染 process-feed（.process-thinking markdown-body + .process-tool-row 横向滚动胶囊行 + 事件行，带 FLIP 位移动画），完成后 addDetails 折叠收纳。
- CSS（:1081-1144）：.process-feed grid gap0、`>+*` margin-top 15px、工具行 margin-top 2px；.process-thinking 15px/1.66；.process-tool 胶囊（flex none, padding 4px 8px, border-radius 999px, 11px, faint 色）；`details.process {margin-top:10px; color:var(--muted); font-size:12px}`；summary cursor:pointer；.steps {max-height:180px; overflow:auto; border-top:1px solid var(--line)}。
- **与我们的差异**：我们 = think-block + tools-block + task-card 三件套（视觉碎）；Codex = 每轮一个 details.process 收纳全部过程（思考+工具+状态行），消息流干净。

### 17.4 改动计划（待用户确认，见下方问题）

1. **页面尺寸**：initSafeAreas 除 dpr；核对 topbar/composer 实际高度恢复（topbar≈76px、composer pad 70px）。
2. **键盘**：MainActivity 布局监听桥 + 页面 `__dshSetKb` 接线（保留 vv 兜底）。
3. **折叠/任务（方案 A 完全 Codex 式 / 方案 B 混合保留任务卡）**：
   - A：删 think-block/tools-block/task-card；每轮 assistant 消息 = 正文 bubble + details.process（summary「查看详细过程」+ 可选计数徽标「思考×N · 工具×M」）；live 展开 feed（thinking 块 + 工具胶囊行 + start/complete/error 状态行），turn-end 收折；历史直接折叠态渲染（按 turn 分组，复用 segments 的 status 段）；error 映射（reason=error/aborted/blocked/interrupted → 「失败/已停止」行）；线程列表 title-dot 增加 error 红点（可选）。
   - B：保留任务卡，仅把 think/tools 并入每轮 details。
4. 真机全验证 + SPEC 17.5 记录 + APK 重建 + zip/git 交付。

### 17.5 实施记录（v1.3.1，三项全做，用户确认方案 A + 原生键盘桥 + dpr 修复）

**① 页面尺寸修复（public/index.html initSafeAreas）**：
- `px / window.devicePixelRatio`（兜底 1）。真机实测：safeTop 108→**36px**、safeBottom 120→**40px**、topbarH 138→**66px**、composerH 218→**138px**、thread 区 443→**596px**。connect.html 同步修（.wrap padding）。

**② 键盘原生布局监听桥（MainActivity.java + public/index.html）**：
- MainActivity：`web.getViewTreeObserver().addOnGlobalLayoutListener` + `decor.getWindowVisibleDisplayFrame(kbFrame)`；`kbPx = max(0, decor.getHeight() - kbFrame.bottom)`；`cssPx = kbPx > 150 ? round(kbPx/density) : 0`；变化才 `evaluateJavascript("window.__dshSetKb && window.__dshSetKb(" + cssPx + ")")`。ADJUST_RESIZE 保留（不冲突时兜底）。
- 页面：`window.__dshSetKb(cssPx)` 设 `--keyboard-shift` + `keyboard-open` class；vv 逻辑改走同一函数（iOS/Chrome 兜底）。真机实测：focus → kbOpen=true、shift=**278px**（华为键盘 834px 物理 / dpr 3）。

**③ 折叠/任务对齐 Codex-Mini（方案 A，public/index.html 大改）**：
- 删除 think-block/tools-block/task-card 三件套（CSS+JS 全清）。
- 每轮 assistant 消息 = `.bubble`（正文）+ `details.process`（summary「查看详细过程」+ 右侧 `.ps-c` 计数徽标「思考 N · 工具 M」）。
- 新函数：`ensureAssistant(liveOpen)`（live open / 历史无 open）、`updatePsCount`、`appendThinking`（feed 内 .process-thinking 累积）、`appendTool`（.process-tool-row 横向滚动胶囊）、`appendStatusRow`（.ps-start/.ps-complete/.ps-error）、`finishTurn(m, reason)`（complete→「回复完成」行；error/aborted/blocked/interrupted→「已停止 + reason」行；最后 removeAttribute("open") 收折）。
- turn-start → setBusy(true) + start 行「开始处理这条消息」；turn-end → 收束 + 收折 + notice。applyStep/renderSegment 双路径同步重写（历史渲染 batched → 折叠态；SSE live → 展开态）。`s._hist` 标志控制 applyStep 历史路径展开与否。
- 动画：.process-thinking/.ps-start/.ps-complete/.ps-error 加 pillIn。
- **附带修复真实 bug**：`openChat` 未重置 `busy` → 切换会话后 send() 因 busy=true 直接 return（连本地 user 消息都不渲染）→ openChat 加 `setBusy(false)`。

**真机验证（华为 nova7se CDY-AN00，v1.3.1 APK）全绿**：safe 36/40px ✓ topbar 66px/thread 596px ✓ 键盘 shift=278px ✓ 历史 37/98 轮全部折叠 details ✓ 计数徽标动态 ✓ live 展开（思考 335 段累积中 lastOpen=true）✓ turn-end 收折 + ps-complete ✓ 新会话发送正常（busy 修复）✓。

## 18. 手机页 v2：GUI 同款深色视觉重构（2026-08-16，SPEC v0.7）

### 18.1 决策（用户确认）
- 用户原话：「我有个想法，如果直接用DSH的GUI，手机端打开是否可行？」→ 三问确认 path=自定义「将DSH-mini改成官方GUI页面，走dsh-mini网关带token」；scope=[聊天核心, 模型切换, 工作区切换, 附件, 余额]；visual=GUI 同款深色玻璃。
- **最终定案（用户定向澄清）**：「就是与官方GUI的独立手机页，不受官方影响」→ 独立手机页 v2，复刻官方 GUI 视觉与核心功能子集，走 dsh-mini 网关+token，官方升级不影响。
- 调研（SPEC-GUI-mobile.md 第 1-6 节，源码级）：GUI 无媒体查询（三栏 grid + concession 链）、LAN 无鉴权、WebView 同源 SSE/RPC 可用 → 方案 C（官方响应式改造）不可维护，取独立实现。

### 18.2 官方设计 token 提取（dsh-client-ui-theme/lib/styles/design-platform.css 深色主题 + base.css）
- 手机页 `:root` 直接注入官方 token 深色子集（--dsw-bg-base=rgb(21,21,23) bluish-950、--dsw-bg-layer-1..3=875/850/800(35,35,36/44,44,46/53,54,56)、--dsw-specific-bubble=850(44,44,46)、--dsw-specific-input-major=850、--dsw-specific-menu=800、--dsw-specific-sidebar=bluish-900(27,27,28)、--dsw-border-l1..l4=white 6/12/16/20%、--dsw-label-primary/secondary/tertiary/caption=bluish-50/300/400/600、--dsw-button-info-fill/hover=deepseek-400(103,158,254)/500(65,118,230)、--dsw-state-success=green-500(34,197,94)、--dsw-state-error=red-400(242,90,90)、--dsw-amber-400(247,173,49)、--dsw-markdown-code-block=900/inline=850、--dsw-font-family 官方栈、--dsw-ease=cubic-bezier(.4,0,.2,1) Material、--dsw-dur .2s）。
- 功能变量别名保留原名（--bg/--text/--muted/--faint/--panel/--user/--accent/--ok/--blue/--glass-border 等 → 指向官方 token），**HTML/JS 零改动**。

### 18.3 组件对齐清单（public/index.html）
- body：渐变深蓝灰 + 三光斑层 → **纯色 bg-base rgb(21,21,23)**（删除 body::before）。
- topbar：半透明蓝+blur → **sidebar-fill rgb(27,27,28) 实心** + border-l2。
- 用户气泡：蓝渐变+玻璃 → **specific-bubble rgb(44,44,46) 实心 + 22px 圆角 + border-l2-thin**（对齐官方 gdEzaW_bubble：官方=实心深灰+22px 圆角+padding 10px 16px，非渐变）。
- composer 卡：半透明+blur → **input-major rgb(44,44,46) + 22px 圆角 + border-l2-thin**（对齐官方 uV2eYG_card）。
- 发送钮：白底黑字 → **deepseek-400 蓝底白字**，:active 变 deepseek-500。
- 三个菜单（thread/model/ws）：半透明+blur → **specific-menu rgb(53,54,56) 实心 + 18px 圆角 + border-l2**。
- markdown：pre→code-block(27,27,28)、inline code→850、blockquote/table 边框→border-l2、链接→deepseek-300、表头→layer-3。
- 折叠 details.process / 工具胶囊 / 附件胶囊 / ws-row / effort-chip / model-row.sel / scrim：全部 rgba 硬编码 → 官方 token。
- 动画：所有 cubic-bezier(.22,.61,.36,1) → **官方 Material easing var(--dsw-ease)**，时长对齐 .2s/.28s。
- 字体：官方栈（-apple-system,…PingFang SC…）；textarea 16px/1.4 官方 font-family。
- manifest 主题/背景色 #0b0e15 → #151517（同步顶部 meta theme-color）。

### 18.4 验证
- 本地 _verify-html.cjs：JS 语法 OK、CSS 括号平衡、var() 引用完整性（used 全定义）。
- 真机 CDP（华为 nova7se，PID 转发 9222）：body=rgb(21,21,23) ✓ topbar=rgb(27,27,28) ✓ composer=rgb(44,44,46) ✓ send=rgb(103,158,254) ✓ font=官方栈 ✓ 用户气泡=rgb(44,44,46)+22px+border rgba(255,255,255,.06) ✓。
- 功能回归（CDP/SSE）：线程/发送/SSE/模型菜单沿用原 JS 未动，风险面仅视觉层。


