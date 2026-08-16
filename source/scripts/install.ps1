param(
  [string]$Target = "",
  [string]$DshHome = "",
  [switch]$SkipDesktop
)
# Install the DSH Mini plugin into DSH Desktop (assets/plugins) and sync it to the web profile.
# -Target: DSH Desktop resources\app directory (auto-detected when empty)
# -DshHome: DSH home override (defaults to ~/.dsh); useful for tests/custom homes
$ErrorActionPreference = "Stop"

# Helper: recursively copy the public folder (defined before use to avoid
# any function-resolution ordering issues across PowerShell editions).
function Copy-Public($from, $to) {
  if (-not (Test-Path $from)) { return }
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  foreach ($item in Get-ChildItem $from) {
    $dst = Join-Path $to $item.Name
    if ($item.PSIsContainer) { Copy-Public $item.FullName $dst }
    else { Copy-Item $item.FullName $dst -Force }
  }
}

$repo = Split-Path -Parent $PSScriptRoot

# 1) Copy into DSH Desktop assets/plugins (survives future DSH Desktop updates via its own sync)
if (-not $SkipDesktop) {
  if (-not $Target) {
    $candidates = @(
      "D:\app\dsh\DSH Desktop\resources\app",
      (Join-Path $env:LOCALAPPDATA "Programs\dsh-desktop\resources\app"),
      (Join-Path $env:ProgramFiles "dsh-desktop\resources\app"),
      (Join-Path ${env:ProgramFiles(x86)} "dsh-desktop\resources\app")
    )
    $Target = $candidates | Where-Object { Test-Path (Join-Path $_ "main.js") } | Select-Object -First 1
  }
  if (-not $Target -or -not (Test-Path (Join-Path $Target "main.js"))) {
    throw "DSH Desktop install not found. Pass -Target pointing at its resources\app directory (or -SkipDesktop for profile-only install)."
  }
  $pluginDir = Join-Path $Target "assets\plugins\dsh-mini"
  New-Item -ItemType Directory -Force -Path (Join-Path $pluginDir "lib") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $pluginDir "public") | Out-Null
  Copy-Item (Join-Path $repo "package.json") (Join-Path $pluginDir "package.json") -Force
  Copy-Item (Join-Path $repo "lib\*.js") (Join-Path $pluginDir "lib") -Force
  Copy-Public (Join-Path $repo "public") (Join-Path $pluginDir "public")
  Write-Host "[1/3] plugin copied to $pluginDir"
}

# 2) Sync into the web profile (same approach as DSH Desktop's syncCompanionPlugins)
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $DshHome "profiles\web"
$dest = Join-Path $profileDir "node_modules\@deepseek-ai\dsh-mini"
New-Item -ItemType Directory -Force -Path (Join-Path $dest "lib") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dest "public") | Out-Null
Copy-Item (Join-Path $repo "package.json") (Join-Path $dest "package.json") -Force
Copy-Item (Join-Path $repo "lib\*.js") (Join-Path $dest "lib") -Force
Copy-Public (Join-Path $repo "public") (Join-Path $dest "public")
Write-Host "[2/3] plugin synced to $dest"

# 3) Patch the profile composition to load the plugin
$patchFile = Join-Path $profileDir "cordis.patch.yml"
$patch = if (Test-Path $patchFile) { Get-Content -LiteralPath $patchFile -Raw } else { "" }
if ($patch -notmatch "id:\s*dsh-mini\b") {
  $blockLines = @(
    "- insert:",
    "    - id: dsh-mini",
    "      name: '@deepseek-ai/dsh-mini'"
  )
  $block = ($blockLines -join [Environment]::NewLine) + [Environment]::NewLine
  if ($patch.Trim() -eq "" -or $patch -match '^\s*\[\]\s*$') {
    $patch = "# dsh web profile patch (maintained by dsh-mini)" + [Environment]::NewLine + $block
  } else {
    $patch = $patch.TrimEnd() + [Environment]::NewLine + $block
  }
  # Write WITHOUT a BOM. DSH's YAML parser rejects a BOM-prefixed file and
  # would "recover" the patch (silently dropping our entry). UTF8Encoding($false)
  # is the no-BOM encoder.
  [System.IO.File]::WriteAllText($patchFile, $patch, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "[3/3] appended dsh-mini entry to cordis.patch.yml"
} else {
  Write-Host "[3/3] cordis.patch.yml already contains dsh-mini (skipped)"
}

Write-Host ""
Write-Host "Done. Restart DSH Desktop (or 'dsh web'), then look for this line in the startup log:"
Write-Host "  [dsh-mini] vX.Y.Z mounted at /dsh-mini/ (api: /dsh-mini/api/)"
Write-Host "  [dsh-mini] bridge token (share with the phone app): <token>"
Write-Host "Phone: open http://<电脑IP>:<端口>/dsh-mini/  (same Wi-Fi). Loopback is token-free; LAN needs the token."
