# DSH-Mobile（手机桥）

把 Codex-Mini 的「手机 ↔ 电脑端 AI 会话」桥接体验复刻到 **DeepSeek Harness Desktop（DSH）**：手机发文字 / 图片 / 文件，实时看到 DSH agent 的思考、工具调用与回复，并能管理会话、切换模型、停止生成。

所有会话都是**电脑端 DSH 里的真实 agent 会话**——手机只是其中一个远程参与方，电脑桌面与手机双向可见、双向可控。

> 技术文档与决策记录见 [`SPEC.md`](./SPEC.md)（第 14 节为 1.2.0 实现记录、第 15 节为 1.3.0 实现记录）。本文件只讲用法。

## 一、开发机热装配（注入器工作流，改代码即时生效）

```powershell
# 依赖：工作区 node_modules 里建了官方包 junction（见 scripts/link-deps.ps1）
pwsh scripts/link-deps.ps1      # 首次/换机时建 @deepseek-ai/dsh-{llm,session,agent} junction
# 之后在 DSH 里直接调用注入器工具：
#   dev_build_plugin {dir: "E:\DSH Zone\dsh-mini"}   → bash scripts/build.sh（零构建：client 组装 + 语法校验）
#   dev_inject_plugin {dir: "E:\DSH Zone\dsh-mini"}  → 注入（host + client UI 一并生效）
#   dev_reload_package {packageName: "dsh-mini"}     → 热重载（lib 指纹自动 watch，编辑即生效）
#   dev_uninject_plugin {match: "dsh-mini"}          → 卸载
```

## 二、正式安装（install.ps1 双通道，随 DSH 更新可重跑）

```powershell
# 在仓库根目录 dsh-mini/ 执行（自动探测 DSH Desktop 安装位置）
pwsh scripts/install.ps1

# 或指定 DSH Desktop 的 resources\app 目录
pwsh scripts/install.ps1 -Target "C:\Program Files\DSH Desktop\resources\app"
```

脚本会：① 复制插件到 `assets/plugins/dsh-mini`；② 同步到 `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-mini`；③ 向 `cordis.patch.yml` 追加 `insert` 块。装完重启 DSH Desktop。启动日志：

```
[dsh-mini] v1.3.0 mounted at /dsh-mini/ (api: /dsh-mini/api/)
[dsh-mini] webServer bind: 127.0.0.1:46321; LAN gateway disabled; ...
[dsh-mini] bridge token (share with the phone app): <token>
```

## 三、开启局域网网关 + 手机连接（1.3.0 流程）

1. **打开网关**：DSH 桌面 → 设置 → 「DSH Mini 手机桥」→ 开启「局域网网关」（可改网关端口 1024–65535）。
2. **确认绑定**：设置卡里实时显示绑定地址与端口。手机可达要求 DSH web 以 `--host 0.0.0.0` 启动（绑 `127.0.0.1` 时会显示黄色告警与指引）。
3. **弹二维码**：点左侧栏左下角「手机连接」图标（在「临时会话」上方）→ 弹出二维码。**网关未开启时点击会自动跳转设置页**。
4. **手机扫码**：
   - 装 **DSH Mini APK**（`apk/` 工程，见 `apk/README-APK.md`）→ 应用内「📷 扫码连接」；
   - 或手机浏览器直接开 `http://<电脑IP>:<端口>/dsh-mini/`，在「连接设置 → 📷 扫码连接」里扫；
   - 或直接让**手机系统相机**扫桌面二维码 → 浏览器/应用自动打开。
5. 手机浏览器/APK 里还能：发文字与附件（图片会提示 agent 用 `view_image` 查看）、切换模型与推理档、看余额徽章、停止生成、接管电脑上任意 DSH 会话（双向同步）。

> 说明：余额徽章数据来自 Desktop 壳（`dsh-balance` 无 host API）——桌面端开着 DSH 即会经 client 半边推送；未推送时显示「余额待同步」。

## 四、API 速览（1.3.0）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-mini/api/health` | 健康检查 |
| GET | `/dsh-mini/api/gateway` | 网关状态（token/lanEnabled/host/port/lanIps/reachable/url） |
| POST | `/dsh-mini/api/gateway/config` | `{lanEnabled?, maxUploadMb?}`（仅回环） |
| POST | `/dsh-mini/api/gateway/token/reset` | 重置 token（仅回环） |
| GET | `/dsh-mini/api/models` | 模型目录（含推理档） |
| POST | `/dsh-mini/api/upload?session=&name=` | 附件上传（原始 body） |
| GET | `/dsh-mini/api/threads` | 会话列表（zstd 日志折叠标题/模型/时间） |
| POST | `/dsh-mini/api/threads/new` | 新建电脑端真实会话 |
| POST | `/dsh-mini/api/threads/:id/attach` | 接管已有会话 |
| GET | `/dsh-mini/api/threads/:id/history` | 历史（live 双源去重 / 存储会话读日志） |
| GET | `/dsh-mini/api/threads/:id/stream` | SSE：`meta` + `step`（thinking/tool/assistant/user/title/model/status） |
| POST | `/dsh-mini/api/threads/:id/send` | `{text, attachments:[{name,path}]}` → 202 |
| POST | `/dsh-mini/api/threads/:id/stop` | 停止本轮 |
| GET/POST | `/dsh-mini/api/threads/:id/model` | 查询 / 按会话切换模型（provider/model/reasoningEffort） |
| GET | `/dsh-mini/api/balance` | 余额缓存 |
| GET | `/dsh-mini/*` | 手机 UI 静态托管 |

