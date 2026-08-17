# DSH-Mobile v1.4.0 — 官方 GUI 完整移植 SPEC

> 日期：2026-08-17 · SPEC v0.8 · 取代 v1.3.x 自建手机页方案

## 1. 目标

将 DSH 桌面端官方 GUI **完整照搬**到手机端：手机 WebView 打开 `http://<LAN IP>:46322/?token=…`，根路径直接渲染官方 GUI 全部功能，通过 dsh-mini 自建网关（RPC + WS）驱动真实 DSH 运行时。

**不改动官方 bundle 一个字节**——前端 bundle 是锁死快照，后端 API 由 dsh-mini 1:1 自建。官方升级不影响手机端，手机端不依赖官方 host。

## 2. 定案约束（用户确认 10 项）

| # | 决策 | 含义 |
|---|---|---|
| 1 | 传输层复用 dsh-mini 网关 | `http://<LAN IP>:46322/?token=…`，根路径直出 GUI |
| 2 | 前端静态打包进 dsh-mini | 官方 dist + 37 个 @deepseek-ai/dsh-* 核心 bundle |
| 3 | 不做插件、API 自建 | 60 个 RPC + 双 WS 事件流由 dsh-mini host 自建 |
| 4 | token 唯一鉴权 | 去 PRIVILEGED_METHODS loopback 强制，无状态签名 cookie |
| 5 | 锁死快照 | 不写同步脚本，不跟随官方更新 |
| 6 | 旧手机页直接替换 | `/dsh-mini/` 不再服务旧页面，旧 API 路径保留兼容 |
| 7 | 设置照搬官方白名单 | 8 命名空间（agent-loop/shell/locale/permission/ui-conversation/ui-theme/web-search-deepseek/agent-preset） |
| 8 | 子代理面板纳入首发 | |
| 9 | APK 连接流程不变 | 地址输入+扫码 → 网关根路径带 token |
| 10 | 版本 1.4.0 | zip = `DSH-Mobile-v1.4.0.zip` |

## 3. 架构

```
手机 WebView
  │  http://192.168.2.3:46322/?token=xxx
  ▼
dsh-mini 网关 (lib/index.js startGateway, node:http server :46322)
  ├── GET /                  → GUI index.html (注入 polyfill + __DSH_BOOT__)
  ├── GET /assets/*          → gui/dist/assets/ 静态
  ├── GET /plugins/<id>/client.js?rev= → gui/bundles/<id>/client.js
  ├── POST /api/<method>     → handleGuiPost → lib/gui-api.js (60 RPC)
  ├── WS  /api/events.mux    → lib/gui-ws.js startMux (session/event 增量)
  ├── WS  /api/events.host   → lib/gui-ws.js startHost (workspace/session 增量)
  └── /dsh-mini/*            → proxyToUpstream (旧协议兼容, 加 x-dsh-mini-gateway:1)
  │
  ▼  ctx 服务（与官方 host 同源）
  ctx.sessions / ctx.agents / ctx.llm / ctx.settings / ctx.workspaceRegistry
  ctx.subagents / ctx.agentDefaultModel / ctx.sessionPersistence / ctx.attachments
  ctx.sessionTitle / ctx.sessionQuery / ctx.goals / ctx.skills / ctx.agentPresets
```

**核心设计**：手机页与 API 完全同源于网关端口（官方前端用 `location.origin` 相对路径）→ 官方 bundle 零改动。桌面主端口 46321 官方 GUI 不动，互不干扰。

## 4. 资产采集（阶段0，已完成）

