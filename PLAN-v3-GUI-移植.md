# DSH-Mobile v3 —— 官方 GUI 完整移植重构执行计划

> 用户定案：把官方 GUI 完整功能搬到 DSH-Mobile（重构，非旧版修补）。前端静态打包进 dsh-mini；API 拷贝官方契约改造成自己的；走现有 dsh-mini 网关通道；不跟随官方更新（锁死快照）；旧手机页直接替换。

## 0. 定案约束（用户已确认）

| # | 决策 | 含义 |
|---|---|---|
| 1 | 传输层复用 dsh-mini 网关 | 手机经 `http://<LAN IP>:46322/?token=…` 访问（**根路径直接出 GUI**），不另开端口不起新服务 |
| 2 | 前端静态打包进 dsh-mini | 官方 dist + 全部 /plugins 插件 bundle 静态收录在 dsh-mini 内 |
| 3 | 不做插件、API 自建 | 不依赖官方 ClientModuleSystem 动态加载之外的运行时；57 个 RPC + 双 WS 事件流由 dsh-mini host 自建实现 |
| 4 | token 作为唯一鉴权门槛 | 去掉官方 PRIVILEGED_METHODS 的 loopback 强制，统一走 dsh-mini token（网关换 HttpOnly cookie 会话） |
| 5 | 锁死快照，不同步官方 | 不写同步脚本；自身稳定优先 |
| 6 | 旧手机页直接替换 | `/dsh-mini/` 路径不再服务旧页面；旧 API 路径保留兼容（APK connect 自检依赖 health） |
| 7 | 设置范围 | 照搬官方白名单（agent-loop/shell/locale/permission/ui-conversation/ui-theme/web-search-deepseek/agent-preset） |
| 8 | 子代理面板 | 纳入 v3 首发（列表/历史/发指令/中断） |
| 9 | APK 连接 | 保持现有流程（地址输入+扫码 → 网关根路径带 token） |
| 10 | 版本号 | **1.4.0**，zip 命名 `DSH-Mobile-v1.4.0.zip` |

## 1. 架构图

```
手机 WebView / APK
   │  http://<LAN IP>:46322/?token=<token>   （网关端口 = dsh-mini 自建 server）
   ▼
┌──────────────────────────────────────────────────────────────┐
│ dsh-mini host 半边（lib/index.js，桌面 DSH 插件进程内）            │
│                                                              │
│  ① 静态服务   GET /            → 内置官方 GUI dist（boot 注入）  │
│               GET /assets/*    → 官方 Vite 产物                  │
│               GET /plugins/<id>/client.js?rev= → 内置 bundle    │
│  ② RPC       POST /api/<method>（57 个，信封 zod 校验）          │
│  ③ 事件流     WS  /api/events.mux   （会话事件/队列/审批/投影）    │
│               WS  /api/events.host  （会话增删/工作区/远程事件）   │
│  ④ 鉴权       ?token= → 网关注入 HttpOnly cookie → 后续自动携带   │
│  ⑤ 兼容       /dsh-mini/* → 旧协议（health/token/配置，APK 依赖）  │
└──────────────────────────────────────────────────────────────┘
   数据来源：ctx.sessions / ctx.agents / ctx.llm / ctx.settings /
           ctx.workspaceRegistry / ctx.subagents / ctx.on('session/event')
   （与官方 ApiProxy 同一套 Cordis 运行时服务 → 1:1 重写可行）
```

**关键设计**：手机页面与 API 完全同源于网关端口 46322（官方前端用 `location.origin` 相对路径请求 `/api`、`/api/events.mux`、`/plugins`）→ **前端零改动**。桌面主端口 46321 保持官方 GUI 不动，两者互不干扰。鉴权在网关层注入（官方前端无 token 机制，靠 cookie auto-carry）。

## 2. 已核实事实（四份调研结论汇总）

