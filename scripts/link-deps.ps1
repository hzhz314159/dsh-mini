param(
  [string]$Profile = "web"
)
# 工作区依赖 junction：开发/注入器装配时，host 半边直接 import 的官方包
# 需要能从本仓库目录解析到（ESM 从真实路径向上找 node_modules）。
# 指向 profile fallback 目录（profiles\node_modules），其内部是到
# DSH Desktop resources\app\node_modules 的 junction——保证与运行时
# 同一模块实例（避免 installModelSelection/SessionId 双副本问题）。
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$ws = Join-Path $repo "node_modules"
$profileNms = Join-Path $env:USERPROFILE ".dsh\profiles\node_modules\@deepseek-ai"
if (-not (Test-Path $profileNms)) {
  throw "profile fallback 目录不存在: $profileNms（先启动一次 DSH Desktop 生成）"
}
New-Item -ItemType Directory -Force -Path (Join-Path $ws "@deepseek-ai") | Out-Null
foreach ($p in @("dsh-llm", "dsh-session", "dsh-agent")) {
  $src = Join-Path $profileNms $p
  $dst = Join-Path $ws "@deepseek-ai\$p"
  if (-not (Test-Path $src)) { Write-Warning "缺少 $src，跳过"; continue }
  if (Test-Path $dst) {
    $item = Get-Item $dst -Force -ErrorAction SilentlyContinue
    if ($item.LinkType -eq "Junction") { Write-Host "已存在: $dst"; continue }
    Remove-Item $dst -Recurse -Force
  }
  New-Item -ItemType Junction -Path $dst -Target $src | Out-Null
  Write-Host "junction: $dst -> $src"
}
Write-Host "done. 之后可用注入器 dev_inject_plugin 装配本插件。"