- 采集范围：37 个官方 `@deepseek-ai/dsh-*` 核心 bundle（排除全部第三方 + dsh-mini 自身）
- 脚本 `scripts/collect-gui-assets.cjs`：从 `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\` 复制
- 产物目录 `E:\DSH Zone\dsh-mini\gui\`：
  - `dist/` — 89 文件 4.41MB（index.html + assets/* + manifest.webmanifest + favicon.svg）
  - `bundles/<id>/client.js` — 37 个共 2.92MB
  - `manifest.json` — rev=d0c6b5ce66b5，37 entries（id/url/rev/inject/immediately）
- revMismatch=0（本地与运行时逐字节同版）
- dist/index.html 结构：绝对路径 `/assets/*` + `<div id="root">`，boot 注入到 `<head>` 首位

## 5. 网关扩展（阶段1，已完成）

### 5.1 静态服务
- `buildGuiledIndex()`：读 `gui/dist/index.html`，注入 polyfill script + `window.__DSH_BOOT__` script 到 `<head>`，按 manifest rev 缓存
- `serveGuiStatic()`：MIME 表 + Cache-Control + 防穿越 safeResolve
- `serveGui()`：`/`→html、`/assets/*`→dist、`/manifest.webmanifest`、`/favicon.svg`、`/plugins/<id>/client.js`→bundles

### 5.2 鉴权：无状态签名 cookie
- `?token=xxx` 匹配 `effectiveToken()` → 发 HttpOnly cookie `dsh_mini_sid=<expHex>.<hmacHex>`
- HMAC = `HMAC-SHA256(当前token, expiry)`，`timingSafeEqual` 校验
- **无内存 Map** → 热重载/重启后 cookie 依然有效，token 重置即全部失效
- 回环直连（127.0.0.1 且无 x-dsh-mini-gateway 头）免鉴权
- LAN 需会话 cookie 或 token query，否则 403 简易页面

### 5.3 旧协议兼容
- `proxyToUpstream()`：`/dsh-mini/*` 反向代理到主端口 46321，加 `x-dsh-mini-gateway:1` 头，SSE pipe 透传
- APK connect 自检依赖 `/dsh-mini/api/health`（保留）

## 6. RPC 自建（阶段2，已完成）

### 6.1 契约
- 信封：`{type:'client-request',rpcId,method,payload}` → `{type:'server-response',rpcId,result:{ok,value|error:{code,message,details?}}}`
- 业务错误恒 HTTP 200，carrier 错误 400
- 错误码必须在官方 `rpcErrorSchema` 枚举内（discriminatedUnion），details 必修

### 6.2 60 方法清单
| 域 | 方法 | 映射 |
|---|---|---|
| session | list/search/create/history/models/selectModel/rename/fork/prompt/attachment/cancel/updateQueue | ctx.sessions + ctx.agents + ctx.llm + ctx.sessionTitle + ctx.attachments + ensureSession |
| subagent | list/history/prompt/cancel | ctx.subagents |
| workspace | list/create/rename/delete/insertBefore/insertSessionBefore/archiveSession | ctx.workspaceRegistry |
| skill | list | ctx.skills |
| agentPreset | list/read-copy | ctx.agentPresets（只读） |
| goal | list/edit/pause/resume/clear | ctx.goals |
| settings | describe/get/update/replace/mutate | ctx.settings（白名单 8 ns） |
| credentials | list/delete | ctx.credentials（只读+删） |
| llm | providers/models/discoverModels | ctx.llm |
| host | describe/pickDirectory/listDirectory/openPath | 降级（空结构/path:null/拒绝） |
| Typert remote | commands.list/execute, goals.edit, messageFeedback.put/delete/list, pluginInventory.list, dynamicCordisRunner.inventory/syncInspectManifest/getClientCode/reportRenderFailure/reportClientGuardFailure/resolveInspectQuery/resolveRequestRun/settleUserRun/stopFromPanel/undefineFromPanel/runHostHalf/invoke | 降级实现 |

### 6.3 关键实现
- `ensureSession(ctx,sessionId,cwd,presetId)`：live agent 直返 → findSessionFile 有记录则 `agents.resume` → 否则 `agents.create{sessionId,meta:{cwd,agentPreset},agentOptions,setup}`（installModelSelection 挂 setup）
- `session.prompt`：payload = `{sessionId, mode:'queue'|'steer', content:[{type:'text',text}|{type:'image',mediaType,data}], clientTimeZone?}`；`createUserMessage({content, source:{kind:'user'}})` → `agent.followup(message)` 或 `agent.steer(message)`
- `session.create`：`sessionId = payload.sessionId || 'session-'+randomUUID()`；`sessions.create(id,{meta:{cwd}})`（meta 而非顶层 cwd）
- `session.list`：同构官方 listVisibleSessionSummaries（attached 内存 + cold 持久化 + 文件扫描，updatedAt 倒序，projections 标题从 foldLogEvents）
- `session.history`：findSessionFile + readAllLogEvents 完整流 + live 事件补尾，beforeSeq/maxMessages 分页
- `llm.providers`：`listConfigurableProviders()` + `listProviders()` 合并（37=37）
- `settings.*`：白名单 `WEB_SETTINGS_NS = [agent-loop, shell, locale, permission, ui-conversation, ui-theme, web-search-deepseek, agent-presets]`

### 6.4 模块
- `lib/gui-api.js`（ESM ~1340 行）：RpcError / dispatch 表 / method() 注册器 / handleGuiApi
- `lib/zstd-log.js`：scanFrame/decompressZstd/decompressFrames/parseLines/walkSessionFiles/findSessionFile/freshFoldState/foldInto/foldLogEvents/readAllLogEvents/dshHome()

## 7. 双 WS 事件流（阶段3，已完成）

### 7.1 协议
- 两条 WebSocket 下推：`/api/events.mux` + `/api/events.host`
- 帧格式：`{type:'server-request', rpcId:randomUUID(), method:<payload.type>, payload}`（method 字段必需，否则前端 zod 校验判 malformed frame 丢弃）
- 纯下行，无上行处理
- RFC6455 手写握手（sha1(key+MAGIC)base64 + 文本帧 0x81 7/16/64bit 长编码）

### 7.2 mux 流（lib/gui-ws.js startMux）
- 连接即对全部 `sessions.list()` 推 `{type:'session/subscribed', sessionId, lastSeq:lastEventSeq(session)}`（session.seq-1 或 events 尾 seq）
- `ctx.on('session/event')` → `{type:'session/event', sessionId, event, view?:toolViewFor}`（toolViewFor: tool/call|result → `{for, view:{card:name}}`）
- `ctx.on('session/created')` → subscribed 帧

### 7.3 host 流（startHost）
- 初始 workspaceRegistry.list() 快照 → `host/workspace-changed`（每个）+ `archived-sessions-changed`
- `session/created` → `host/session-added(blank=!running&&!events.length)`
- `session/disposed` → `session-removed`
- `agent/status` → `session-status(running=status==='running')`
- `agent/error` → `agent-error`

### 7.4 鉴权
- `authGuiWs(req,url)`：回环直连免 token；LAN 需会话 cookie 或 token query
- WS upgrade 阶段无法 302/写 403 页，鉴权失败直接 socket.destroy()

## 8. Polyfill 策略（持续迭代）

华为真机 WebView（Android 10，Chrome 88）缺 ES2022+ API。在 `buildGuiledIndex()` 的 `<head>` 首位注入内联 polyfill script（ES5 写法，在 `__DSH_BOOT__` 之前执行）：

| API | 状态 | polyfill |
|---|---|---|
| `Object.hasOwn` | ✅ 已补 | `Object.defineProperty(Object,'hasOwn',{value:...})` |
| `Array.prototype.at` | ✅ 已补 | |
| `Array.prototype.findLast/findLastIndex` | ✅ 已补 | |
| `String.prototype.replaceAll` | ✅ 已补 | split/join |
| `structuredClone` | ✅ 已补 | JSON.parse(JSON.stringify) |
| `crypto.randomUUID` | ✅ 已补 | getRandomValues + RFC4122 v4 |
| `crypto.getRandomValues` | ✅ 已补 | Math.random 兜底 |
| `AbortSignal.timeout` | ❌ **缺失（当前阻断）** | `AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){c.abort()},ms);return c.signal}` |
| 其他 ES2022+ | 待发现 | 真机 CDP console 捕获后迭代补 |

**当前阻断 bug**：`AbortSignal.timeout is not a function` 导致历史加载失败 + 消息流不通。这是第 4 个缺失 API，待修复。

## 9. WS 探针（调试工具）

polyfill 里包装 `window.WebSocket` 构造器，记录每次连接的 open/error/close 到 `window.__wsProbeLog`（环形 120 条），用 CDP `Runtime.evaluate` 读取。用于诊断前端 WS 连接问题。

## 10. 真机验证状态（华为 nova7se CDY-AN00，Android 10，dpr=3，CSS 360x800）

| 项 | 状态 | 说明 |
|---|---|---|
| GUI 页面加载 | ✅ | title=DeepSeek Harness，root=1 |
| Polyfill: Object.hasOwn | ✅ | boot 越过 |
| Polyfill: crypto.randomUUID | ✅ | 设置页 agentPreset 加载 |
| Polyfill: AbortSignal.timeout | ❌ | **历史加载失败，消息流不通** |
| 双 WS OPEN | ✅ | mux 49-149ms / host 127-231ms |
| WS 帧格式 (method 字段) | ✅ | session/subscribed 基线正常 |
| 无状态 cookie 跨热重载 | ✅ | HMAC 签名，不依赖内存 Map |
| RPC session.list | ✅ | 120-123 items |
| RPC session.create | ✅ | 新会话创建成功 |
| 工作区显示 | ✅ | DSH Zone |
| 会话视图进入 | ✅ | composer readOnly=false, placeholder="给智能体发消息" |
| 模型选择按钮 | ✅ | `_7KE1Ra_trigger` 存在 |
| 设置页打开 | ✅ | 通用设置/模型/插件/Agent 预设 |
| 消息发送 → AI 回复 | ❌ | AbortSignal.timeout 阻断 |
| 历史会话加载 | ❌ | AbortSignal.timeout 阻断 |
| 桌面端同步 | 待验证 | 需消息流打通后验证 |

## 11. 12 项 UI 改造计划（用户反馈，待 polyfill 修复后实施）

> 前端是官方打包的静态 bundle（锁死快照），UI 修改通过 `buildGuiledIndex()` 注入定制 CSS + JS 补丁脚本实现，不改 bundle 源码。

| # | 需求 | 方案 |
|---|---|---|
| 1 | 删除"预览版"标志 | CSS `.pXSMma_previewBadge{display:none!important}`（仅欢迎页显示，进入会话后自动消失） |
| 2 | 设置内插件/Agent预设功能删除 | CSS 隐藏设置页对应 tab 按钮 + JS 拦截点击；或改 bundle 源码删除入口 |
| 3 | 左侧栏完全隐藏，右上角图标展开 | CSS `[class*=_frame]{grid-template-columns:0 minmax(0,1fr) 0!important}` + 注入浮动按钮 JS toggle |
| 4 | 侧栏展开不影响主页 | CSS 侧栏 `position:fixed;z-index:100` overlay 模式，内容区不压缩 |
| 5 | 删除右侧边栏及功能 | grid 第三列已 0px（detailsCollapsed=true），确认完全隐藏 details col |
| 6 | 设置内模型功能和电脑端同步 | RPC `llm.providers/models` 已同源（ctx.llm），验证设置页模型 tab 显示一致 |
| 7 | 设置页 UI 排版改为每项向下展开 | JS 补丁重排设置页为 accordion 模式（点击设置项向下展开内容） |
| 8 | 手机发消息电脑端及时同步 | 复用真实 DSH 会话（agent.followup），桌面 GUI 天然可见同一事件流——需消息流打通后验证 |
| 9 | 输入框无法使用 | 根因：AbortSignal.timeout 阻断导致历史加载失败→composer 卡在只读；修 polyfill 后恢复 |
| 10 | 工作区内容没有同步 | 验证 workspace.list + host/workspace-changed 帧；recentWorkspaceId 计算 baselinesReady 依赖 |
| 11 | 模型选择和推理功能在电脑端生效 | RPC `session.selectModel` 已实现（installModelSelection + session.modelSelection 持久化），验证端到端 |
| 12 | 清除点击产生的黄框 | CSS `*{-webkit-tap-highlight-color:transparent!important;outline:none!important}` |

## 12. 实施阶段

| 阶段 | 状态 | 说明 |
|---|---|---|
| 0 资产采集 | ✅ | 37 bundle + dist，revMismatch=0 |
| 1 网关扩展 | ✅ | 静态服务 + boot 注入 + 无状态 cookie 鉴权 + 旧协议兼容 |
| 2 RPC 自建 | ✅ | 60 方法，24/24 验证全绿 |
| 3 WS 事件流 | ✅ | 双 WS，帧格式修复，5/5+5/5 验证 |
| 3 真机调试 | 🔧 进行中 | polyfill 迭代（AbortSignal.timeout 待补），消息流待打通 |
| 4 差异项打磨 | 待做 | 12 项 UI 改造 + 设置白名单 + 触摸微调 + 旧路径回归 |
| 5 验证交付 | 待做 | 真机端到端 + APK + DSH-Mobile-v1.4.0.zip + git |

## 13. 关键文件

| 文件 | 角色 |
|---|---|
| `lib/index.js` (~2100行) | host 半边：网关 server + 静态服务 + 鉴权 + boot 注入 + polyfill + 旧协议代理 |
| `lib/gui-api.js` (~1340行) | 60 RPC 自建：dispatch 表 + ensureSession + session/workspace/llm/settings 全域 |
| `lib/gui-ws.js` (~260行) | 双 WS 下推：RFC6455 握手 + mux/host 帧协议 + ctx.on 订阅 |
| `lib/zstd-log.js` | zstd 帧扫描 + 日志折叠 + findSessionFile + readAllLogEvents |
| `gui/dist/` | 官方前端 dist（89 文件 4.41MB） |
| `gui/bundles/<id>/client.js` | 37 个官方核心插件 bundle（2.92MB） |
| `gui/manifest.json` | boot manifest（rev + 37 entries） |
| `scripts/collect-gui-assets.cjs` | 资产采集脚本 |
| `scripts/verify-stage*.cjs` | 分阶段验证脚本 |
| `scripts/cdp-eval.cjs` | 真机 CDP JS 执行（支持 --file） |
| `scripts/cdp-console.cjs` | 真机 CDP console/异常捕获 |
| `scripts/cdp-shot.cjs` | 真机 CDP 截图 |

## 14. 工具链与环境

- node = `C:\Program Files\DSH Desktop\resources\node\node.exe`（v24.15 原生 WebSocket/fetch）
- PS5.1 中文文件只用 read/write/edit 工具（GBK 乱码不可逆）
- assemble-client.cjs 用 `tpl.split(marker).join(qr)` 绝不用 String.replace（$ 特殊模式）
- APK 构建：`$env:JAVA_HOME=C:\Users\BANGBANG\Android\tools\jdk-21.0.12; $env:ANDROID_HOME=C:\Users\BANGBANG\AppData\Local\Android\Sdk; gradle-8.9.bat --no-daemon -p E:\DSH Zone\dsh-mini\apk :app:assembleDebug`
- git = `C:\Users\BANGBANG\Android\tools\MinGit\cmd\git.exe`（代理 127.0.0.1:7890）
- 真机 CDP：`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` + cdp-eval.cjs
- 真机 MKBUT20708009265（华为 nova7se，Android 10，dpr=3，CSS 360x800）
- 网关 0.0.0.0:46322（主端口 46321）
- token = `C:\Users\BANGBANG\.dsh\dsh-mini\token.txt`（当前 a776441024674c18988959905c057fa9，若失效需重读）

## 15. 风险与对策

| 风险 | 对策 |
|---|---|
| WebView ES2022+ API 缺失 | polyfill 迭代补（已补 7 个，AbortSignal.timeout 待补） |
| 事件协议细节不一致 | 如实采样官方历史事件比对 |
| 平台种子版本耦合 | 资产全取自同一安装版快照 |
| bundle 遗漏 | 采集脚本全量枚举 manifest |
| 网关改造影响旧路径 | 拆分路由全量回归 |
| 手机性能 | 保留官方默认先实测 |
| cookie 热重载失效 | 已改无状态签名 cookie（HMAC） |

## 16. 官方 rpcErrorSchema 错误码全集

bad-request(issues) / cancelled / session-not-found(sessionId) / model-unavailable(provider,model) / session-conflict / workspace-*8类 / directory-*4类 / agent-preset-*6类 / agent-busy / attachment-error / queue-item-not-found / steer-unavailable / command-error / unknown-command / settings-rejected(设置白名单) / settings-*3类 / credential-rejected(ref) / model-discovery-failed / title-invalid / fork-unavailable / subagent-*8类 / agent-preset-read-only / locked / conflict / not-found / invalid / internal

## 18. 四轮 UI 打磨批次记录

### 18.1 第一批（12 项需求，已完成并真机验证）
- ①删除预览版标志 `.pXSMma_previewBadge{display:none!important}`；②设置插件/Agent预设 tab 隐藏 `.VOzbGW_navCell:nth-child(3),:nth-child(4){display:none}`；③⑤grid 列宽 `0px minmax(0,1fr) 0px` + `.pI_x6G_centerCol{grid-column:2}`（display:none 会塌缩 grid——关键教训）；④侧栏展开 fixed overlay + .dsh-scrim；⑥模型/设置与电脑端同源（ctx.llm/settings）；⑦设置页单列 `.VOzbGW_panel{flex-direction:column}` + nav 横排；⑧消息实时同步（agent.followup 同会话事件流）；⑨输入框（polyfill AbortSignal.timeout 修复后恢复）；⑩工作区（workspace.list + host/workspace-changed 帧）；⑪模型/推理档（session.selectModel + loadModelCatalog 补 reasoning 字段）；⑫黄框 `*{-webkit-tap-highlight-color:transparent!important}`。

### 18.2 第二批（7 项需求 N1-N7，已完成并真机验证）
- N1 左上角鲸鱼悬浮图标展开侧栏、N2 刘海屏 `--dsh-safe-top`（Bridge getSafeTop px/dpr）、N3 键盘跟随上滚 `window.__dshSetKb` + `--keyboard-shift` transform、N4 设置修复（settings.describe 同步数组签名 / webSettingsAllow 动态 provider ns / agentPreset.read presets.resolve 链）、N5 推理档（loadModelCatalog 对缺 reasoning 模型调 `llm.resolveModelInfo` 补全；官方 model-selection 只在 model.reasoning 存在时渲染推理档面板）、N6 设置 header 注入📷扫码、N7 默认工作区（前端 recentWorkspaceId 由 recentWorkspace(items,sessions.byId) 计算，非 host 字段）。

### 18.3 第三批（4 项需求，本轮，已完成并真机验证）
用户需求（verbatim）：「1.手机端文本框中"DeepSeek V4 Flash Max"字样省略，只保留展开的按钮；2.整个页面固定，上方留出适配刘海屏的空间；3.将返回连接页面的功能加到手机端设置里面；4.删除右上角相机按钮，删除左上角按钮，在最左侧边框增加一个箭头按钮，用于展开侧边栏」

| # | 实现 | 验证 |
|---|---|---|
| 1 | CSS：`.uV2eYG_row ._7KE1Ra_triggerLabel,.uV2eYG_row ._7KE1Ra_triggerEffort{display:none!important}` + trigger 缩为 30px 仅留 chevron（官方 trigger 结构=button > span(triggerLabel)+span(triggerEffort)+svg(chevron)） | trigger=30px、labelVis=effVis=none、chevron=16px ✓ |
| 2 | `body{position:fixed!important;top/left/right/bottom:0;overflow:hidden;padding-top:var(--dsh-safe-top)}` + `.pI_x6G_frame{height:calc(100vh - var(--dsh-safe-top))}` | bodyPos=fixed、frameH=764px(800-36)、safeTop=36px ✓ |
| 3 | 设置面板注入两个按钮（MutationObserver 等 `.VOzbGW_nav`/`.VOzbGW_header .VOzbGW_actions` 出现后注入）：nav 顶部「⬅返回连接页」（调 `DshMiniBridge.gotoConnect()`）+ header 📷扫码（调 startScan）。APK MainActivity Bridge 新增 `gotoConnect()`（loadUrl file:///android_asset/connect.html，保留 last_url 供重连；与 clear() 区别=不删 last_url） | navBtns=[⬅返回连接页,通用设置,模型,插件,Agent 预设]、headerBtns=[📷] ✓；Bridge 8 方法含 gotoConnect ✓ |
| 4 | 删除 `#dsh-sb-toggle`(左上鲸鱼)+`#dsh-scan-entry`(右上相机) 创建与样式；新增 `#dsh-sb-arrow`（position:fixed; top:50%; left:0; 32x56px 圆角右半边箭头 SVG，点击 toggle dsh-sb-open；侧栏展开时隐藏 `body.dsh-sb-open #dsh-sb-arrow{display:none}`） | arrow=flex、toggle/scan 元素不存在 ✓；点击→open=true/scrim=block/sb=fixed/arrow=none；点 scrim→close/arrow=flex ✓ |

注：#dsh-sb-toggle/#dsh-scan-entry 的 CSS 保留 `display:none!important` 规则防残留；验证期间强制刷新用过 `am start -n com.dshmini.app/.MainActivity -a VIEW -d http://192.168.2.3:46322/?token=…`（直接启动走 last_url 会是旧 /dsh-mini/ 路径页面）。

## 17. 官方事件词表（session/event data.type）

assistant / chunk（流式命脉，{turn,step,chunk:{type,...}}）/ user / message / turn/start / turn/end / tool/call / tool/result / approval/asked / goal/change / compaction/* / session/title / command/run / request/header / request/context / step/start / step/end / agent/inbox/spliced

## 19. 设置写入链路修复（isLoopback 恒 true）——用户报「通用设置不生效」根因+解决

**用户反馈**：『通用设置的功能：Agent预设；权限；语言；繁忙时Enter键行为依旧不可用』（外观可用）。

**根因链（源码级坐实）**：
1. `dsh-client-connection` apply()（lib/client.js:10174）：`isLoopback: isLoopbackHostname(location.hostname)` —— 手机经 `http://192.168.2.3:46322` 访问 → hostname 非 127/loopback → **isLoopback=false**。这是官方安全设计：LAN/远程访问视为只读控制台，禁止篡改主机设置。
2. `dsh-client-ui-settings` SettingsScopeBinder.bind()（lib/client.js:210）：`new SettingsScopeController(connection.api, spec, connection.isLoopback ? "host" : "memory")` —— 非 loopback → **persistence="memory"**。
3. SettingsScopeController.enqueue()（lib/client.js:131）：`if (this.persistence === "memory") return Promise.resolve();` —— **所有 settings 写入被静默吞掉，永不发 RPC**。
4. 结果：UI 乐观更新（locale 切英文、preset 显示新值、权限显示新值）但 **host 永不落盘** → 刷新还原 → 用户见「不可用」。
5. 验证过程中误判：诊断用 fetch hook 曾吞 response body（resp.text() 消费流，前端随后 .json() 失败）造成假象「前端没发请求」；实际前端因 memory 模式根本不该发。agent-preset 写入此前经 RPC 直调验证成功（`{ok:true}` revision+1）证明 host API 层完全正常——问题纯在前端 persistence 层。

**修复（1 行，改内置 bundle 快照）**：`gui/bundles/@deepseek-ai/dsh-client-connection/client.js` 第 10174 行
`isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),` → `isLoopback: true, /* DSH-Mobile: token 鉴权经网关访问，允许写主机设置（官方 LAN 只读策略不适用） */`
手机端 bundle 是锁死快照（阶段0 采集自官方安装版，不受官方更新影响）；serve 端按 id 实时读文件、Cache-Control no-cache、不校验 rev 参数，改文件即生效；manifest.json 无需更新。桌面主端口 46321 官方 GUI 走自己的模块系统，不受影响。

**验证（真机 MKBUT20708009265 全绿）**：
- 切语言→English：UI（navCell=General/title=Settings）+ HOST locale `{"preference":"en"}` 同步落盘 ✓
- 切权限→Workspace Write：UI + HOST permission `{"defaultPreset":"workspace-write"}` ✓
- 切 Agent 预设→Warmup Better：UI + HOST agent-presets `{"default":"warmupbetter"}` ✓（随后还原 standard）
- 全部还原（standard/zh/danger-full-access/queue）后重载页面 UI 显示正确默认值 ✓
- 回归脚本 scripts/_verify-settings-write.cjs（settings.describe 读值→settings.update 写异值→验证 host 变化→还原；取值键名：agent-presets.default/locale.preference/permission.defaultPreset/ui-conversation.busyEnter）——注：脚本 PASS 判定对「写原值=NO 变化」会误报 FAIL，核心看 RESULTS 每行 changed=YES