- **官方 GUI 无终端/文件树/余额 UI**（浏览 1 确认）；「终端」仅是工具结果的被动输出卡。
- **协议**：RPC = `POST /api/<method>`，信封 `{type:'client-request', rpcId, method, payload}` → `{type:'server-response', rpcId, result}`；事件 = 原生 WebSocket（非 socket.io）`/api/events.mux` + `/api/events.host`，帧 = server-request 信封；SSE 为降级载波（可只实现 WS + 426 拒绝）。
- **57 个 RPC**：session 12 / subagent 4 / host 5 / workspace 7 / skill 1 / agentPreset 6 / goal 6 / settings 5 / credentials 3 / llm 3 + Typert remote（commands.execute、goals.edit、messageFeedback、pluginInventory）。
- **事件帧**：session/event（原始事件+可选 tool view）、session/subscribed（lastSeq 基线）、approval/requested|resolved、question/requested|resolved、session/queue、session/jobs、session/projection、stream/error；host 帧（session-added/removed/status、workspace-changed/removed/order-changed、archived-sessions-changed、agent-error、remote-event 白名单 11）。
- **会话事件词表 54 个**（assistant/chunk 流式命脉、user/message、turn/start|end、tool/call|result、approval/asked、goal/change、compaction、session/title、command/run）；事件 envelope = `{type, seq, time, data, surfaceOp('append'|replace), ignorable?, sourceEventSeqs?}`。
- **同步协议**：打开会话 = `session.history` 尾页（事件数组 + projections 基线）→ `session/subscribed` 重置事件窗 → 增量 `session/event` 帧；重连无 since 续传（官方 v1 未实现）→ 重连重开流 + 全量重拉。
- **启动链**：`window.__DSH_BOOT__ = {rev, entries:[{id, url:'/plugins/<id>/client.js?rev=', rev, inject?, immediately?}]}` 由 serve 注入 → ClientModuleSystem（平台种子模块 react/react-dom/cordis/ui-primitives 等 8 个版本耦合）→ 逐 entry loader.create → 全 ACTIVE 才渲染。
- **官方 host = 对 Cordis 运行时服务的薄包装**（ApiProxyService 注入清单：agentDefaultModel/agents/attachments/llm/sessions/subagents/sessionQuery/tools/userQuestions/workspaceRegistry/directoryPicker）→ dsh-mini 用同一套 ctx 服务可 1:1 重写。
- **鉴权现状**：Host 头 loopback/trustedHosts 围栏（DNS-rebinding 防线）+ PRIVILEGED_METHODS 强制 loopback（settings.*、credentials.*、agentPreset 写类、host.pick/openPath、llm.discoverModels）；**无 token 机制** → dsh-mini 自建 token→cookie。
- **体积**：官方 dist = 89 文件 / 4.41MB；+ /plugins 全部 bundle 后约 8~12MB → 打进插件与 APK 完全可行。
- **设置白名单**：官方 Web 只向 `WEB_SETTINGS_NAMESPACES`（agent-loop/shell/locale/permission/ui-conversation/ui-theme/web-search-deepseek/agent-preset）暴露设置——dsh-mini 可原样保留或扩展。

## 3. 静态资产清单（采集自当前安装版 `resources\app\node_modules\@deepseek-ai\`）

