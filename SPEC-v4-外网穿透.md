# DSH-Mobile 外网穿透 · 开发规格（SPEC v4）

版本：v4（草案，draft）
适用基线：`@deepseek-ai/dsh-mini` v1.4.0（`lib/index.js` / `lib/gui-ws.js` / `lib/gui-api.js` / `lib/client.js`）

> 本文是「把 dsh-mini 从『仅局域网可用』升级为『可内网穿透到外网使用』」的完整开发规格。
> 依据用户问答结论编写（见 §0）；核心主张：**插件主体不动，独立隧道代理在 LAN 网关（LAN gateway, 默认 `0.0.0.0:46322`）之前**；但有一个**必改的安全洞**（§5），必须随本规格一并落地，否则穿透即裸奔。

---

## 0. 决策记录（用户问答）

| 议题 | 用户选择 | 对本规格的影响 |
| --- | --- | --- |
| 穿透方案 | 插件不动 + 独立隧道代理（推荐项） | 架构主线 = 隧道（cloudflared/ngrok/frp）反代到 LAN 网关端口；插件仅做最小增量改造 |
| 插件形态 | 不确定（本次已从代码判定） | dsh-mini 是「手机桥」：`lib/index.js` 在 DSH webServer 内挂 `/dsh-mini/*`，`startGateway()` 另起 `0.0.0.0:<port>` 网关，服务 v3 GUI（根路径 + `/assets` + `/plugins` + RPC + 双 WS 下推）并反代旧 `/dsh-mini/*` 到主端口 |
| 鉴权 | 已有登录/鉴权，保持即可 | token（`~/.dsh/dsh-mini/token.txt` / `DSH_MINI_TOKEN`）是唯一钥匙；穿透后必须**仍被强制执行**（当前模型有 loopback 豁免，见 §5） |
| HTTPS | 不强制 | 但 cloudflared 免费隧道天然给 HTTPS；正文按「默认 HTTPS、明文仅限自用测试」设计（§8） |
| 访问性质 | 读写 | 外网持 token 者能：发消息/附件、接管会话、切模型、停生成、`commands/execute`、`credentials.set/unset`、`settings.*`、`host.*` 文件操作。§5.4 / §13 必须给失控兜底与最小化建议 |
| 基础设施 | 无服务器，倾向免费方案 | 主推 **cloudflared Quick Tunnel**（无需账号、免费、自带 HTTPS、随机 `*.trycloudflare.com`）；frp 因无 VPS 排除为主方案；ngrok 免费档需注册 |

---

## 1. 背景与现状（LAN-only 根因）

dsh-mini 当前「只能局域网用」的根因，逐条列出（改造时逐条对照）：

1. **QR/连接 URL 由 `gatewayStatus()` 生成为 `http://<首个LAN-IPv4>:<gatewayPort>/?token=<token>`**（`lib/index.js:806-842`，URL 拼在 815-819）。LAN IP 对外网不可达 → 外网扫同一 QR 必然连不上。
2. **鉴权模型依赖「loopback == 本机用户」假设**：
   - `assertAuth()`（`lib/index.js:271-287`）`isLoopback(req) && !x-dsh-mini-gateway` ⇒ 免 token；
   - `authGuiRequest()`（145-164）同样：`isLoopback && !x-dsh-mini-gateway` ⇒ 放行（不用会话/token）；
   - `authGuiWs()`（166-172）同构：WS upgrade 还允许 `?token=`；
   - `isLocalDirect()`（208-210）+ 4 个 loopback-only 管理端点：`POST /gateway/config`（876）、`POST /gateway/token/reset`（910）、`POST /balance/report`（923）、`GET|POST /client-beacon`（937/942）。
   - 局域网内手机从 192.168.x.x 进来 ⇒ remoteAddress 非回环 ⇒ 必须带 token，逻辑正确。
3. **网关**：`startGateway()`（`lib/index.js:703-804`）在 `0.0.0.0:<gatewayPort>`（默认 46322）独立 `http.createServer`：(a) 反代 `/dsh-mini/*` 到主端口并盖 `x-dsh-mini-gateway: 1`（`proxyToUpstream`，652-701）；(b) 原生服务 v3 GUI 根路径/静态/插件 bundle/RPC/双 WS（`gui-ws.js` 的 `/api/events.mux` + `/api/events.host`）。
4. **WS/Origin 无校验**：`gui-ws.js` upgrade 只查路径 + `authFn(req,url)`，不校 Origin/Host ⇒ 隧道域名穿透友好，但也没有任何防 CSRF 型来源检查（配合 `Access-Control-Allow-Origin: *`；token 在 URL 外人拿不到即无碍，见 §5.4）。
5. **遗留调试**：`gui-ws.js:11` `WS_DEBUG_LOG = "E:\\DSH Zone\\dsh-mini\\ws-debug.log"`，每次 upgrade 调 `appendFileSync`（标注 TEMP DEBUG）。改造必须移除（见 §7.6）。

