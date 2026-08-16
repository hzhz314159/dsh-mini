# DSH Mini（手机桥）

把 Codex-Mini 的「手机 ↔ 电脑端 AI 会话」桥接体验复刻到 **DeepSeek Harness Desktop（DSH）**：手机发文字 / 图片 / 文件，实时看到 DSH agent 的思考、工具调用与回复，并能管理会话、停止生成。

所有会话都是**电脑端 DSH 里的真实 agent 会话**——手机只是其中一个远程参与方，电脑桌面与手机双向可见、双向可控。

> 适配技术文档见 [`SPEC.md`](./SPEC.md)。本文件只讲用法。

## 安装

```powershell
# 在仓库根目录 dsh-mini/ 执行（自动探测 DSH Desktop 安装位置）
pwsh scripts/install.ps1

# 或指定 DSH Desktop 的 resources\app 目录
pwsh scripts/install.ps1 -Target "D:\app\dsh\DSH Desktop\resources\app"
```

脚本会：
1. 复制插件到 `DSH Desktop/resources/app/assets/plugins/dsh-mini`（随 DSH 自带同步，更新不丢）；
2. 同步到 `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-mini`；
3. 向 `~/.dsh/profiles/web/cordis.patch.yml` 追加 `insert` 块加载插件。

安装后**重启 DSH Desktop**（或 `dsh web`）。启动日志里会出现：

```
[dsh-mini] v0.1.0 mounted at /dsh-mini/ (api: /dsh-mini/api/)
[dsh-mini] bridge token (share with the phone app): <token>
[dsh-mini] loopback connections are token-free; LAN phone needs the token above.
```

## 手机使用

- 手机与电脑连同一 Wi‑Fi，浏览器打开 `http://<电脑IP>:<端口>/dsh-mini/`。
- 端口即 DSH Web 服务端口（默认 3080，具体看启动日志）。
- 本机/回环访问免 token；手机走局域网需在 App 设置里填上面的 **bridge token**。
- 点「＋ 新建」开一个电脑端真实会话；或点列表里已有的 DSH 会话接管它。桌面端对该会话发的消息也会实时出现在手机上（双向）。

## API 速览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-mini/api/health` | 健康检查 |
| GET | `/dsh-mini/api/threads` | 会话列表 |
| GET | `/dsh-mini/api/threads/:id/history` | 某会话历史（归一化 steps） |
| GET | `/dsh-mini/api/threads/:id/stream` | SSE 实时事件流（双向） |
| POST | `/dsh-mini/api/threads/:id/send` | 注入用户消息（返回 202） |
| POST | `/dsh-mini/api/threads/:id/stop` | 停止本轮 |
| POST | `/dsh-mini/api/threads/new` | 新建会话 |
| GET | `/dsh-mini/api/threads/:id/model` | 当前模型信息（provider/model/reasoningEffort） |

鉴权：回环免 token；非回环 `Authorization: Bearer <token>` 或 SSE 用 `?token=<token>`。

## 状态

- **M1（已实现）**：线程列表 / 新建 / 发文字 / 双向 SSE 流式 / 停止。
- **M1.1（已实现）**：GPT Mini 同款液态玻璃 UI 重制——顶栏状态圆环 + 线程下拉菜单（live 点/spinner/模型徽章）、保持亮屏、线路徽章（本地/远程）、markdown 渲染、工具胶囊、键盘适配、iPad 双栏布局、PWA manifest + 图标；GET /threads/:id/model 返回当前模型信息。
- **M2（待做）**：附件、模型切换、推理档。
- **M3（待做）**：余额圆环、外网中继、APK 封装。

## 验证（Verification）

按「先本机回环、后局域网」的顺序验证，能在不动 LAN 绑定设置的情况下先跑通完整逻辑。

### 0. 前置条件
- DSH Desktop 已启动，且**设置了一个默认模型**（否则 `/threads/new` 与发消息会返回 `503 no model configured`）。
- 已安装插件（见上）并**重启 DSH Desktop**。

### 1. 找到端口与绑定地址
webServer 端口由 DSH 壳层在启动时打印（日志里的 URL 行）。也可用已装的 `dsh-file-changes` 插件探活：
```powershell
# 在电脑上执行，列出本机回环监听端口
(Invoke-WebRequest http://127.0.0.1:<端口>/api/dsh-files/ports).Content
```
> 关键：`dsh-host-webserver` 的 `host` 配置是 `'127.0.0.1' | '0.0.0.0'`，**默认多为回环**。
> 这意味着**本机回环测试一定能通**；但**手机在局域网直连，只有当 host=0.0.0.0 时才可达**。
> 若手机打不开，先确认绑定地址；必要时把 web 组合的 `host` 改成 `0.0.0.0`（或走隧道）。

