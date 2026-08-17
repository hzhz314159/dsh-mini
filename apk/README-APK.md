# DSH Mini Android 壳（应用内扫码连接）

把电脑上的 DSH 装进手机：WebView 壳 + 内置「拍照扫码连接」页（jsQR 纯 Web 解码，
Android 侧零相机代码），扫码后直接打开手机端页面（`http://电脑IP:端口/dsh-mini/`）。

## 本机构建要求

本工程零第三方业务依赖，但构建需要标准 Android 工具链：

| 组件 | 最低版本 |
|------|----------|
| JDK | 17 |
| Android SDK | compileSdk 34（Android 14） |
| Gradle | 8.9（AGP 8.5.2，wrapper 自动下载） |

> 当前开发机未安装 Java / Gradle / Android SDK，故 1.2.0 以「工程源码 + CI 构建」交付。

## 方式一：Android Studio（推荐）

1. 打开本目录（`apk/`）为工程，等待 Gradle 同步（会自动下载 AGP 8.5.2 与 wrapper）。
2. `Build → Build App Bundle(s) / APK(s) → Build APK(s)`。
3. 产物在 `app/build/outputs/apk/debug/app-debug.apk`，传到手机安装（需允许「安装未知来源应用」）。

## 方式二：命令行

```bash
# 先装 JDK 17 + Android SDK cmdline-tools，并设置：
export ANDROID_HOME=/path/to/android-sdk
sdkmanager "platforms;android-34" "build-tools;34.0.0"
# 本目录下（首次会下载 gradle 8.9）：
cd apk
gradle wrapper
./gradlew :app:assembleDebug
```

## 方式三：GitHub Actions（免本机工具链）

仓库根已含 `.github/workflows/build-apk.yml`：把本仓库推到 GitHub，Actions 自动产出
`DSH-Mini.apk` 构建产物（Artifacts 下载）。

## 虚拟机调试（无真机 / 无相机）

用 Android 模拟器调试时，宿主电脑与虚拟机的网络关系如下：

1. **宿主开网关**：电脑 DSH 设置 →「DSH Mini 手机桥」→ 开启「局域网网关」
   （绑定 `0.0.0.0`，默认端口 `46322`；DSH web 需以 `--host 0.0.0.0` 启动）。
2. **确认局域网 IP**：设置卡会显示当前局域网 IP（过滤了虚拟网卡）。
   若 IDE 自带模拟器（如 flutter/AS 的 Emulator），宿主地址用 `10.0.2.2`；
   若用独立模拟器（LDPlayer 9 / MuMu 12 等），用宿主网卡的局域网 IP。
3. **安装 APK**：把构建好的 `app-debug.apk` 拖进模拟器窗口即可安装
   （LDPlayer：拖动或 `adb install`；MuMu：侧栏安装工具）。
4. **连接**：打开 DSH Mini → 模拟器无相机，直接点连接页下方输入框，
   粘贴/输入完整链接 `http://<宿主IP>:46322/dsh-mini/?token=…`
   （token 从桌面二维码 URL 复制），点「连接」。
   应用会先**原生自检连通性**（成功显示「连通 ✓ 正在打开…」，失败给出排查提示），
   同时会自动**回填上次成功地址**，换网后无需重输。
5. **常见失败原因**：①宿主 DSH 未以 `--host 0.0.0.0` 启动（绑定 127.0.0.1 手机不可达）；
   ②防火墙未放行 46322 端口；③虚拟网卡模式下 IP 变了，用设置卡实时显示的 IP；
   ④模拟器与宿主不在同一网段（桥接/双网卡环境）。
6. 连接成功后即为手机端页面：可建会话、发消息、收 SSE 流、上传附件（原生相册/相机经
   `onShowFileChooser` 透传）。

## 使用流程

1. 电脑：DSH 设置 → 「DSH Mini 手机桥」→ 开启「局域网网关」（DSH web 需以
   `--host 0.0.0.0` 启动才能被手机访问；绑定地址与状态在设置卡中实时显示）。
2. 电脑：点侧栏左下角「手机连接」图标 → 弹出二维码。
3. 手机：打开 DSH Mini 应用 → 「📷 扫码连接」→ 对准桌面二维码 → 自动连接。
   （系统相机扫码也会弹出「用 DSH Mini 打开」的选项——本应用注册了
   `http(s)://…/dsh-mini` 路径的 VIEW intent。）
4. 断开/换机：连接页可手动清空记录（应用内「设置 → 连接设置」或重新扫码覆盖）。

## 工程结构

- `app/src/main/java/com/dshmini/app/MainActivity.java` — WebView 壳：
  - 记住上次连接地址（SharedPreferences），有则直达手机端页面；
  - `onShowFileChooser` 透传系统相机/相册（手机端页面的拍照扫码、图片附件都靠它）；
  - JS 桥 `connect(url)` / `clear()` / `getLastUrl()`（回填上次地址）/
    `testUrl(url)`（原生 HttpURLConnection 连通自检，结果回调
    `window.__dshMiniTestCb(ok, code, err)`——绕开 file:// 页面的 CORS 限制）；
  - 保持亮屏、返回键回退、沉浸黑。
- `app/src/main/assets/connect.html` + `jsQR.min.js` — 内置连接页（扫码/手动输入）。
- `AndroidManifest.xml` — `INTERNET`/`CAMERA` 权限、`usesCleartextTraffic`（局域网
  http）、`http(s)://…/dsh-mini` 的 VIEW intent-filter。

## 签名说明

release 构建默认用 debug 签名（可安装、够用）；如需上架分发，在
`app/build.gradle` 的 `release.signingConfig` 换成自己的 keystore。