---

## 2. 目标与非目标

### 目标（本规格要交付的）
- G1：外网设备（手机 APK / 手机浏览器）经公网地址访问 dsh-mini，体验与局域网一致：GUI 加载、会话列表/接管、收发消息/附件、SSE/WS 实时下推、切换模型/推理档、停止生成、余额徽章。
- G2：**保持并强制执行既有 token 鉴权**——穿透后任何外网请求都必须过 token（当前 loopback 豁免会把同机隧道流量误判为本机，§5 必改名目）。
- G3：二维码/连接 URL 变为公网 URL（`publicUrl` + `?token=`），桌面端设置与 QR 实时反映外网地址。
- G4：不要求公网服务器、不强制账户（免费路线），默认 HTTPS。
- G5：插件改动最小化、向后兼容（局域网行为完全不变），并符合注入器热重载/自愈规范（所有注册走 `ctx.effect`、路由自愈）。

### 非目标
- N1：不改 dsh-mini 的会话/附件/模型/消息协议本身。
- N2：不做「插件内置穿透二进制/自动拉起 cloudflared 进程」这类侵入式集成（用户选独立隧道代理；内置化留作 F-未来项 §14）。
- N3：不做多租户/账号体系/细粒度 RBAC（个人手机桥）。`publicRpcAllow` 白名单调节属于可选加固（§7.5），默认全开以保持行为一致。
- N4：不强制 HTTPS 证书管理进插件（证书终结在隧道端点）。

---

## 3. 架构基线（不变式）

```
外网设备 ──HTTPS──> 隧道公网端点(cloudflared/ngrok/frp) ──loopback连接──> 本机 <gatewayPort>(默认46322) ──>[dsh-mini LAN网关]
                                                                          ├─ 服务 v3 GUI 根路径( __DSH_BOOT__ + 移动端补丁)
                                                                          ├─ /assets/* /plugins/<id>/client.js  静态
                                                                          ├─ POST /api/<method>                 GUI RPC(信封 {type,rpcId,method,payload})
                                                                          ├─ GET/POST /dsh-mini/api/*           旧协议(反代回主端口,盖 x-dsh-mini-gateway:1)
                                                                          └─ WS  /api/events.mux + /api/events.host  实时下推
```

不变式（安全/行为红线）：
- **I1 入口唯一**：公网流量只进 LAN 网关端口，绝不直连 DSH 主 webServer 端口（主端口隧道 = 完全裸奔，§5.2）。
- **I2 钥匙唯一**：`effectiveToken()` 是唯一鉴权凭证；`publicMode` 下任何来源（含 loopback 形态的隧道包）都必须通过 token 校验。
- **I3 管理面闭环**：`/gateway/config`、`/gateway/token/reset`（及 `/balance/report`、`/client-beacon`）在 `publicMode` 下不得因 remoteAddress 是回环就被远程触发。
- **I4 LAN 不变**：`publicMode=false` 时行为逐字与 v1.4.0 一致（回归基线）。
- **I5 断线自愈**：隧道重启/域名变化、网关重挂、插件热重载后 QR 与 URL 状态都必须收敛到当前真实值。

---

## 4. 隧道方案选型（用户无 VPS、免费优先）

| 方案 | 公网可见 | TLS | 账号/成本 | 域名稳定性 | 适用 |
| --- | --- | --- | --- | --- | --- |
| **cloudflared Quick Tunnel（推荐）** | `https://<随机>.trycloudflare.com` | 自动 | 无需账号 | 每次重启换随机域名 | 个人/轻量；免费、零配置 |
| cloudflared Named Tunnel | 自有域名 | 自动 | 需域名托管到 CF | 稳定 | 有域名的进阶（免费功能） |
| ngrok Free | `https://<随机>.ngrok-free.app` | 自动 | 需注册 authtoken | 会话级随机，有速率闸 | 同样免费；体验略差 |
| frp（frps+frpc） | 自定 | 需自配 | 需公网 VPS（用户无） | 稳定 | 不满足用户约束，仅附录记录 |
| Tailscale/ZeroTier | 私有组网非公网 | 自动 | 免费个人版 | 稳定 | 是「组网」不是「公网暴露」，且两机都要装客户端；不满足「外网任意设备」，仅备选 |

**决策**：主方案 **cloudflared Quick Tunnel** 指向 `http://127.0.0.1:<gatewayPort>`。理由：免费、无账号、自动 HTTPS、单条命令、支持 WS（GUI 双流必需）。

