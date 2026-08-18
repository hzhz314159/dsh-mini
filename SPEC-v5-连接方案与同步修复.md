# DSH-Mobile v5 · 连接方案升级与同步修复规格

> 状态：草案已实施（P0 修复验证通过 PASS 8/8 + 调试清理 完成；2.7 允许外网访问开关 完成；审查优化已落地）
> 适用基线：`@deepseek-ai/dsh-mini` v1.4.0（`lib/index.js` / `lib/gui-ws.js` / `lib/gui-api.js` / `lib/client.js`）
> 日期：2026-08-18

---

## 0. 本规格的起源

用户报告「电脑端新建会话后手机端不同步」。根因调查坐实了 **WS host 流事件转发不完整**——这是 v1.4.0 自建 apiproxy 时遗漏的核心事件映射，同时牵出连接方案（内网/外网自动切换）的 7 个已知弱点。本规格合并两件事：

1. **同步修复**（P0 紧急）：补全 gui-ws.js host 流的事件转发，使桌面端会话变更实时同步到手机端。
2. **连接方案升级**（P1 增强）：解决整页重载切换、混合内容阻断、无偏好持久化等 7 个弱点。

---

## 1. P0 — 会话同步修复（根因已坐实）

### 1.1 根因：dsh-mini gui-ws.js 缺少 `domain/changed` 事件转发

**官方 apiproxy** (`dsh-host-apiproxy/lib/types/api-proxy.js:3199-3285`) host 流监听 **5 类事件**：

| # | 事件 | 转发帧 | 作用 |
|---|------|--------|------|
| 1 | `ctx.on('session/created')` | `host/session-added` | 新会话入列（含 cwd 让前端分组） |
| 2 | `ctx.on('session/disposed')` | `host/session-removed` | 会话移除 |
| 3 | `ctx.on('agent/status')` | `host/session-status` | 运行状态变化 |
| 4 | `ctx.on('agent/error')` | `host/agent-error` | agent 出错 |
| 5 | **`ctx.on('domain/changed')`** | `host/workspace-changed` / `host/workspace-order-changed` / `host/workspace-removed` / `host/archived-sessions-changed` | **workspace 增量变更**（sessionIds 更新等） |

**dsh-mini** (`lib/gui-ws.js:182-240` startHost) **只监听前 4 类，完全不监听 `domain/changed`**：
- 连接时推一次 workspace 快照（`host/workspace-changed` for each workspace + `host/archived-sessions-changed`）
- 之后不再推任何 workspace 变更帧
- **后果链**：电脑端新建会话 → `workspaceRegistry` 更新 `sessionIds` → 触发 `domain/changed`(domain='workspace') → dsh-mini 不转发 → 手机端侧栏 workspace.sessionIds 不更新 → 新会话不在任何工作区分组中 → **侧栏不可见**

### 1.2 次要根因：`session/created` 帧的 cwd 字段提取错误

| 实现 | 代码 | cwd 来源 |
|------|------|----------|
| **dsh-mini** | `gui-ws.js:215` `...(session.cwd ? { cwd: session.cwd } : {})` | `session.cwd` — **可能 undefined** |
| **官方** | `api-proxy.js:3217` `...sessionListFields(session.header, session.events)` | `session.header.cwd` — **运行时正确位置** |

官方 `sessionListFields` (`api-proxy.js:408-419`) 从 `header` 提取：
```js
function sessionListFields(header, events = []) {
    const agentPreset = resolveSessionPreset({ header, events });
    return {
        ...header.parentSession === undefined ? {} : { parentSessionId: header.parentSession },
        ...header.origin === undefined ? {} : { origin: header.origin },
        ...header.cwd === undefined ? {} : { cwd: header.cwd },
        ...agentPreset === undefined ? {} : { agentPreset },
    };
}
```

DSH 运行时 session 对象的 cwd 在 `session.header.cwd`，`session.cwd` 顶层属性可能不存在。
- **后果**：即使推了 `host/session-added`，帧里缺 cwd → 前端 `mergeSummary` 创建的 summary 无 cwd 字段 → 无法归入工作区分组。

### 1.3 前端处理逻辑确认（官方前端快照）

- `dsh-client-runtime/client.js:8367-8378` — `handleHostEnvelope('host/session-added')`: 调 `mergeSummary({sessionId, updatedAt:Date.now(), running:false, blank, ...cwd, ...parentSessionId, ...origin, ...agentPreset})` → `recordMutation({kind:'upsert', summary})` → summaries 列表更新
- `dsh-client-runtime/client.js:9632` — `handleHostEnvelope('host/workspace-changed')`: `this.upsert(payload.workspace)` → 更新 workspace 列表（含 `sessionIds` 数组）
- `dsh-client-ui-workspace/client.js:148-163` — `groupByWorkspace(list, workspaces, archived, ungroupedOrder)`: 遍历 `workspace.sessionIds` 分组，不在任何 workspace 中的 session 归入 "Ungrouped" 桶
- `dsh-client-ui-workspace/client.js:1227-1240` — `ungroupedSessionIds`: `workspaces.flatMap(w => w.sessionIds)` 取已分组集合，剩余归 ungrouped