鉴权：回环免 token；非回环 `Authorization: Bearer <token>` / `x-dsh-mini-token` / SSE `?token=`。

## 五、验证

### 1. 一键冒烟（本机回环，免手机免 token）

```powershell
pwsh scripts/smoke.ps1        # 自动探测端口；日志 smoke.txt / smoke_stream.txt
```

覆盖：health / gateway / models / new / upload / send(带附件) / SSE / history(zstd fold) / model get+set / attach / list / balance。期望末尾 `RESULT: PASS`。

### 2. 真机复测清单（用户）

- [ ] 桌面设置 → 「DSH Mini 手机桥」分节可见；网关开关/绑定/二维码预览正常
- [ ] 网关关闭时点侧栏手机图标 → 自动跳设置页；开启后点击 → 二维码弹窗
- [ ] 手机系统相机扫二维码 → 打开手机页面（或 APK 内扫码连接）
- [ ] 手机发文字/图片/文件 → 桌面与手机双向实时同步（思考·工具·回复）
- [ ] 手机切换模型 + 推理档 → 生效且桌面徽章同步变化
- [ ] 余额徽章显示（桌面端打开余额页后）
- [ ] APK 构建安装（`apk/README-APK.md`）

### 已知风险 / 排查

- `503 no model configured`：DSH 没设默认模型。
- 手机连不上：几乎都是绑定回环；改 `--host 0.0.0.0`（设置卡有提示）。
- 插件没挂载：查 `cordis.patch.yml` 是否含 `id: dsh-mini`。
- 余额一直「待同步」：桌面壳只在余额数据变化时推事件，打开一次桌面余额页即可触发。

## 变更记录

- **1.3.0**（2026-08-16）：第三阶段 UI 打磨。手机端 UI 全面液态玻璃化（深色渐变 + 光斑层 + 半透明毛玻璃 topbar/菜单/composer/用户气泡/代码块/表格 + 高光描边）；沉浸式安全区（APK `getSafeTop()` 桥 → 页面 `--dsh-safe-top`，避开刘海/状态栏/导航栏，connect.html 同步）；字体与中文渲染优化（antialiased / text-size-adjust / Noto Sans SC）。APK 重封装：**Native 实时扫码**（CameraX 后置预览 + ZXing 解码，`ScanActivity`，免 GMS 华为机可用）、透明系统栏主题、connect.html 玻璃门面（「📷 扫码连接」→ 原生相机 / 无相机模拟器走地址输入 + lastUrl 回填 + 原生连通自检）；本机 Android 构建工具链落地（JDK 21 + Gradle 8.9 + SDK）；真机（华为 nova7se）CDP 实测玻璃样式与沉浸式全绿；SPEC 第 15 节记录。第四阶段（功能扩展）见 SPEC。
- **1.2.0**（2026-08-16）：M2 + M3。运行时兼容修复（标题/模型改 zstd 日志折叠、live 历史双源去重、turn/end reason 全集、路由热重载自愈）；附件上传+路径引用（图片提示 `view_image`）；模型目录 + 按会话切换（installModelSelection 可变 selection + sessions.json 持久化）；`/attach` 接管；桌面 client 半边（侧栏手机图标→二维码/未配置跳设置页 + 设置分节网关卡 + 余额转发）；手机 UI（附件胶囊/模型菜单/推理档/余额徽章/扫码连接）；网关 API（config.json + token 重置）；APK 壳工程（含应用内扫码，源码 + CI 交付）。
- **1.1.0**（2026-08-16）：手机端 UI 全面重制为 GPT Mini（Codex-Mini v5.5.4）同款液态玻璃风格——顶栏状态呼吸点 + 状态圆环 + 线程下拉菜单（live spinner/模型徽章）+ 保持亮屏（Wake Lock）+ 线路徽章（本地/远程）+ markdown 渲染 + 工具胶囊 + 键盘适配 + iPad 双栏布局 + PWA（manifest/图标）；修复 `/threads/new` 的 `commit is not a function`（setup 回调返回清理函数与 agent-loop `.commit()` 契约冲突，改为不返回值）；`GET /threads/:id/model` 返回当前模型信息；history 补充 `reasoningEffort`；扫码 URL `?token=` 自动保存。
- **1.0.0**（2026-08-16）：初版（M1 闭环：线程列表 / 新建 / 发文字 / 双向 SSE / 停止）。

## 许可

MIT。灵感来源：Codex-Mini by CoimgRain（架构思路借鉴）。内置第三方库：`qrcode-generator`（Kazuhiko Arase，MIT，`vendor/qrcode.js`）、`jsQR`（cozmo，Apache-2.0，`vendor/jsQR.js`）。