落地形态（README 记录即可，不进插件代码）：
```pwsh
# 某终端后台常驻
cloudflared tunnel --url http://127.0.0.1:46322
# 首行日志给出 https://xxx-xxx.trycloudflare.com → 发给任意外网设备
```

> 注意：Quick Tunnel 公网域名被全网共享、偶有中间页/限速；个人自用足够。要稳定域名再上 Named Tunnel（需把域名 NS 交给 Cloudflare，免费）。

---

## 5. 安全分析（本规格的“心脏”）

### 5.1 致命问题 A：同机隧道击穿 loopback 免鉴权
cloudflared/ngrok/frpc 都跑在 DSH 同一台机器上，外部请求被本地转成对 `127.0.0.1:<gatewayPort>` 的 TCP 连接 ⇒ 网关收到的 `req.socket.remoteAddress === "127.0.0.1"`，且请求头里**没有** `x-dsh-mini-gateway: 1`（该头只有 dsh-mini 自己的 `proxyToUpstream` 会盖）。

后果链：
1. `authGuiRequest()`（`lib/index.js:147`）→ `isLoopback && !x-dsh-mini-gateway` = true ⇒ **任何外网匿名请求直接进 v3 GUI + 全部 RPC**；
2. `authGuiWs()`（167）同 ⇒ WS 也免鉴权；
3. `assertAuth()`（273）同 ⇒ 旧 `/dsh-mini/api/*` 免 token；
4. `isLocalDirect()`（209）同 ⇒ **loopback-only 管理端点被远程可调**：远程可 `POST /gateway/config` 关网关/改端口/改上传上限、`POST /gateway/token/reset` 重置 token（把钥匙锁死）、读 `balance`、写 `client-beacon`。

即：**不做任何改造直接把云雀隧道指到网关端口 = 匿名任意读写本机 DSH**。

### 5.2 致命问题 B：把隧道指到主 webServer 端口 ≈ 完全裸奔
主端口同样用 `isLoopback` 豁免。且主端口不服务 v3 GUI 根路径（只有 `/dsh-mini/*` 旧协议 + 管理 API）。**严禁** `cloudflared tunnel --url http://127.0.0.1:<DSH主端口>`。规格红线 I1。

### 5.3 问题 C：token 随 URL 泄漏
QR/连接 URL 形如 `https://<host>/ ?token=<token>`（`lib/index.js:815-819` 拼法）。泄漏面：
- 隧道端点访问日志（cloudflared 会记 path，query 亦可能入日志）；
- 浏览器历史/地址栏、中转代理；
- 截图/别人看到二维码（纸质/屏幕拍照）。

缓解：cloudflared 端点日志在各自进程内（本地可控）；GUI 拿到 token 后 `issueGuiSession()` 会 302 剥离 `?token=`（`lib/index.js:123-133`）并用 30 天 HttpOnly 签名 cookie（`dsh_mini_sid`）续会话——**这条链路已相当干净**，但首跳 query 仍短暂出现在云端端点。明文 HTTP（非云雀方案）下全程裸传，正文 §8 要求公网默认 HTTPS；并保留 token 轮换入口。

### 5.4 问题 D：RPC 面过宽 × 读写 × 单一 token
`gui-api.js` 除 stub 外真实可达的写面（全部只受 gateway token 把关）：
- 会话写：`session.create/rename/fork/selectModel/prompt/attachment/updateQueue/cancel`
- **`commands/execute`**（`gui-api.js:1407`）：对指定 agent 执行命令服务，`c.execute(agent, line, signal)` —— 外部持 token 即可驱动本机 agent 执行自定义命令；
- **`credentials.set/unset`**（1129/1137）：可写任意凭据 ref（含 API Key）；
- `settings.update/replace/mutate`（1058/1072/1084）：有 `webSettingsAllow(ctx, ns)` 白名单收敛（只暴露 `WEB_SETTINGS_NS`），但仍可改模型/推理等；
- `host.listDirectory/createDirectory/openPath/pickDirectory`（1501-1513）：目录列举/打开（不读文件内容，但可枚举路径）；
- `subagent.list/history/prompt/interrupt`、`goal.*`、`workspace.*`（含 delete/archive）。

风险评级：token 泄露/被暴力爆破（token 是 32 hex 随机，`randomUUID().replace(/-/g,"")`，熵足够；泄露风险主要是 §5.3 与社工）即等于**接管整台 DSH**。LAN 私有网络内可接受；公网暴露后至少要做到：强制 HTTPS（§5.3/§8）、token 不出 URL 于日志外（§6.3）、提供 `publicRpcAllow` 可选收窄（§7.5）与「外网只读模式」预留。