**结论**：前端侧栏按 `workspace.sessionIds` 分组。新建会话必须同时：
1. 推 `host/session-added`（让 summary 进入列表）
2. 推 `host/workspace-changed`（让 workspace.sessionIds 包含新 ID，才会显示在对应工作区分组）

缺任何一个帧 → 新会话不显示在侧栏（或落入 Ungrouped）。

### 1.4 官方模拟器佐证

`dsh-client-connection/client.js:9072-9103` fixture `session.create`: 创建后推 `host/session-added` + 调 `attachWorkspace()` 推 `host/workspace-changed`(workspace.sessionIds=[newId,...oldIds])。
即官方期望：**新建会话 = 两个帧**（session-added + workspace-changed）。

### 1.5 额外缺口：`API_REMOTE_FORWARDED_EVENTS` 未转发

官方 apiproxy (`api-proxy.js:3289-3294`) 还转发 11 个白名单事件（verbatim wrapper）：

```
agent-preset/selected, commands/change, credentials/updated,
cordis/request-run, cordis/request-run-resolved,
cordis/dynamic-package, cordis/dynamic-retract,
cordis/inspect-query, cordis/inspect-query-resolved,
llm/adapters-updated, settings/document-updated
```

dsh-mini gui-ws.js **完全不转发这些**。后果：桌面端切换 agent preset / 修改命令 / 更新凭据 / 改设置 / LLM 适配器变化 → 手机端不实时反映（需手动刷新页面）。

来源：`dsh-api-remotes/lib/types/remote-events.js:16-28`

### 1.6 修复方案

#### 1.6.1 补全 `domain/changed` 监听（`lib/gui-ws.js` startHost）

在 `startHost()` 的 `ctx.on(...)` 列表中新增 `domain/changed` 监听，对齐官方 `api-proxy.js:3229-3285`：

```js
ctx.on("domain/changed", (change) => {
    if (change.domain !== "workspace") return;
    const workspaceRegistry = ctx.get("workspaceRegistry");
    if (!workspaceRegistry) return;

    if (change.table === "") {
        // 全局 workspace 状态变更（order / archived）
        // change.value = workspaceDomainState（含 workspaceIds + archivedSessionIds）
        if (change.operation !== "put") return;
        try {
            const state = change.value; // 可能需要 workspaceDomainState.parse
            const ids = state.workspaceIds || (state.workspaces ? state.workspaces.map(w => w.id) : []);
            // 新增的 workspace → host/workspace-changed
            for (const wid of ids) {
                const w = workspaceRegistry.get ? workspaceRegistry.get(wid) : null;
                if (w) push({ type: "host/workspace-changed", workspace: workspaceView(w) });
            }
            // order 变化 → host/workspace-order-changed
            if (ids.length) push({ type: "host/workspace-order-changed", workspaceIds: [...ids] });
            // archived 变化 → host/archived-sessions-changed
            const arch = workspaceRegistry.archivedSessionIds;
            const archList = typeof arch === "function" ? arch() : (Array.isArray(arch) ? arch : []);
            push({ type: "host/archived-sessions-changed", archivedSessionIds: [...archList] });
        } catch { /* ignore */ }
        return;
    }
    if (change.table !== "workspaces") return;
    if (change.operation === "deleted") {
        push({ type: "host/workspace-removed", workspaceId: change.key });
        return;
    }
    // 单个 workspace 记录变更（含 sessionIds 更新）
    // change.value = workspaceRecord（含 path/title/sessionIds/createdAt/updatedAt）
    try {
        push({
            type: "host/workspace-changed",
            workspace: changedWorkspaceView(change.key, change.value),
        });
    } catch { /* ignore */ }
});
```

辅助函数（对齐官方 `api-proxy.js:820-841`）：

```js
function workspaceView(w) {
    return {
        workspaceId: w.id || w.workspaceId,
        path: w.path || "",
        title: w.title || "",
        sessionIds: [...(w.sessionIds || [])],
        createdAt: w.createdAt || "",
        updatedAt: w.updatedAt || "",
    };
}
function changedWorkspaceView(workspaceId, value) {
    // value 可能是 workspaceRecord 或已解析对象
    const record = value && typeof value === "object" ? value : {};
    return {
        workspaceId: workspaceId,
        path: record.path || "",
        title: record.title || "",
        sessionIds: [...(record.sessionIds || [])],
        createdAt: record.createdAt || "",
        updatedAt: record.updatedAt || "",
    };
}
```

#### 1.6.2 修复 `session/created` 帧 cwd 提取

`gui-ws.js:209-218` 改为从 `session.header` 提取字段：

```js
ctx.on("session/created", (session) => {
    if (!session) return;
    const header = session.header || {};
    push({
        type: "host/session-added",
        sessionId: session.id,
        blank: !session.running && !(Array.isArray(session.events) && session.events.length),
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
        ...(header.origin === undefined ? {} : { origin: header.origin }),
    });
});
```

