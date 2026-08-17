param(
  [string]$OutDir = ""
)
# 组装发行包 DSH-Mini-M<version>.zip：
#   source/  完整源码（含 apk/ 工程、vendor/、.github/）
#   release/ 可安装插件包（package.json + lib/ + public/ + cordis.patch.yml）
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

$zip = Join-Path $OutDir "DSH-Mini-M$version.zip"
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

# 4) release/：可安装插件包
Copy-Item (Join-Path $repo "package.json") $relDir -Force
Copy-Item (Join-Path $repo "lib") $relDir -Recurse -Force
Copy-Item (Join-Path $repo "public") $relDir -Recurse -Force
Copy-Item (Join-Path $repo "cordis.patch.yml") $relDir -Force
Copy-Item (Join-Path $repo "README.md") $relDir -Force

# 5) README.txt（发行通道说明）
$readmeTxt = @"
DSH Mini v$version — 手机桥插件发行包
=====================================

安装（PowerShell，仓库根目录执行）：
  pwsh scripts/install.ps1
  或指定安装目录：
  pwsh scripts/install.ps1 -Target "C:\Program Files\DSH Desktop\resources\app"

装完重启 DSH Desktop。之后：
  1. DSH 设置 → 「DSH Mini 手机桥」→ 开启「局域网网关」（DSH web 需 --host 0.0.0.0 才能被手机访问）
  2. 点侧栏左下角「手机连接」图标 → 弹二维码
  3. 手机装 DSH Mini APK（source/apk/ 工程，构建见 apk/README-APK.md）内扫码，
     或手机浏览器开 http://<电脑IP>:<端口>/dsh-mini/ 设置页扫码

详细文档：README.md / SPEC.md
"@
[System.IO.File]::WriteAllText((Join-Path $stage "README.txt"), $readmeTxt, (New-Object System.Text.UTF8Encoding $false))

# 6) 打包
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force
Write-Host "OK: $zip"