### 5.5 问题 E：`SameSite=Lax` 与 cookie 环境
GUI 会话 cookie 未设 `Secure`，`SameSite=Lax`，HttpOnly。（a）云雀 HTTPS + 稳定同域名 → 正常；（b）明文 HTTP 时部分浏览器策略对 cookie 更保守；（c）Quick Tunnel 每次重启域名变 → 旧 cookie 对旧域名失效属正常。无需改代码，文档说明即可（§8）。

### 5.6 问题 F：云雀免费档上传体量
Cloudflare Tunnel 免费档单请求 body 上限 **100 MB**，dsh-mini 的 `MAX_UPLOAD_MB_CAP = 100`（`lib/index.js:182`）、默认 `20`。穿透后建议把 `maxUploadMb` 收敛到 ≤50（§7.4 默认 50），避免顶到隧道上限语义模糊；文档写明超限表现。

---

## 6. 设计：插件最小增量改造（开发主体）

改动目标：满足 I2/I3/I5，G3；对 `publicMode=false` 零行为差异。风格对齐现有代码（`ctx.effect` 注册、config.json 持久化、注入器热重载兼容）。

### 6.1 配置扩展（`~/.dsh/dsh-mini/config.json`）
`loadConfig()`（`lib/index.js:295-315`）/`saveConfig()`（317-332）新增字段：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `publicMode` | boolean | `false` | 外网穿透模式总开关。`true` ⇒ 网关对**一切**请求强制 token（含 loopback 形态），并套用 §7 加固 |
| `publicUrl` | string | `""` | 公网入口 base，如 `https://xxx-xxx.trycloudflare.com`（**不带**斜杠与 query）。为空 ⇒ QR 回退 LAN URL/回环 URL |
| `publicUpstreamPort` | number | `-1` | （可选）显式指定隧道指向的本地端口；默认 = `gatewayPort` |

- `saveConfig` 增量写入（不覆盖未知字段）；白名单校验 `publicMode: boolean`、`publicUrl: string（≤2048，以 http(s):// 开头，去尾部 / 与 ?#）`。
- 配置变更即 `startGateway(ctx)` 重启网关（沿用 `/gateway/config` 现有路径，见 6.3）。

### 6.2 鉴权改造（核心，满足 I2/I3）
在 `lib/index.js` 定义 `isPublicMode(ctx)`（读 `loadConfig().publicMode`，可加 5s 缓存，与 `configCache` 同桶）。

- **`authGuiRequest` / `authGuiWs` / `assertAuth`**：把“loopback 免鉴权”分支改为
  `if (isLoopback(req) && !isPublicMode() && req.headers["x-dsh-mini-gateway"] !== "1") return true;`
  —— `publicMode=true` 时不再有任何豁免，统一走 token（GUI 走“会话 cookie 或 `?token=` 换 cookie”，WS 走“cookie 或 `?token=`”，API 走 “Bearer / x-dsh-mini-token / ?token=”）。
- **`isLocalDirect()`**：同样加入 `&& !isPublicMode()`：
  ```js
  return !isPublicMode() && req.headers["x-dsh-mini-gateway"] !== "1" && isLoopback(req);
  ```
  于是 4 个管理端点（`/gateway/config`、`/gateway/token/reset`、`/balance/report`、`/client-beacon`，即 876/910/923/937/942 的 `isLocalDirect` 检查）在 `publicMode` 下变成「非本机直连」⇒ 403，**彻底封死远程改配置/重置 token 的路径**。桌面 client 半边（`lib/client.js`）调这些端点走 DSH 主端口回环且不带 `x-dsh-mini-gateway`：`publicMode=true` 时回环请求也会 403!——**需要配套**：桌面 client 的本地管理调用必须带一个本地凭证。见 §6.4 关键决策 D-1。

- **`gatewayStatus()`**（806-842）：`publicMode && publicUrl` 时
  `url = publicUrl + "/?token=" + encodeURIComponent(token)`（不加尾巴重复斜杠）；否则维持现有 LAN/回环逻辑。新增返回字段 `publicMode`、`publicUrl`、`external: { enabled, url, up }`（`up` 可经「本机探测 publicUrl 可达」自检，见 §6.5）。

### 6.3 管理 API 扩展（`/gateway/config`）
沿用现有 `POST /gateway/config` 位置参数语义，新增可写：
- `publicMode`（boolean）
- `publicUrl`（string，校验见 6.1）

客户端（桌面设置 UI）保存后调用 `startGateway(ctx)` 重启并回 `gatewayStatus()`。LAN 网关端点本身的 loopback-only 限制不变（publicMode 下因 6.2 的 `isLocalDirect` 收紧而自动变「需本地凭证」，见 D-1）。

### 6.4 关键决策 D-1：publicMode 下的“本机管理凭证”
矛盾：publicMode 要求 loopback 免鉴权失效，但桌面端 client.js 通过主端口回环调管理端点。
方案（选一）：