> 注：`agentPreset` 的提取依赖 `resolveSessionPreset({header, events})`，dsh-mini 目前没有引入该函数。如需完整对齐，可从 `dsh-host-apiproxy` 导入或简化为读 `header.agentPreset`。P0 阶段可先不传 agentPreset（前端有 fallback）。

#### 1.6.3 补全 `API_REMOTE_FORWARDED_EVENTS` 转发（可选，P1）

在 `startHost()` 的 disposers 中新增：

```js
const FORWARDED = [
    "agent-preset/selected", "commands/change", "credentials/updated",
    "cordis/request-run", "cordis/request-run-resolved",
    "cordis/dynamic-package", "cordis/dynamic-retract",
    "cordis/inspect-query", "cordis/inspect-query-resolved",
    "llm/adapters-updated", "settings/document-updated",
];
for (const name of FORWARDED) {
    try {
        subs.push(ctx.on(name, (...args) => {
            // 官方转发：整帧包装为 server-request，payload = 原事件 payload
            // 需确认每个事件的 payload 形状；最简方案：透传第一个参数（若有）
            const payload = args[0];
            if (payload && typeof payload === "object") push(payload);
        }));
    } catch { /* event not mounted, skip */ }
}
```

> 风险：dsh-mini 不依赖 `@deepseek-ai/dsh-api-remotes`，需硬编码列表。若 DSH 版本升级增减事件，此处需同步。可加 try/catch 逐个注册，缺失事件静默跳过。

### 1.7 验收清单（P0 同步修复）

- [ ] 手机连着 WS host 流时，电脑端 DSH 新建会话 → 手机端侧栏 ≤1s 内出现该会话（在对应工作区分组下）
- [ ] 电脑端删除/归档会话 → 手机端侧栏对应消失/移入归档
- [ ] 电脑端创建/删除/重命名工作区 → 手机端侧栏工作区列表实时更新
- [ ] 电脑端拖拽会话到另一工作区 → 手机端侧栏分组变化
- [ ] `host/session-added` 帧含 `cwd` 字段（抓帧验证）
- [ ] `host/workspace-changed` 帧含最新 `sessionIds`（抓帧验证）
- [ ] 回归：注入器热重载后 WS 重连、初始快照正常
- [ ] 回归：`smoke.ps1` + `pubmode.ps1` 仍 PASS

---

## 2. P1 — 连接方案升级（7 个已知弱点）

### 2.1 弱点总表

| # | 弱点 | 影响 | 优先级 | 方案章节 |
|---|------|------|--------|----------|
| 1 | 混合内容阻断 | 浏览器 HTTPS 页无法探测 HTTP LAN，只显示 pill 链接 | P1 | §2.2 |
| 2 | 整页重载切换 | `location.replace` 丢失 UI 状态（滚动/草稿/视图） | P1 | §2.2 |
| 3 | 单连接硬切 | 无双 WS 热备，切换即断流 | P2 | §2.3 |
| 4 | Quick Tunnel 域名不稳 | 每次重启换随机域名 → QR 失效 | P2 | §2.4 |
| 5 | watchdog 外挂 | 绑开发环境路径 `E:\DSH Zone\.tools\` | P2 | §2.5 |
| 6 | 无偏好持久化 | 用户无法设优先网络 | P3 | §2.6 |
| 7 | WS 不跨 origin 重连 | 切 origin 必须重载页面 | P2 | §2.3 |

### 2.2 弱点 1+2：混合内容阻断 + 整页重载切换

#### 2.2.1 现状

当前 `netBootJs`（`lib/index.js:662-761`）逻辑：
- `fetchJson('/api/base')` 获取候选 URL（lanUrl + publicUrl）
- `ping()` 测 RTT
- `decide()`: LAN RTT < 2600ms 且 public 不优 0.6× → 选 LAN，否则选 public
- `trySwitch()`: `location.replace(best.base)` + 60s 冷却
- **HTTPS 页面 → HTTP LAN 探测被浏览器混合内容策略拦截** → 只显示「切到内网」pill 链接
- HTTP 页面 → 双向自动切换可用

APK WebView 因 `MIXED_CONTENT_ALWAYS_ALLOW`（`MainActivity.java:108`）不受此限。

#### 2.2.2 方案：SPA 内 RPC 端点热切换（不重载页面）

**核心思路**：不切 origin，只切 RPC/WS 的目标 baseURL。手机端 JS 维护一个 `activeBase` 变量，所有 `fetch()` 和 `new WebSocket()` 都用 `activeBase` 拼路径。切换时：
1. 新建到新 base 的 WS 连接
2. 等新 WS 收到基线帧后，切换 `activeBase`
3. 关闭旧 WS
4. 不重载页面 → UI 状态（滚动/草稿/视图）完整保留

**实现要点**：

```
// 前端（注入 mobilePatch 或 netBootJs 升级）
let activeBase = location.origin;  // 当前 RPC/WS 目标
let muxWs = null, hostWs = null;   // 当前 WS 连接

