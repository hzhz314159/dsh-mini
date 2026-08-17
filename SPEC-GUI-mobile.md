# SPEC — 手机端直接打开 DSH GUI（WebView 直开方案评估）

> 状态：**待用户决策**（本文件为决策依据，非实施计划）
> 版本：v1 草案，2026-03（DSH Mini 项目内）
> 提出人：用户（「我在考虑手机端 webview 直接打开 GUI」——对现手机专用页不满意）

---

## 1. 动机

现有手机端（`public/index.html` 专用页面）功能有限：会话/发消息/附件/模型切换/余额徽章，但
交互、信息密度、功能覆盖与桌面 GUI 差距明显（无设置、无终端、无文件树、无插件管理、无
子代理/任务/工具面板等）。用户设想：**手机端 WebView 直接打开 DSH 桌面 GUI 本体**，
一步到位获得完整能力，不再维护两套界面。

## 2. 已核实的技术事实（2026-03 源码级调研）

### 2.1 GUI 入口与移动端基础
- GUI 静态产物：`<install>\node_modules\@deepseek-ai\dsh-web-frontend\dist\index.html`（676B），
  由 `dsh-host-frontend-static` 以 fallback seat 服务（SPA 路由，miss 回 index）。
- **`<meta name="viewport" content="width=device-width, initial-scale=1">` 已存在** ——
  手机 WebView 不会出现桌面缩放白边，视口 = 设备 CSS 像素。
- 每次 index 响应经 `webServer.applyIndexTaps` 注入 `window.__DSH_BOOT__`（boot 清单），
  浏览器端 `dsh-client-web` 的 `AppWebEntry.run` 解析并加载全部插件模块（fail-loud：
  任一 entry 未 active 会显示错误页，不会静默坏）。

### 2.2 布局：无移动端断点，靠「让步链」压缩
- 三栏 grid 外壳：`dsh-client-ui-layout`（`AppFrame`：sidebar | center | details），
  CSS 无 `@media` 宽度断点（仅 prefers-reduced-motion）。
- 列宽由 concession 链解算（columns.ts）：`d0 = max(0, viewport - sidebar - 640)`；
  **center 列保底 640px 理想宽**，放不下时 details=0、center=viewport-sidebar。
- 侧栏（`dsh-client-ui-sidebar`）可收起/展开（宽/窄两态：~240px / 36px 图标条）。
- 360px 真机推断：侧栏收起 → center ≈ 324px；侧栏展开 → center ≈ 120px（不可用）。
  ⇒ **手机可用性依赖「侧栏收起 + 全屏中心列」**，且所有桌面控件挤在 324px 内。

### 2.3 交互模型：桌面为先
- 大量操作依赖 hover（图标浮现、工具按钮、消息操作条）、拖拽（分栏把手、
  面板调整）、右键菜单、快捷键——触摸设备上 hover 失效、拖拽需长按、右键无对应。
- React 合成事件在触摸上点击类操作（onClick）正常，但**未做触摸优化的控件**
  （点击目标 < 44px、hover 才可见的操作）体验差。
- 键盘：GUI 有原生输入框，WebView 软键盘可弹（本 APK 已有键盘桥 `__dshSetKb`）。