- **D-1a（推荐）**：`isLocalDirect()` 放行条件从「回环」改为「回环 **且** 携带 `x-dsh-mini-local: <localsecret>`」。`localsecret` = `HMAC-SHA256(effectiveToken(), "dsh-mini-local-aug")` 的前 16 hex，由插件在 client 注入时填入（主端口侧渲染），client 侧管理请求自动带该头。异地隧道包无法伪造（拿不到 token 算不出 secret）。插件主端口侧不受 publicMode 影响，本地 GUI 桌面逻辑零改动侵入。
- **D-1b（简单，含降级）**：publicMode 下 4 个管理端点直接要求 `Authorization: Bearer <token>`（复用 `assertAuth`），即把「loopback-only」升级为「loopback-only 或带有效 token」。桌面 client 在 publicMode 激活时给管理请求附加 Bearer（client 端配置里已有 token）。改动最小，但 token 在本地 client 里多一份存储。
- 决策建议：**D-1a**（本地环签名头，桌面无感；token 不落本地多份）。实现量约 20 行。

### 6.5 外网自检（可选，G3 增强）
在 `gatewayStatus()` 加 `external.up`：`publicUrl` 存在时，网关发起 `fetch(publicUrl + "/api/health-notoken" ?)`——**注意**：公网端点可能未就绪/被中间页拦截，且不应把 token 发到外部自检。改为**纯本地判定**：`external.up = publicMode && publicUrl !== "" && gatewayListening`（隧道是否在线由 `publicUrl` 可访问性决定，桌面提示文案“穿透可达性请在外网设备实测”，不引入外部出站请求——本规格不主张插件主动外联，符合最小权限）。若将来需要主动探测，走系统 `fetch` 且超时 3s、失败仅置 false 不报错。

### 6.6 代码改动清单（文件级）
| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `lib/index.js` | 295-332 | `loadConfig/saveConfig` 增 `publicMode`/`publicUrl` |
| `lib/index.js` | 201-210, 145-172, 271-287 | `isLocalDirect`/`authGuiRequest`/`authGuiWs`/`assertAuth` 增加 `!isPublicMode()` 硬分支 |
| `lib/index.js` | 806-842 | `gatewayStatus()` 输出 `publicMode/publicUrl/external` 及公网 `url` |
| `lib/index.js` | 874-913, 922-945 | 管理端点在 D-1a/D-1b 下的凭证逻辑 |
| `lib/gui-ws.js` | 11-16 | **删除** `WS_DEBUG_LOG` 与 `dbg()` 残留（含 129/133/137/141/147 的 dbg 调用） |
| `lib/client.js` | gateway 设置区 + `gw.url` 渲染（2527/2540/2579-2591） | 新增「外网穿透」开关/URL 输入 → `postConfig`；QR 用 `external.url`（公网优先） |
| 文档 | README / 本文 | 部署与验证章节 |

---

## 7. 加固项（随 publicMode 生效，默认全开）

1. **强制 token**：实现自 §6.2，publicMode=true 即生效（I2）。
2. **管理面封锁**：实现自 D-1（I3）。
3. **HTTPS 默认**：cloudflared 天然 https；README 明确“公网入口必须 HTTPS”。若用户坚持明文（自己 frp/裸 IP），README 给红字警告（token 明文传输 + 直连主端口风险），插件不拦（尊重 N4）。
4. **上传上限收敛**：publicMode=true 时 `loadConfig()` 把 `maxUploadMb` 上界临时钳到 50（不写盘，仅生效层），对齐云雀免费 100MB 并留余量；README 写明超限表现（413 / 隧道中断）。
5. **`publicRpcAllow`（可选收窄，默认全开）**：config 增加 `publicRpcAllow: string[] | null`；非空时 `handleGuiPost`（`lib/index.js:718-750`）在 publicMode 下按 method 白名单过滤 `handleGuiApi(ctx, method, payload)` 之前拦截（401/403 `rpc-not-allowed`）。内置示例：拒绝 `commands/*`、`credentials.*`、`host.*`、`settings.*` 写侧、`workspace.delete*`、`session.cancel` 等高风险面。**默认 `null` = 全开**（保持与 LAN 行为一致），用户按需在设置里收窄。GUI 前端若收到 rpc-not-allowed 需有降级文案。
6. **清理遗留**：`ws-debug.log` 及其写入调用删除（§6.6）；顺带检视是否有其它绝对路径调试残留。

---

## 8. 部署手册（cloudflared 主方案）