async function switchBase(newBase) {
    // 1. 先建新 WS
    const newMux = new WebSocket(newBase.replace(/^http/, 'ws') + '/api/events.mux?token=' + token);
    const newHost = new WebSocket(newBase.replace(/^http/, 'ws') + '/api/events.host?token=' + token);
    // 2. 等新 WS 收到基线帧（session/subscribed + host/workspace-changed）
    await Promise.all([waitForOpen(newMux), waitForOpen(newHost)]);
    // 3. 切换 activeBase
    activeBase = newBase;
    // 4. 旧 WS 优雅关闭
    muxWs?.close(1000, 'switching'); hostWs?.close(1000, 'switching');
    muxWs = newMux; hostWs = newHost;
    // 5. 更新 UI 指示器（不重载）
    updateConnectionBadge(newBase);
}
```

**混合内容问题的处理**：
- HTTPS 页面（外网隧道）→ HTTP LAN：`fetch('http://<lan-ip>:46322/api/ping')` 被浏览器拦 → **无法探测 RTT**
- 解决：改用 **WebSocket 探测**（`ws://<lan-ip>:46322/api/events.mux` 带 token）—— 但混合内容策略同样拦 `wss://` 页面建 `ws://` 连接
- 最终方案：**HTTPS 页面只显示「切到内网」pill 链接**（维持现状），但 pill 点击后走 `switchBase()` 而非 `location.replace()` —— **如果**用户在 HTTP 页面或 APK 内，则可自动探测+热切换

> **结论**：混合内容阻断是浏览器安全策略，无法绕过（APK 除外）。升级点在于：能用热切换的场景（HTTP 页 / APK）不再整页重载。

#### 2.2.3 验收

- [ ] HTTP 页面：LAN↔public 自动切换不重载页面，滚动位置/草稿/当前视图保留
- [ ] HTTPS 页面：显示「切到内网」pill，点击后尝试热切换（若混合内容允许）或提示手动
- [ ] APK 内：双向自动热切换，UI 状态完整保留

### 2.3 弱点 3+7：单连接硬切 + WS 不跨 origin 重连

#### 2.3.1 方案：双 WS 热备 + 跨 origin 重连

在 `switchBase()` 基础上扩展：
- 维护 `primaryWs`（当前活跃）和 `standbyWs`（备用候选 base 的 WS）
- 备用 WS 只收不处理（保持连接热备）
- 主 WS 断开时，备用 WS 立即升为主 → 零中断
- 跨 origin 重连 = `switchBase(newOrigin)` 的自然结果

**实现复杂度**：中等。需在前端 JS 中管理两条 WS 的事件去重（两条都推 `session/event`，需按 seq 去重）。

#### 2.3.2 简化方案（推荐 P2）

不做双 WS 热备（复杂度高、去重逻辑易出 bug），改为：
- 单 WS + **快速重连**：WS 断开时 200ms 内重连同 base；连续失败 3 次后触发 `switchBase()` 到备用 base
- 跨 origin 重连：`switchBase()` 本身支持跨 origin（§2.2.2），不需要重载页面

### 2.4 弱点 4：Quick Tunnel 域名不稳

#### 2.4.1 现状

cloudflared Quick Tunnel 每次重启换随机 `*.trycloudflare.com` 域名 → QR 失效 → 需重扫。
watchdog 已自动同步新 publicUrl 到 dsh-mini config，但手机端已扫的旧 QR 失效。

#### 2.4.2 方案：Named Tunnel（稳定域名）+ fallback Quick Tunnel

- **推荐升级路径**：用户把自有域名 NS 交给 Cloudflare → 用 Named Tunnel → 域名永久稳定
- **Quick Tunnel 保留为 fallback**：无域名时仍可用，watchdog 自动同步
- **手机端应对**：手机端检测 WS 断开 → `fetchJson('/api/base')` 获取最新 publicUrl → `switchBase()` 热切换到新域名
- **QR 失效提示**：手机端 WS 断开超过 10s → 显示「连接已断开，可能需要重新扫码」+ 按钮「获取最新地址」（调 `/api/base`）

> 插件侧无需改动（watchdog 已自动同步 publicUrl）。改进点在前端断线处理。

### 2.5 弱点 5：watchdog 外挂

#### 2.5.1 现状

`tunnel-watchdog.ps1` 绑定 `E:\DSH Zone\.tools\cloudflared.exe`，脱离插件，依赖 Task Scheduler + 启动文件夹，绑开发环境路径。

#### 2.5.2 方案：插件内置隧道管理（F-1 未来项）

- 插件 host 侧 `spawn` cloudflared 进程并管理生命周期
- 自动提取公网 URL 写回 config.json
- 进程崩溃自动重拉
- 不依赖外部脚本/Task Scheduler

> 这是 `SPEC-v4` 的 F-1 未来项。P2 阶段可先不内置，但把 watchdog 脚本打包进插件 `scripts/` 目录，路径改为相对 `MINI_HOME`。

