param(
  [string]$OutDir = ""
)
# 组装发行包 DSH-Mobile-v<version>.zip（v3 官方 GUI 移植版）：
#   source/  完整源码（含 apk/ 工程、vendor/、.github/、gui/ 静态资产）
#   release/ 可安装插件包（package.json + lib/ + public/ + cordis.patch.yml + gui/）
#   README.txt  安装说明（发行通道）
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
$version = $pkg.version
if (-not $OutDir) { $OutDir = $repo }

# 0) 找 node（PATH 没有时用 DSH Desktop 自带 node）
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $cand = "C:\Program Files\DSH Desktop\resources\node\node.exe"
  if (Test-Path $cand) { $node = $cand }
}
if (-not $node) { throw "找不到 node（PATH 或 DSH Desktop 自带 node）" }

# 1) 组装 client（vendor/qrcode.js 内联）+ 语法校验（零构建管线）
& $node (Join-Path $repo "scripts\assemble-client.cjs")
if ($LASTEXITCODE -ne 0) { throw "client 组装失败" }
foreach ($f in @("lib\index.js", "lib\client.js")) {
  & $node --check (Join-Path $repo $f)
  if ($LASTEXITCODE -ne 0) { throw "语法校验失败: $f" }
}
Write-Host "[1/4] client 组装 + 语法校验 OK"

# 2) 清理临时文件
foreach ($f in @("smoke.txt", "smoke_stream.txt", "screenshot.png")) {
  $p = Join-Path $repo $f
  if (Test-Path $p) { Remove-Item $p -Force }
}

$zip = Join-Path $OutDir "DSH-Mobile-v$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }

$stage = Join-Path $env:TEMP ("dsh-mini-release-" + [guid]::NewGuid().ToString("N"))
$srcDir = Join-Path $stage "source"
$relDir = Join-Path $stage "release"
New-Item -ItemType Directory -Force -Path $srcDir, $relDir | Out-Null

# 3) source/：源码（排除 node_modules、smoke 产物）
Copy-Item (Join-Path $repo "lib") $srcDir -Recurse -Force
Copy-Item (Join-Path $repo "src") $srcDir -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $repo "public") $srcDir -Recurse -Force
Copy-Item (Join-Path $repo "scripts") $srcDir -Recurse -Force
Copy-Item (Join-Path $repo "apk") $srcDir -Recurse -Force
Copy-Item (Join-Path $repo "gui") $srcDir -Recurse -Force
# apk/ 工程只分发源码：剔除本地构建产物与本机路径
foreach ($junk in @("app\build", ".gradle", "build", "local.properties", "app\build\outputs")) {
  $jp = Join-Path (Join-Path $srcDir "apk") $junk
  if (Test-Path $jp) { Remove-Item $jp -Recurse -Force }
}
Copy-Item (Join-Path $repo "vendor") $srcDir -Recurse -Force
Copy-Item (Join-Path $repo ".github") $srcDir -Recurse -Force
foreach ($f in @("package.json", "cordis.patch.yml", "README.md", "SPEC.md")) {
  Copy-Item (Join-Path $repo $f) $srcDir -Force
}

# 4) release/：可安装插件包（含 v3 官方 GUI 静态资产）
Copy-Item (Join-Path $repo "package.json") $relDir -Force
Copy-Item (Join-Path $repo "lib") $relDir -Recurse -Force
Copy-Item (Join-Path $repo "public") $relDir -Recurse -Force
Copy-Item (Join-Path $repo "gui") $relDir -Recurse -Force
Copy-Item (Join-Path $repo "cordis.patch.yml") $relDir -Force
Copy-Item (Join-Path $repo "README.md") $relDir -Force

# 5) README.txt（发行通道说明）
$readmeTxt = @"
DSH Mobile v$version — 官方 GUI 手机桥发行包（v3 移植版）
====================================================

手机端：手机 WebView/浏览器打开 http://<电脑IP>:46322/?token=... 直接进入官方 DSH GUI
（走 dsh-mini 网关：RPC + 双 WS 事件流 + 静态 bundle 全由 dsh-mini 自建）

安装（PowerShell，仓库根目录执行）：
  pwsh scripts/install.ps1
  或指定安装目录：
  pwsh scripts/install.ps1 -Target "C:\Program Files\DSH Desktop\resources\app"

装完重启 DSH Desktop。之后：
  1. DSH 设置 → 「DSH Mobile 手机桥」→ 开启「局域网网关」（DSH web 需 --host 0.0.0.0 才能被手机访问）
  2. 桌面侧栏点「手机连接」图标 → 弹二维码（内容为 http://<电脑IP>:<网关端口>/?token=...）
  3. 手机装 APK（source/apk/ 工程，构建见 apk/README-APK.md）内扫码，或手机浏览器直接打开该地址

详细文档：README.md / SPEC.md / SPEC-v3-GUI-移植.md
"@
[System.IO.File]::WriteAllText((Join-Path $stage "README.txt"), $readmeTxt, (New-Object System.Text.UTF8Encoding $false))

# 6) 打包
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force
Write-Host "OK: $zip"