```pwsh
# 1) 确保插件 v4 已注入/安装，DSH 设置里开启「局域网网关」（或 code: publicMode+publicUrl 已配置）
# 2) 验证本机网关可达（回环，带 token 也应 403 于管理端点 = publicMode 生效）
curl.exe -s "http://127.0.0.1:46322/?token=<token>"            # 应 200 HTML（GUI）
curl.exe -s -X POST "http://127.0.0.1:46322/api/gateway/config" -H "Authorization: Bearer <token>" # publicMode 下应 403 或需本地凭证
# 3) 起隧道（后台常驻，记下公网 URL）
cloudflared tunnel --url http://127.0.0.1:46322
# 4) 把公网 URL 填入 DSH 设置 → DSH Mini 手机桥 → 外网穿透（publicUrl），QR 立即切换为公网地址
# 5) 外网验证（§11）
```
> 升级 Named Tunnel（稳定域名）仅需换启动方式与 `publicUrl`，插件无感知。

---

## 9. 里程碑与验收

| M | 内容 | 验收 |
| --- | --- | --- |
| **M1** | 基线可穿透（只读验证，0 代码）：cloudflared 指网关端口，手机浏览器开公网 URL 并带 `?token=` | 外网能开 GUI、会话列表能看；**复现并确认 §5.1 风险存在**（无 token 也通 → 证明必须到 M2） |
| **M2** | `publicMode` 最小闭合：6.2/6.3/6.6 + D-1a；QR 显示公网 URL | publicMode=false 全绿回归（§10 回归清单）；publicMode=true 无 token 全路径 401/403；管理端点远程不可调；QR 为公网地址且可扫通 |
| **M3** | 加固项落地：上传钳制、`publicRpcAllow`、ws-debug 清理、README | §7/§12 负面测试全过 |
| **M4** | 真机外网全链路 + 文档定稿 | §11 清单全过；SPEC/README 更新 |