### 2.6 弱点 6：无偏好持久化

#### 2.6.1 方案：config 新增 `networkPreference` 字段

```json
{
  "networkPreference": "auto"  // "auto" | "lan" | "wan"
}
```

- `auto`（默认）：当前行为（RTT 探测自动选）
- `lan`：强制优先 LAN（不可达时 fallback public）
- `wan`：强制优先 public（不可达时 fallback LAN）

前端 `decide()` 读取偏好，跳过/调整 RTT 比较逻辑。桌面设置卡新增单选。

---

## 2.7 允许外网访问开关（新增需求，2026-08-18 已实施）

### 2.7.1 需求

用户原话：「在设置中加入允许外网访问的开关，关闭后只允许内部局域网使用」；后续追认 **默认关闭**（安全默认）。

**默认值确认**（2026-08-18）：`lib/index.js` `loadConfig()` 的 `publicMode = cfg.publicMode === true` —— 无配置/新装时即 `false`（关闭），`saveConfig` 无默认 true 分支，桌面设置卡开关跟随 `gw.publicMode`（`src/client.js` `useState(gw.publicMode === true)`）无硬编码 true。三条路径一致默认关闭，**无需改代码**；仅需用户侧关闭当前运行实例（config `publicMode:false`）即生效（外网来源 403、URL 回切 LAN、`external.enabled=false`），关闭后若重开只影响待填 publicUrl 的一方（watchdog 每 12s 仅同步 `publicUrl`，不会顶回 `publicMode`）。

v1.4.0 的 `publicMode`（「外网穿透」）语义是「开启后强制一切请求带 token」——但**关闭时并不拒绝外网流量**：
同机隧道（cloudflared/frp/cpolar）转出的请求 `remoteAddress` 是回环、且不带 `x-dsh-mini-gateway` 头，
在 `publicMode=false` 下会被 `isLoopback` 免鉴权放行（SPEC-v4 §5.1 的洞在关闭态依旧存在）。用户要求的是一个**真正的来源开关**：
关闭后外网来源（公网域名 / 公网 IP）即使带 token 也必须被拒绝。

### 2.7.2 方案：Host 头来源判定（`isExternalHost`）

隧道转发会**保留原始公网 Host 头**，而本机/局域网访问网关的 Host 一定是本地地址——用 Host 头区分来源：

| 访问方式 | Host 头 | 判定 |
|---|---|---|
| 本机回环 | `127.0.0.1:46322` / `localhost` / 本机主机名 | 内网 |
| 局域网手机 | `192.168.2.3:46322` 等私有 IP | 内网（`isPrivateIp`） |
| 局域网 IPv6 | `[fe80::1]` 链路本地 / `[fd00::1]` ULA | 内网 |
| **cloudflared/frp/cpolar 隧道** | `xxx-xxx.trycloudflare.com`（公网域名） | **外网 → 关闭时 403** |
| 公网直连 / NAT 映射 | 公网 IP | **外网 → 关闭时 403** |
| 自定义域名（Named Tunnel） | `my.dsh.cc` | **外网 → 关闭时 403** |

`isExternalHost(req)`（`lib/index.js` isLoopback 附近）解析 Host 头 hostname：
1. 空 Host → 非外网（HTTP/1.0 直连，由 token 把关）
2. `localhost` / `localhost.localdomain` / 本机 `os.hostname()` → 非外网
3. 本机任一网卡 IP（`networkInterfaces()`）→ 非外网
4. `isPrivateIp(hostname)` → 非外网
5. 其余（公网域名 / 公网 IP / 自定义域名）→ **外网**

`isPrivateIp`：`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`（CGNAT）、IPv6 `fe80::/10` 链路本地、`fc00::/7` ULA、`fec0::/10` 站点本地、`::1`。

### 2.7.3 拦截点（关闭时 `!publicMode && isExternalHost(req)` → 403）

| 位置 | 实现 | 覆盖 |
|---|---|---|
| `lib/index.js` startGateway `createServer` handler **顶端**（`/api/ping` 分支之前） | `external access disabled` 403 | GUI 根 / 静态 / RPC `POST /api/*` / 旧协议反代 `/dsh-mini/*` / 无鉴权 ping |
| `lib/index.js` `authGuiWs()` 首行 | return false → WS upgrade 403 | `/api/events.mux` + `/api/events.host` |

关键点：拦截在**鉴权之前**，故关闭时外网来源即使带正确的 token 也被拒绝（语义 = 「不允许外网访问」，而非「外网需 token」）。`/api/ping` 为无鉴权探测路径，同样被拦（关闭时外网设备无法 ping）。

### 2.7.4 设置 UI（`src/client.js`）

