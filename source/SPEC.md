# DSH Mini（手机桥）技术文档 — Codex-Mini 同款适配 DeepSeek Harness Desktop

> 状态：SPEC v0.4（M1 已实现并通过语法校验；API 已对照本机 DSH v0.3.5 源码逐项验证，见第 13 节） 
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

### M1 — 核心闭环（必做）

- [ ] 线程列表：列出 DSH 已有会话（live + 持久化），含 id / 标题 / 工作目录 / 模型
- [ ] 发文字消息 → `agent.followup` 注入当前/指定会话
- [ ] 流式回复：SSE 推送 `agent.session.events`，手机端实时渲染思考 / 工具 / 最终答案
- [ ] 停止生成：`agent` 终止本轮
- [ ] 新建会话：`agents.create`

### M2 — 同款增强

- [ ] 附件：手机发图片 / 文件，落到会话工作区并以文件引用或视觉能力送达 agent
- [ ] 模型切换：`agent` 切换 provider/model
- [ ] 会话接管（attach）：手机接管桌面上正在用的 DSH 会话（用 `resumeSessionId`）

### M3 — 体验打磨（对齐 Codex-Mini V5）

- [ ] 推理档切换（如 DSH 支持）
- [ ] 余额圆环：复用 `dsh-desktop/balance.js` 显示「本轮 ¥X · 余额 ¥Y」
- [ ] iPad / 横屏布局
- [ ] 液态玻璃 UI 细化、加到主屏引导

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