| 资产 | 来源 | 去处（dsh-mini 内置目录） |
|---|---|---|
| GUI dist 89 文件（index.html+assets） | `dsh-web-frontend\dist\` | `gui-dist/` |
| 36 个插件 client bundle（+sourcemap 可选） | 各 `dsh-client-*\lib\client.js` | `gui-bundles/<id>/client.js`（保持 `/plugins/<id>/client.js?rev=` URL 形态） |
| 平台种子模块版本核对 | `dsh-client-web` 的 seed.ts 清单 | 与 bundle 一起收录，沿用安装版即匹配 |
| 图标/字体/langs | dist 内 | 随 dist 复制 |

## 4. 分阶段实施

### 阶段 0 — 资产采集与定点（半天）
- 写采集脚本：从安装目录复制 dist + 插件 bundle → dsh-mini 内置目录；生成 bundle 清单 JSON（id/url/rev/在 inject/immediately）。
- 核对平台种子模块清单，确保 bundle 自洽。
- 交付：内置资产目录 + 清单文件。

### 阶段 1 — 网关扩展为应用服务器（1~2 天）
- host 半边重构网关 server（46322）：
  - 根路径 GET / → 服务 GUI index.html（注入 `window.__DSH_BOOT__` 指向内置 bundle 清单）
  - GET /assets/*、/plugins/* → 静态文件
  - ?token= 校验通过后种 HttpOnly Secure SameSite cookie（会话 30 天）；无 token 且无 cookie → 403 页面（含引导文案）
  - 对 header 校验 token 兼容（Bearer）——保留连接页既有行为
- 保留 `/dsh-mini/*` 旧路径兼容（health/config/token/balance/beacon）。
- 交付：手机浏览器打开网关根路径可见官方 GUI 壳（空列表 + 侧栏，能渲染不白屏）。

### 阶段 2 — 57 个 RPC 实现（2~3 天，核心工作量）
- 按域逐组实现（信封 + zod 校验 + 200 响应）：
  - **session 12**：list（合并内存+持久化摘要，updatedAt 倒序——对齐官方 listVisibleSessionSummaries）、search（ctx.sessionQuery 降级为按标题/内容线性匹配）、create（ctx.agents.resume/create + mkdir cwd + sessionId 预分配）、history（按消息边界分页 + projections 基线）、models / selectModel（ctx.llm.resolveCallConfig + 图像模态校验）、rename（ctx.sessionTitle）、fork、prompt（queue→agent.followup / steer→agent.steer，图片经 ctx.attachments 持久化+base64）、attachment、updateQueue（agent.inbox）、cancel（agent.cancel({kind:'user'},{keepInbox:true})）
  - **workspace 7**：ctx.workspaceRegistry 1:1
  - **subagent 4**：ctx.subagents.listChildren 等 1:1
  - **host 5**：describe（版本乐观值+cwd+attachedSessions+canOpenPath:false）必做（连接握手）；目录 4 个降级（空实现/浏览器 input 兜底）
  - **settings 5 / credentials 3 / agentPreset 读侧 / goal 6 / skill / llm 3**：ctx.settings/credentials 1:1（去 loopback，token 门槛）；agentPreset 写类降级（内置预设清单只读）
  - **Typert remote**：commands.list/execute（slash 命令映射 session followup）、goals.edit、messageFeedback（走内存反馈存储）、pluginInventory（静态清单）
- 交付：手机端能完成会话列表/新建/发消息/历史/模型切换/工作区切换（核心闭环）。

### 阶段 3 — 双 WS 事件流（1~2 天，流式命脉）
- `/api/events.mux`：会话订阅（session/subscribed 基线 lastSeq → 增量 session/event 帧，数据源 `ctx.sessions.get(id).events` + `ctx.on('session/event')` live feed 按 seq 去重——复用 1.2.0 已验证的双源模式）；approval/question 的 requested/resolved + 可应答回执（POST /api/respond 对应）；session/queue、session/jobs 帧（agent.inbox 视图 + jobs 概要）；session/projection（title/usage 投影表）。
- `/api/events.host`：session-added/removed/status、workspace-changed/removed/order-changed、archived-sessions-changed、agent-error。
- 下推实现：Node ws 或原生 http upgrade + 手写帧；**必须逐字节对齐官方事件 envelope（seq/time/data/surfaceOp）**——从安装版真实历史事件采样比对。
- 交付：SSE 全链路（发消息 → 思考/工具/回复逐字流式到手机端）。

### 阶段 4 — 差异项与打磨（1~2 天）
- 桌面专属降级：目录选择对话框 → 浏览器 `<input type=file>`/手输路径；session.export ZIP → JSON 导出；agentPreset 文件写 → 只读。
- 设置页白名单核对（WEB_SETTINGS_NAMESPACES 原样）；手机端设置写走 gateway token cookie 已自动通过。
- 触摸适配微调（官方组件为桌面设计：窄屏自动折叠侧栏复用 + 必要 CSS 覆盖）。
- 回归：旧 /dsh-mini 路径 API 全绿灯（APK connect 自检）。

### 阶段 5 — 验证与交付（1 天）
- 本机验证：桌面起网关 → 手机浏览器（真机/CDP）走完整功能链路 20+ 项清单。
- APK：public 换新（或 WebView 指向网关根路径）；扫码/地址连接流程回归。
- 打包 DSH-Mobile v3 zip；SPEC 新章节；git 提交。

## 5. 验收标准（阶段 5 checklist 摘要）

- [ ] 手机打开 `http://<LAN IP>:46322/?token=…` 显示官方 GUI 完整界面（非白屏、无 fail-loud）
- [ ] 会话列表/新建/发消息/逐字流式回复/工具调用/思考过程 全链路（对齐官方聊天体验）
- [ ] 模型切换 + 推理档（per-session，跟随 DSH 模型目录）
- [ ] 历史会话打开（分页、投影基线、标题）与桌面端一致
- [ ] 工作区列表/切换/新建（会话按工作区）
- [ ] 设置页（分节显示+写入生效）+ 模型目录管理
- [ ] 子代理面板（列表/历史/发指令/中断）
- [ ] 错误场景：无 token 403、token 过期重扫、网关断连重连（WS 重连+全量重拉）
- [ ] 旧 APK connect 扫码流程不回归（health/二维码）
- [ ] 桌面 GUI 主端口使用不受影响

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 事件协议细节不一致（envelope/surfaceOp/usage）导致 UI 渲染异常 | 阶段 3 从安装版真实历史事件采样做逐字段比对夹具 |
| 平台种子模块版本耦合（react/cordis 版本） | 全部资产取自同一安装版快照，天然匹配；锁文件记录版本 |
| 40+ 域包 bundle 有遗漏 | 采集脚本以 manifests 全量枚举（含 inject/immediately 标记），生成清单与 boot 一致 |
| 手机性能（官方 bundle 大、大量动画） | 保留官方默认（先跑真机实测），必要时降级动画（prefers-reduced-motion） |
| 网关改造影响既有 /dsh-mini 路径与 APK | 阶段 4 全量回归旧协议；拆分路由（新 GUI 独立分支） |
| 授权边界扩大（token 唯一门槛→手机可写 settings） | 接受（用户已确认）；token 仅 LAN 内传播；会话 30 天可失效重置 |

## 7. 待确认问题（已全部确认）

1. ~~手机首页 URL 形态~~ → **根路径直接出 GUI**（`http://<IP>:46322/?token=…`）
2. ~~settings 命名空间范围~~ → **照搬官方白名单**（8 个命名空间）
3. ~~子代理面板~~ → **纳入 v3 首发**
4. ~~APK 连接方式~~ → **保持现有流程**（地址输入+扫码）
5. ~~版本号~~ → **1.4.0**，zip 命名 `DSH-Mobile-v1.4.0.zip`