### 2. 本机回环冒烟测试（无需手机、免 token）
下面的 `<端口>` 替换成第 1 步拿到的端口，用 PowerShell 跑：
```powershell
$P = "<端口>"
$B = "http://127.0.0.1:$P/dsh-mini/api"

# 2.1 健康检查
(Invoke-WebRequest "$B/health").Content
# 期望: {"ok":true,"name":"@deepseek-ai/dsh-mini","version":"0.1.0","servicesReady":true}

# 2.2 新建一个电脑端真实会话
$R = (Invoke-WebRequest -Method POST "$B/threads/new").Content | ConvertFrom-Json
$SID = $R.id
"新建会话: $SID"

# 2.3 拉一下历史（新建后应为空 steps）
(Invoke-WebRequest "$B/threads/$SID/history").Content

# 2.4 发一条消息（返回 202，真正的回复走 SSE）
(Invoke-WebRequest -Method POST "$B/threads/$SID/send" `
  -ContentType "application/json" -Body '{"text":"用一句话介绍你自己"}').Content

# 2.5 同时订阅 SSE，应看到 thinking/text 流式回来
# （另开一个 PowerShell 跑这句，约 20 秒内有事件）
(Invoke-WebRequest "$B/threads/$SID/stream").Content
```
浏览器直接打开 `http://127.0.0.1:<端口>/dsh-mini/` 也能看到手机 UI（回环免 token）。

### 3. 双向可见性（核心验证点）
- 在手机 UI 里对某会话发消息 → **电脑端 DSH 桌面该会话应实时出现这条消息与回复**。
- 在电脑端 DSH 桌面给同一会话发消息 → **手机 UI 的 SSE 流应实时收到**（同源 `ctx.on('session/event')` 扇出，不分来源）。

### 4. 局域网手机测试（条件：host=0.0.0.0）
- 同 Wi‑Fi，手机浏览器开 `http://<电脑IP>:<端口>/dsh-mini/`。
- 在 App 设置里填第 1 步启动日志里的 **bridge token**（LAN 非回环必须）。
- 走通「新建 → 发消息 → 流式 → 停止」闭环。

### 5. 验收清单
- [ ] `/health` 返回 `servicesReady:true`
- [ ] `/threads/new` 返回 201 且 `id` 能在 DSH 桌面会话列表里看到（它是真实会话）
- [ ] SSE `/stream` 收到 `step` 事件（thinking/text/tool）
- [ ] `POST /send` 后桌面与手机都看到同一回复
- [ ] `POST /stop` 能中断生成中会话
- [ ] 局域网手机端可用（若 host=0.0.0.0）

### 已知风险 / 排查
- 插件没挂载：检查 `~/.dsh/profiles/web/cordis.patch.yml` 是否含 `id: dsh-mini`，且 DSH 实际使用了 web profile。
- `503 no model configured`：DSH 没设默认模型，先去 DSH 设置里选一个。
- 手机连不上：几乎都是 webServer 默认绑回环；改 `host: 0.0.0.0` 或走隧道。

## 变更记录

- **1.1.0**（2026-08-16）：手机端 UI 全面重制为 GPT Mini（Codex-Mini v5.5.4）同款液态玻璃风格——顶栏状态呼吸点 + 状态圆环 + 线程下拉菜单（live spinner/模型徽章）+ 保持亮屏（Wake Lock）+ 线路徽章（本地/远程）+ markdown 渲染 + 工具胶囊 + 键盘适配 + iPad 双栏布局 + PWA（manifest/图标）；修复 `/threads/new` 的 `commit is not a function`（setup 回调返回清理函数与 agent-loop `.commit()` 契约冲突，改为不返回值）；`GET /threads/:id/model` 返回当前模型信息；history 补充 `reasoningEffort`；扫码 URL `?token=` 自动保存。
- **1.0.0**（2026-08-16）：初版（M1 闭环：线程列表 / 新建 / 发文字 / 双向 SSE / 停止）。

## 许可

MIT。灵感来源：Codex-Mini by CoimgRain（架构思路借鉴）。