> **实现状态（2026-08-18 开发轮）**
> - ✅ **M2 / M3 已实现并本地验证**（本机注入器热重载 + HTTP 断言）：
>   - 配置新增 `publicMode` / `publicUrl` / `publicRpcAllow`（`lib/index.js` `loadConfig`/`saveConfig`/`isPublicMode`/`normalizePublicUrl`/`publicRpcAllow` 过滤，`handleGuiPost` 白名单 rpc-not-allowed）。
>   - 鉴权闭合：`authGuiRequest`/`authGuiWs` 回环豁免改为 `isLoopback && !isPublicMode() && x-dsh-mini-gateway !== "1"`；主端口 `assertAuth` 原本已对 `x-dsh-mini-gateway:1` 强制 token ⇒ 隧道经网关的旧 `/dsh-mini/*` 代理在 publicMode 下同样被拒（复用既有防护，未额外改动）。
>   - `gatewayStatus` 新增 `publicMode/publicUrl/publicRpcAllow/external{enabled,url,up}`；publicMode+publicUrl 时 `url` 切公网（QR/URL 自动）。
>   - 上传钳制：`PUBLIC_MAX_UPLOAD_MB=50` 生效层钳制（**磁盘保留原始值**，关 publicMode 自动恢复；修复了 saveConfig 直写缓存绕过钳制的 bug）。
>   - client.js 设置分节新增「外网穿透」开关 + 公网地址输入；QR 弹窗与 URL 行兼容公网模式；QrOverlay 显示条件 `gw.reachable || (gw.publicMode && gw.publicUrl)`。
>   - 清理 `lib/gui-ws.js` 的 `WS_DEBUG_LOG`/`dbg()` 调试残留及仓库根 `ws-debug.log`。
>   - **本地验证结果**：publicMode=false 下回环免 token（root 200）、RPC（host.describe/session.list）全通、`/gateway/config`/`token/reset` 仅本机；publicMode=true 下无 token 打网关 403 / 错 token 403 / 带 token 200、旧代理无 token 403、管理端点经网关 403、`maxUploadMb` 钳到 50、白名单外 RPC 返回 `rpc-not-allowed`、白名单内正常。
> - ✅ **M1 真网复现 + M2 真网验证（2026-08-18）**：出网打通后从 GitHub 拉取 cloudflared 2026.8.2（`E:\DSH Zone\.tools\cloudflared.exe`）起 Quick Tunnel 指 `http://127.0.0.1:46322`，得公网 `https://handbook-roles-postage-kidney.trycloudflare.com`。**LAN 态（publicMode=false）下外网匿名访问：GET `/`=200 GUI、匿名 POST `/api/host.describe`=200 返回真实 host 数据（cwd/provider/attachedSessions）⇒ §5.1 洞真网复现**；开启 publicMode 后同公网路径：无 token=403、错 token=403、带 `?token=`=200 且签发 `dsh_mini_sid`、RPC 带 cookie=200 `ok:true`、legacy `/dsh-mini/api/health` 带 token=200 / 无 token=403 ⇒ 修复真网坐实（顺带确认 `/dsh-mini/*` 旧代理路因 `proxyToUpstream` 盖 `x-dsh-mini-gateway` 头本就对隧道强制 token，即便 LAN 态也不裸奔）。**验证后已恢复原状**：config.json 删除、隧道终止（job killed）、网关回 LAN 态 200。cloudflared.exe 保留在 `.tools\` 供 M4 复用。
> - ✅ **回归脚本重建 + 真网 WS 验证（2026-08-18 收尾）**：重写 `scripts/smoke.ps1` 到 v1.4.0 网关 RPC 面（health/gateway/gw-root + `host.describe`/`session.list`/`llm.*`/`workspace.list`/`agentPreset.list`/`skill.list`/`settings.describe`/`goals/list` + balance，共 14 项 **PASS**）；新增 `scripts/pubmode.ps1`（publicMode 正/负矩阵：基线关态 → 开 publicMode+publicUrl+publicRpcAllow → 无/错 token 403、`/gateway/config`/`token/reset` 经网关代理 403、上传钳 50/关后恢复 100、白名单外 RPC `rpc-not-allowed`、WS `/api/events.mux`+`/api/events.host` 无 cookie 403/有 cookie 101，并自动还原 config，共 24 项 **PASS**）。测试发现并修复 `/gateway/config` `publicRpcAllow` 校验器拒绝 `null`、与 saveConfig「null/[] 全开」契约不一致的问题（现 `null | [] | array` 均可）。**真网 WS 端到端**：新隧道 `https://twenty-everyday-supporters-determined.trycloudflare.com` 下 TLS 直连 `:443` 发 RFC6455 upgrade —— `events.mux`/`events.host` 无 cookie 全 403、带 `dsh_mini_sid` cookie 全 101。验证后环境已还原（config.json 删除、隧道终止、cloudflared 无残留进程）。
> - ⏳ **M4 真机**：真网隧道链路已验（GUI/RPC/legacy 的 403/200 矩阵全过）；仍需 4G 真机按 §11 清单过一遍 UI 玻璃样式/WS 双向/附件上传/断线重连。
> - ✅ **smoke.ps1 已重写**：原 v1.2.0 版目标 `models`/`threads/*`/`upload` 路由在 v1.4.0 已并入 v3 GUI RPC，现重写为网关 RPC 断言（14 项 PASS）；publicMode 专项在 `scripts/pubmode.ps1`（24 项 PASS，自动还原环境）。均 2026-08-18 本地实测通过。
> - ✅ **常驻隧道 + 国内备用通道（2026-08-18 部署）**：用户实测手机 4G 可达 trycloudflare（问题「手机外网连不上」根因=隧道被清、地址已失效，非鉴权）。已部署脱离开发会话的常驻 watchdog（`E:\DSH Zone\.tools\tunnel-watchdog.ps1`，Task Scheduler `DSH Mini Tunnel Watchdog`(ONLOGON) + `Every5`(每5分钟) + 启动文件夹，全局 mutex 幂等）：自起/自愈 cloudflared、假死重启；**自动同步 publicUrl**（部分 patch 契约验证：`/gateway/config` 各字段独立，只 POST `{publicUrl}` 不动 publicMode）；写 `tunnel-url.txt`。**双模式**：`manual-url.txt` 存在→停止管理 cloudflared，改为同步用户自跑国内隧道（樱花frp/cpolar）地址，清空自动回切——切换双向实测通过。交付 `docs/外网穿透-备用隧道.md` + `manual-url.txt.example`。当前 live：`https://graphical-conducting-capital-thesis.trycloudflare.com/?token=4adf8a741e6945e2b298e8759fd63622`（端到端 403/200 复测通过）。

---

## 10. 回归清单（publicMode=false 必须逐字等价 v1.4.0）

- [ ] 桌面设置→手机桥：网关卡/端口/QR/LAN IP 显示、保存、token 重置 与改造前一致
- [ ] 回环：`?token=` 换 cookie → GUI；管理端点回环可调、无 token 不可调
- [ ] 局域网手机：扫 LAN QR，发消息/附件/切模型/停/接管 全通（SSE+WS 双流）
- [ ] 注入器热重载（dev_reload_package dsh-mini）后路由/网关自愈、无 ws-debug.log 新写入
- [ ] `smoke.ps1`（`scripts/smoke.ps1`，v1.4.0 网关 RPC 面）末尾 `RESULT: PASS`（2026-08-18 实测 14 项全过）
- [ ] `pubmode.ps1`（`scripts/pubmode.ps1`）末尾 `RESULT: PASS` 且环境自动还原（2026-08-18 实测 24 项全过）

## 11. 验收清单（M4 外网真机）