### 2.4 鉴权与安全（关键）
- GUI 页面（/）与 RPC（/api/*）**在 LAN 上无任何 token 鉴权**（源码核实：
  `dsh-client-connection`/`dsh-host-apiproxy`/`dsh-host-webserver` 均无页面级鉴权；
  `Bearer` 仅用于调用外部 LLM API）。
- 现有 dsh-mini 的 token 机制（`?token=` / Bearer）只覆盖 `/dsh-mini` 网关转发路径。
- **后果**：只要 `--host 0.0.0.0`（手机可达的必要条件），**局域网内任何设备
  打开 http://<电脑IP>:46321/ 即可完全控制桌面 DSH**（发消息、读会话、跑工具）。
  桌面 GUI 的「回环免 token」设计默认只信任本机。

### 2.5 网络与实时通道
- 手机访问 GUI 前提：DSH 以 `--host 0.0.0.0` 启动（当前绑 127.0.0.1:46321）。
- 页面与 RPC 同源（WebSocket/SSE/EventSource 同源直连，无跨域问题），
  WebView 内可用；APK 已开 `cleartextTraffic`（http 明文）。
- 附件上传：GUI 的 file input 触发 `onShowFileChooser`——本 APK 已实现相机/相册透传。

### 2.6 与现有 dsh-mini 网关的关系
- 手机直开 GUI 走主 webServer 端口（46321），与 dsh-mini 网关（46322 代理 /dsh-mini）
  互不冲突；现有手机专用页、扫码、二维码、桌面侧栏图标全部可保留。
- 直开 GUI 绕过了 dsh-mini 网关，也就绕过了网关的 token 鉴权（见 2.4）。

## 3. 手机直开 GUI 的预期效果

| 维度 | 评估 |
|---|---|
| 功能覆盖 | **完整**（全部插件面板、设置、终端、文件树、模型、余额、子代理） |
| 实时同步 | 完整（与桌面同一会话流，SSE 实时） |
| 布局 | 勉强可用：侧栏收起 + center 324px 窄列，桌面密度 UI 挤压 |
| 触摸体验 | 差-中：hover 操作不可见、目标小、无触摸优化、拖拽失效 |
| 性能 | 中：React 大应用 + 全部插件 bundle 加载，旧机 WebView 可能卡 |
| 安全 | **差**：LAN 无鉴权，同网段任何人可控桌面 |
| 维护 | 零（不维护手机页）——但手机页本身也是资产（离线/轻量场景） |

## 4. 方案选项

### 方案 A：WebView 直开 GUI（替换手机页为默认）
- APK 启动地址改为 `http://<LAN IP>:46321/`（last_url 机制复用）。
- 保留现有手机专用页为「轻量模式」入口（设置里切换），或彻底移除。
- 安全：建议为 GUI 主路径补一层网关级 token（需改官方前端 boot 或加代理中间件，
  工程量大；或接受「仅家庭局域网」风险）。
- 优点：一步到位、零界面维护、功能全。
- 缺点：触摸体验差、窄屏挤压、安全敞口。

### 方案 B：双模式共存（推荐方向）
- APK/手机页默认仍是专用页（日常聊天够用、体验好、有 token 鉴权）；
- 手机页加「打开完整桌面界面」按钮 → WebView 跳主 GUI（提示安全风险）；
- 保持现有网关/二维码/桌面侧栏全链路不动。
- 优点：两全；缺点：专用页仍要维护（可冻结功能，只修 bug）。

### 方案 C：GUI 官方响应式改造
- 给 DSH 前端加移动端断点/触摸适配——改官方产品代码，随官方升级持续冲突，
  本插件项目不可维护。**不推荐**（除非 DSH 官方自己做）。

### 方案 D：放弃直开，继续打磨专用手机页
- 现状路线：把用户不满的点（已修：尺寸/键盘/折叠）继续打磨到满意。
- 优点：安全、体验可控、维护边界清晰；缺点：功能天花板低（受手机页 API 面限制）。

## 5. 若选 A/B 的改动计划（草案，确认后再细化）
1. APK：`MainActivity` 支持「直开 GUI 地址」连接目标（地址输入/扫码兼容 `:46321` 根路径）；
2. 手机专用页：加「完整版界面」跳转入口（B 方案）或移除（A 方案）；
3. 设置卡：加「手机端模式」选项（专用页 / 完整 GUI / 询问每次）；
4. 安全提示：直开 GUI 前一次性警示（局域网无鉴权）；
5. 真机验证：GUI 在 360px WebView 的布局/触摸/输入实测，形成「已知不适配清单」。

## 6. 待用户决策
1. 选 A / B / C / D 哪个方向？
2. 若 A/B：能否接受「局域网内无鉴权」（家庭网 OK？还是必须加 token 才肯用）？
3. 现有专用手机页：保留（轻量模式）还是移除？
4. 手机直开 GUI 最想解决的核心痛点是什么（功能全 / 界面统一 / 少维护）？
   ——决定取舍优先级。
