param(
  [int]$Port = 0,
  [string]$Text = "用一句话介绍你自己"
)
# DSH Mini loopback smoke test (v1.4.0 gateway RPC surface).
# Auto-discovers the webServer port if -Port is 0.
# Covers: main-port health / gateway status / balance, and LAN gateway
#   root (v3 GUI) + GUI RPC methods (host.describe, session.list, llm.*,
#   workspace.*, agentPreset.*, skill.*, settings.describe, goals/*).
# Requirement: publicMode must be OFF (LAN baseline). The publicMode positive/
#   negative matrix lives in pubmode.ps1.
# Compatible with Windows PowerShell 5.1 (pwsh / powershell.exe).
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root "smoke.txt"
"" | Set-Content $log
function Log($m) { $m | Tee-Object -FilePath $log -Append }

$script:fail = 0
function Assert($name, $cond, $detail) {
  if ($cond) { Log "PASS  $name : $detail" }
  else { Log "FAIL  $name : $detail"; $script:fail++ }
}

function Find-Port {
  $ports = @()
  try {
    $ports = (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::1','::') } |
      Select-Object -ExpandProperty LocalPort -Unique | Sort-Object)
  } catch { Log "NETTCP_ERR: $_" }
  foreach ($p in $ports) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/dsh-mini/api/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
      if ($r.Content -match '"ok"') { return $p }
    } catch { }
  }
  return 0
}

# GET helper: returns @{ status; raw } — non-2xx captured via exception Response
function Invoke-Get($uri) {
  try {
    $r = Invoke-WebRequest -Uri $uri -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
    return [pscustomobject]@{ status = [int]$r.StatusCode; raw = $r.Content }
  }
  catch {
    $st = $null
    if ($_.Exception.Response) { $st = [int]$_.Exception.Response.StatusCode }
    return [pscustomobject]@{ status = $st; raw = "" }
  }
}

# POST official GUI RPC envelope to the gateway; returns @{ status; json }
function Post-Rpc($base, $method, $payload) {
  $body = @{ type = "client-request"; rpcId = "smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 8); method = $method; payload = $payload } |
    ConvertTo-Json -Depth 8 -Compress
  try {
    $r = Invoke-WebRequest -Uri "$base/api/$method" -Method Post -ContentType "application/json" -Body $body `
      -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
    $j = try { $r.Content | ConvertFrom-Json } catch { $null }
    return [pscustomobject]@{ status = [int]$r.StatusCode; json = $j }
  }
  catch {
    $st = $null
    if ($_.Exception.Response) { $st = [int]$_.Exception.Response.StatusCode }
    return [pscustomobject]@{ status = $st; json = $null }
  }
}

if ($Port -eq 0) {
  Log "scanning loopback ports for /dsh-mini/api/health ..."
  $Port = Find-Port
}
if ($Port -eq 0) { Log "FAIL: could not locate a listening DSH Mini webServer (is DSH Desktop running with the plugin loaded?)"; exit 1 }
Log "PORT: $Port"
$B = "http://127.0.0.1:$Port/dsh-mini/api"

# 1) health
try {
  $h = Invoke-WebRequest -Uri "$B/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
  $hj = $h.Content | ConvertFrom-Json
  Assert "health" ($hj.ok -eq $true) "ok=$($hj.ok) servicesReady=$($hj.servicesReady) v=$($hj.version)"
} catch { Log "FAIL health: $_"; exit 1 }

# 2) gateway status (loopback is token-free when publicMode is OFF)
$gwPort = 0
try {
  $g = Invoke-Get "$B/gateway"
  if ($g.status -eq 200) {
    $gw = ($g.raw | ConvertFrom-Json).gateway
    $gwPort = [int]$gw.gatewayPort
    Assert "gateway.publicMode-off" ($gw.publicMode -eq $false) "publicMode=$($gw.publicMode)"
    Assert "gateway.upload-cap" ([int]$gw.maxUploadMb -ge 1 -and [int]$gw.maxUploadMb -le 100) "maxUploadMb=$($gw.maxUploadMb)"
    Log "GATEWAY: lanEnabled=$($gw.lanEnabled) port=$($gw.gatewayPort) ips=$($gw.lanIps -join ',') reachable=$($gw.reachable)"
  } else {
    Log "WARN gateway: status=$($g.status)"
  }
} catch { Log "WARN gateway: $_" }
if ($gwPort -eq 0) { Log "FAIL: no gateway port in status"; exit 1 }
$GW = "http://127.0.0.1:$gwPort"

# 3) LAN gateway root — serves the v3 GUI (token-free on LAN / loopback)
$r = Invoke-Get "$GW/"
if ($r.status -eq 200) {
  $hasBoot = $r.raw -match "__DSH_BOOT__"
  Assert "gw-root" $hasBoot "status=200 hasBoot=$hasBoot len=$($r.raw.Length)"
} else {
  Assert "gw-root" $false "status=$($r.status) (expected 200)"
}

# 4+) GUI RPC (read-only surface)
$methods = @("host.describe", "session.list", "llm.providers", "llm.models", "workspace.list", "agentPreset.list", "skill.list", "settings.describe", "goals/list")
foreach ($m in $methods) {
  $res = Post-Rpc $GW $m @{}
  $ok = $res.status -eq 200 -and $res.json -and $res.json.type -eq "server-response" -and $res.json.result.ok -eq $true
  $detail = if ($ok) { "status=200 ok=true" } else { "status=$($res.status) code=$($res.json.result.error.code)" }
  Assert "rpc.$m" $ok $detail
}

# 5) main-port balance (loopback)
$bl = Invoke-Get "$B/balance"
Assert "balance" ($bl.status -eq 200) "status=$($bl.status) body=$($bl.raw)"

$res = if ($script:fail -eq 0) { "RESULT: PASS" } else { "RESULT: FAIL ($script:fail)" }
Log $res
Log "Done. Full log -> smoke.txt"
exit $(if ($script:fail -eq 0) { 0 } else { 1 })