- [ ] 外网设备（4G 断 WiFi）开公网 URL+token：GUI 加载（`__DSH_BOOT__` 正常注入、移动端玻璃样式生效）
- [ ] 无 token / 错 token：GUI 401/403 文案、API 403、WS upgrade 403；`/gateway/config`、`/token/reset` 403
- [ ] 会话列表 / 新建 / 接管 / 发文字 / 发图片（agent 收到 `view_image` 提示）双向实时（WS `session/event`）
- [ ] 切模型 + 推理档生效；停止生成；余额徽章（桌面打开一次余额页后）
- [ ] 上传：10MB 通过；50MB+ 走 cloudflared 的正确失败语义（文档预期）
- [ ] 断线重连：杀 cloudflared → 外网连接应失败或超时；重启 cloudflared + 更新 publicUrl → QR 收敛
- [ ] `commands/execute` 与 `credentials.set` 在默认全开时与 LAN 行为一致；开启 `publicRpcAllow` 收窄后返回 `rpc-not-allowed`

## 12. 负面/安全测试

- [ ] 无 `Authorization`/无 cookie/无 token 直打公网 GUI、`/api/session.list`、WS `/api/events.mux` → 全部拒绝
- [ ] 伪造 `x-dsh-mini-gateway: 1` 头的外网请求 → 不被误判为 LAN（publicMode 下本就全 401/403）
- [ ] 公网请求 `POST /api/gateway/token/reset` → 403（I3）
- [ ] 公网请求篡改 `publicMode/publicUrl`（`/api/gateway/config`）→ 403
- [ ] 旧 token cookie 在 `token/reset` 后失效（签名密钥=token，天然不可用）——验证
- [ ] 上传 413 行为；超隧道上限 100MB 场景的文档一致性
- [ ] GUI RPC 信封缺 method / rpcId 异常 → `internal` 兜底（不崩溃、不漏 token）

## 13. 风险与依赖

- **cloudflared 免费档**：随机域名需每次更新 `publicUrl`；公网端点偶发限速/中间页；不保证 SLA。
- **匿名裸奔窗口**：M1 阶段（0 代码）就暴露 §5.1 —— 必须在 README/设置里红字注明「未启用 publicMode 前不要对外引流量」。
- **外网写路径 = 整机风险**：若想更保守，后续发布可用 `publicRpcAllow` 默认收窄为「只读 + 会话消息」（F-未来项）。
- **本开发环境无外网**：§11 真机验证必须由用户在有网真机执行；本机仅能回归 §10。
- **Cookie/域名漂移**：Quick Tunnel 换域名后旧 cookie 失效属预期，扫码/`?token=` 重连即可。

## 14. 未来项（本规格范围外，仅记录）

- F-1：可选「内置隧道」模式（插件内 `spawn` cloudflared 并管理生命周期 + 自动把公网 URL 写回 config），用户选了独立隧道，故不做主交付。
- F-2：`publicRpcAllow` 预设档（readonly / chat / full）一键切换。
- F-3：外网侧按 IP 限速、失败熔断、连接数上限（网关层简单计数器即可）。
- F-4：为 QR 生成一次性 short-lived token（扫码后 60s 换正式 cookie，减小 URL 泄漏面）。

---

## 附录 A：命令速查

```pwsh
# 起穿透（M1 起即可用；publicMode 未开=裸奔，先行 M2）
cloudflared tunnel --url http://127.0.0.1:46322

# 本机自检
curl.exe -s "http://127.0.0.1:46322/api/health"
curl.exe -s "http://127.0.0.1:46322/api/gateway" -H "Authorization: Bearer <token>"

# 回到局域网
# DSH 设置→手机桥：关闭「外网穿透」(publicMode=false) 即完全回到 v1.4.0 行为
```

## 附录 B：本文引用的关键代码锚点

- `lib/index.js:145-172` authGuiRequest/authGuiWs（loopback 豁免）
- `lib/index.js:201-210` isLoopback/isLocalDirect
- `lib/index.js:271-287` assertAuth
- `lib/index.js:295-332` loadConfig/saveConfig
- `lib/index.js:703-804` startGateway（含 proxyToUpstream 盖 `x-dsh-mini-gateway: 1` @655）
- `lib/index.js:806-842` gatewayStatus（url 拼装 @815-819）
- `lib/index.js:874-913/922-945` loopback-only 管理端点
- `lib/gui-ws.js:11-16` 遗留 WS_DEBUG_LOG（改造必删）
- `lib/gui-api.js:1407` commands/execute；`:1129/1137` credentials.set/unset；`:1058/1072/1084` settings.update/replace/mutate（webSettingsAllow 白名单）；`:1501-1513` host.* 文件面
- `lib/client.js:2527/2540/2579-2591` 桌面 QR 渲染/URL 行（`gw.url`）