- 「外网穿透」开关改名为 **「允许外网访问」**，仍绑定 `publicMode`。
- hint 文案：关闭 = 仅内部局域网（回环/本机/局域网 IP 可访问，公网域名或公网 IP 的请求【含隧道转出的连接】一律拒绝，即使带连接密钥）；开启 = 允许外网（强制 token，二维码切公网地址，局域网不受影响）。
- 无独立新配置字段——语义即 `publicMode` 的收紧（关闭态从「仅凭 remoteAddress+tid」升级为「来源+token 双把关」）。

### 2.7.5 与现有行为的关系

- `publicMode=true`：不变。一切请求（含 LAN、回环形态隧道）强制 token；来源判定不介入（`!publicMode` 为 false）。
- `publicMode=false`（关闭）：新增来源拦截——外网 403，本机/LAN 保持「回环免鉴权 / LAN 带 token」原行为。
- watchdog 兼容：watchdog 只 POST `{publicUrl}` 不动 `publicMode`；关闭期间隧道流量 403 属预期（watchdog 假死检测阈值 `deadStreak>=5` 需约 60s 才会触发重启，瞬时关闭不受影响）。
- **回归验证 22/22 PASS**（`scripts/test-allow-external.cjs`）：关闭（回环/LAN/私有/内网IPv6=200；隧道域名/公网IP/自定义域名/带token/根路径/RPC/旧协议/WS=403）+ 开启（无token全403，公网+token 302/WS 101）。

---

## 3. 实施计划

### 3.1 分阶段交付

| 阶段 | 内容 | 改动文件 | 验收 |
|------|------|----------|------|
| **P0-a** | `domain/changed` 监听补全 | `lib/gui-ws.js` | §1.7 前 6 项 |
| **P0-b** | `session/created` cwd 修复 | `lib/gui-ws.js` | §1.7 cwd 抓帧 |
| **P0-c** | `API_REMOTE_FORWARDED_EVENTS` 转发（可选） | `lib/gui-ws.js` | 桌面切 preset→手机实时反映 |
| **P1-a** | SPA 热切换（不重载） | `lib/index.js` netBootJs + 前端注入 | §2.2.3 |
| **P1-b** | networkPreference 持久化 | `lib/index.js` loadConfig + client.js 设置卡 | §2.6 |
| **P2** | 快速重连 + 断线处理 + watchdog 打包 | 前端 + scripts | §2.3 + §2.4 + §2.5 |

### 3.2 P0 实施细节（gui-ws.js 改动）

#### 3.2.1 新增辅助函数（文件顶部 toolViewFor 附近）

```js
function workspaceView(w) {
    return {
        workspaceId: w.id || w.workspaceId,
        path: w.path || "",
        title: w.title || "",
        sessionIds: [...(w.sessionIds || [])],
        createdAt: w.createdAt || "",
        updatedAt: w.updatedAt || "",
    };
}
function changedWorkspaceView(workspaceId, value) {
    const r = value && typeof value === "object" ? value : {};
    return {
        workspaceId: workspaceId,
        path: r.path || "",
        title: r.title || "",
        sessionIds: [...(r.sessionIds || [])],
        createdAt: r.createdAt || "",
        updatedAt: r.updatedAt || "",
    };
}
```

#### 3.2.2 startHost 修改

**session/created handler**（替换 `gui-ws.js:209-218`）：

```js
ctx.on("session/created", (session) => {
    if (!session) return;
    const header = session.header || {};
    push({
        type: "host/session-added",
        sessionId: session.id,
        blank: !session.running && !(Array.isArray(session.events) && session.events.length),
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
        ...(header.origin === undefined ? {} : { origin: header.origin }),
    });
}),
```

**新增 domain/changed handler**（在 `agent/error` handler 之后）：

```js
ctx.on("domain/changed", (change) => {
    if (!change || change.domain !== "workspace") return;
    const wr = ctx.get("workspaceRegistry");
    if (!wr) return;
    try {
        if (change.table === "") {
            if (change.operation !== "put") return;
            const state = change.value || {};
            const ids = state.workspaceIds || [];
            for (const wid of ids) {
                const w = wr.get ? wr.get(wid) : null;
                if (w) push({ type: "host/workspace-changed", workspace: workspaceView(w) });
            }
            if (ids.length) push({ type: "host/workspace-order-changed", workspaceIds: [...ids] });
            const arch = wr.archivedSessionIds;
            const archList = typeof arch === "function" ? arch() : (Array.isArray(arch) ? arch : []);
            push({ type: "host/archived-sessions-changed", archivedSessionIds: [...archList] });
            return;
        }
        if (change.table !== "workspaces") return;
        if (change.operation === "deleted") {
            push({ type: "host/workspace-removed", workspaceId: change.key });
            return;
        }
        push({ type: "host/workspace-changed", workspace: changedWorkspaceView(change.key, change.value) });
    } catch { /* ignore */ }
}),
```

#### 3.2.3 初始快照可保留（不冲突）

dsh-mini 现有的初始 workspace 快照推送（`gui-ws.js:186-206`）与官方不同（官方不推初始帧，靠 RPC `workspace.list` 拉取），但 **不冲突** —— 前端 `upsert()` 是幂等的，重复帧无害。保留即可，无需改。

---

## 4. 风险与依赖

- **`domain/changed` 事件 payload 形状**：官方用 `workspaceDomainState.parse(change.value)` 和 `workspaceRecord.parse(change.value)` 做严格解析。dsh-mini 不依赖 `dsh-workspace`，用 duck-typing（`change.value.workspaceIds` / `change.value.sessionIds`）即可。若 DSH 版本升级改了 payload 结构，需同步。可在 `try/catch` 中静默失败，不会崩溃。
- **`session.header` 可能为空**：新建会话时 `session.header` 可能尚未填充（取决于 DSH 内部时序）。若 `header.cwd` 为 undefined，帧里不含 cwd —— 与官方行为一致（官方 `sessionListFields` 也判 `header.cwd === undefined`）。前端会将该会话放入 Ungrouped 桶，但 `host/workspace-changed` 会随后到达并更新 `sessionIds`，会话仍可见。
- **热切换的 WS 事件去重**：若实现双 WS 热备（P2 扩展），两条 WS 都推 `session/event`，需按 `event.seq` 去重。简化方案（单 WS 快速重连）无此问题。

---

## 5. 未来项（本规格范围外）

- F-1：插件内置 cloudflared 生命周期管理（§2.5.2）
- F-2：`publicRpcAllow` 预设档一键切换（readonly / chat / full）
- F-3：QR 一次性 short-lived token（扫码后 60s 换正式 cookie）
- F-4：双 WS 热备（§2.3.1，若简化方案不够用）

---

## 附录 A：关键代码锚点

### 官方 apiproxy（参照基准）
- `dsh-host-apiproxy/lib/types/api-proxy.js:3199-3285` — host() 完整事件监听（5 类 + forwarded）
- `dsh-host-apiproxy/lib/types/api-proxy.js:408-419` — `sessionListFields(header, events)`
- `dsh-host-apiproxy/lib/types/api-proxy.js:820-841` — `workspaceView(w)` / `changedWorkspaceView(id, value)`
- `dsh-api-remotes/lib/types/remote-events.js:16-28` — `API_REMOTE_FORWARDED_EVENTS` 白名单

### dsh-mini（待修改）
- `lib/gui-ws.js:182-240` — startHost（需补 domain/changed + 修 cwd）
- `lib/gui-ws.js:209-218` — session/created handler（cwd 提取错误）
- `lib/gui-ws.js:186-206` — 初始 workspace 快照（保留）
- `lib/index.js:662-761` — netBootJs（P1 热切换改造）
- `lib/index.js:325-350` — loadConfig（P1 networkPreference 扩展）

### 前端（参照，不改）
- `dsh-client-runtime/client.js:8367-8378` — handleHostEnvelope 'host/session-added'
- `dsh-client-runtime/client.js:9632` — handleHostEnvelope 'host/workspace-changed'
- `dsh-client-ui-workspace/client.js:148-163` — groupByWorkspace 分组逻辑
- `dsh-client-connection/client.js:9072-9103` — fixture session.create（两帧佐证）

---

## 6. 实施记录（v1.4.1 · P0 验证 + 审查优化，2026-08-18）

### 6.1 P0 同步修复 —— 验证通过（PASS 8/8）

根因调查**确定性结论**：事件桥本身一直正常，真凶有二（均非插件逻辑）：

1. **真凶 1（ESM require）**：`lib/gui-ws.js` 是 ESM 模块，调试期误用 `require("node:fs")` → ReferenceError，debug 日志写不出 → 误诊「事件收不到」。修复：顶部 `import { appendFileSync } from "node:fs"`（已随清理移除）。
2. **真凶 2（验证脚本时序）**：`scripts/verify-p0-sync.cjs` 用 `await wsCollect(...)` 挂起 8s 收集窗口，`session.create` 在 socket 销毁**之后**才执行 → 帧永远到不了（时间戳铁证：WS 连接 13:38:09，session/created 13:38:17.370=8s 后）。修复：重构为 `startCollect(pathStr, durationMs)` 返回 `{ frames: 共享数组, done: Promise }` —— **先启动收集 → 做 RPC → 再 await done 收口**。RPC 鉴权用首跳 cookie（`POST + ?token=` 会被 authGuiRequest 302 换 cookie，故 POST 不能走 query）。

**验证结果（publicMode=true 下实测）**：
```
PASS 模拟首跳 → 会话 cookie
PASS session.create（cwd=临时目录）
PASS 收到 host/session-added（含新会话）· cwd=...
PASS session-added 带 cwd(from header)
PASS 收到 host/workspace-changed（基线 1 帧）
PASS workspace.sessionIds 含新会话（无 workspace 时跳过增量断言）
PASS 清理 workspace.deleteSession
PASS 收到 host/session-removed
RESULT: PASS (8 pass, 0 fail)
```
> 注：临时 cwd 不注册为 workspace，故「workspace-changed 增量含新会话」在测试环境自动跳过——真实桌面工作区场景由 §1.6.1 `domain/changed` 增量覆盖（事件可达已由 debug 铁证）。核心修复（session-added 带 cwd）已坐实。

### 6.2 调试残留清理（lib/gui-ws.js，消除泄漏）

删除三处 TEMP DEBUG，修复「每次 WS 连接泄漏 3 个永久全局 listener」：
- `internal/dispatch` 全局监听（写 ws-debug-dispatch.log）
- SVCCTX 探测 for 循环（在 sessions/workspaceRegistry/webServer 服务 ctx 注册 `sc.on('session/created')`，未入 subs → 泄漏）
- `session/created` handler 内联 debug（写 ws-debug-created.log）

连带删除无用的 `import { appendFileSync }`。清空仓库根 `ws-debug-*.log`。
> 已知限制：开发期（super-injector 热重载）泄漏的旧版全局 listener 驻留在 ctx.root，热重载清不掉，**正式重启 DSH Desktop 后即净**（新版代码已无任何日志写入）。

### 6.3 审查发现（写入 spec 的风险面）

1. **`session.prompt` 缺官方 `saveImages` 步骤**（`lib/gui-api.js:699-730` vs 官方 `api-proxy.js:52-65`）：dsh-mini 直接把含 `{mediaType, data:base64}` 的 image content 传给 `createUserMessage`+`agent.followup`，官方是在上传时 `ctx.attachments.saveImages(...)` 落库并换 attachment 引用。**待确认**：agent 层是否接受 base64 image block；若不接受，手机上发图片会退化（v1.2 走旧 `/upload`+绝对路径+`view_image` 提示，GUI 化后走此路径）。**P1 优先跟进**。
2. **RPC body 16MB vs base64 膨胀**：网关 `handleGuiPost` 原 `readBody(req, 16MB)`，`session.prompt` 携带 base64 图片（膨胀 ~1.33×）→ `maxUploadMb>=12MB`（publicMode 钳 50MB）时 413。**已修**（§6.4-2）。
3. **`__wsProbeLog` WebSocket 调试 hook**：`buildGuiledIndex` polyfill 里 hook 全局 `WebSocket` 记录 OPEN/ERR/CLOSE（生产污染）。**已移除**（§6.4-1）。
4. **proxyToUpstream 透传 hop-by-hop 头**：`up.headers` / `req.headers` 原样转发，可能带 `connection`/`transfer-encoding` 造成上游连接语义混淆。**已修**（§6.4-3）。
5. **授权面观察**：`authGuiRequest` 对任何带有效 `?token=` 的请求（含 POST RPC）都 302 换 cookie——前端走 cookie 方案不受影响，但 `POST + ?token=` 无法直接放行（verify 曾踩坑）。维持现状，文档注明。
6. **`/api/base` 返回明文 token**：已鉴权（同源 cookie）才返回，可接受；attach 的 lanUrl/publicUrl 各含 token，属「已鉴权页可见」等价信息。

### 6.4 本轮执行的低风险优化（均已验证）

1. **移除 `__wsProbeLog` WebSocket hook**（`lib/index.js:599`）——纯清理，生产不再污染全局 `WebSocket`。
2. **RPC body 上限对齐上传钳制**（`lib/index.js` `handleGuiPost`）：`readBody` 上限从固定 16MB 改为 `max(24MB, maxUploadMb×1.6)`，防 base64 图片上传在 `maxUploadMb≥12MB` 时 413。
3. **hop-by-hop 头剥离**（`lib/index.js` `proxyToUpstream` / `stripHopByHop`）：代理入/出方向剥离 `connection`/`keep-alive`/`transfer-encoding`/`upgrade`/`te`/`trailer`/`proxy-*`，避免 HTTP/1.1 连接语义混乱（RFC 7230）。

### 6.5 回归验证（改动后全绿）

| 验证 | 结果 |
|---|---|
| `node --check lib/index.js` / `lib/gui-ws.js` | exit 0 |
| `verify-p0-sync.cjs`（事件桥） | **PASS 8/8** |
| `smoke.ps1`（publicMode=false，RPC 面 14 项） | **PASS**（临时关 publicMode 实测后还原） |
| `pubmode.ps1`（publicMode 正/负矩阵 24 项） | **PASS**（自动还原；结束后手动恢复 live publicMode=true） |
| live 状态 | publicMode=true + publicUrl=https://graphical-conducting-capital-thesis.trycloudflare.com + listening=true ✓ |
| 调试残留 | 文件扫描无 `appendFileSync`/`ws-debug`/`SVCCTX`/`TEMP DEBUG` 残留 |

### 6.6 未做项（留待后续轮次，见 §3/§5 优先级）

- P1-a SPA 热切换（不重载页面）· P1-b networkPreference 持久化
- P1-c **`session.prompt` 图片走 `saveImages`（§6.3-1）**
- P2 快速重连 / watchdog 打包进插件 / 断线处理
- F-1 内置 cloudflared 管理 · F-2 publicRpcAllow 预设档 · F-4 双 WS 热备
