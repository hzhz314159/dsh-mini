param(
  [int]$Port = 0,
  [string]$PublicUrl = "https://smoke-tunnel.trycloudflare.com",
  [switch]$KeepOn
)
# DSH Mini publicMode matrix (SPEC-v4 M2/M3 regression).
# Enables publicMode + publicUrl + a publicRpcAllow whitelist through the
# loopback admin channel, then asserts, on the GATEWAY port (loopback here
# simulates a same-machine tunnel: remoteAddress=127.0.0.1, no
# x-dsh-mini-gateway header):
#   negative : root / RPC without (or with wrong) token -> 403
#              loopback-only admin endpoints via the legacy proxy -> 403
#   positive : ?token= redirect -> dsh_mini_sid cookie -> RPC ok,
#              whitelisted RPC ok, non-whitelisted -> rpc-not-allowed,
#              upload cap clamped to 50 while publicMode is on
#   ws       : /api/events.mux + /api/events.host without auth -> 403,
#              with cookie -> 101
# Restores the original config (and removes config.json if it did not exist)
# unless -KeepOn is given (leaves publicMode on for real tunneling).
# Compatible with Windows PowerShell 5.1.
# Run with: powershell -ExecutionPolicy Bypass -File scripts\pubmode.ps1
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$miniHome = if ($env:DSH_HOME) { Join-Path $env:DSH_HOME "dsh-mini" } else { Join-Path $env:USERPROFILE ".dsh\dsh-mini" }
$cfgPath = Join-Path $miniHome "config.json"
$tokFile = Join-Path $miniHome "token.txt"
$log = Join-Path $root "pubmode.txt"
"" | Set-Content $log
function Log($m) { $m | Tee-Object -FilePath $log -Append }

$script:fail = 0
function Assert($name, $cond, $detail) {
  if ($cond) { Log "PASS  $name : $detail" }
  else { Log "FAIL  $name : $detail"; $script:fail++ }
}

# ---- helpers ---------------------------------------------------------------
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

# HTTP helpers: non-2xx captured via exception Response; returns @{status; raw}
function Get-Json($uri, $session) {
  try {
    $p = @{ Uri = $uri; TimeoutSec = 10; UseBasicParsing = $true; ErrorAction = "Stop" }
    if ($session) { $p.WebSession = $session }
    $r = Invoke-WebRequest @p
    return [pscustomobject]@{ status = [int]$r.StatusCode; raw = $r.Content }
  }
  catch {
    $st = $null
    if ($_.Exception.Response) { $st = [int]$_.Exception.Response.StatusCode }
    return [pscustomobject]@{ status = $st; raw = "" }
  }
}
function Post-Json($uri, $body, $session) {
  try {
    $p = @{ Uri = $uri; Method = "Post"; ContentType = "application/json"; Body = ($body | ConvertTo-Json -Depth 8 -Compress); TimeoutSec = 15; UseBasicParsing = $true; ErrorAction = "Stop" }
    if ($session) { $p.WebSession = $session }
    $r = Invoke-WebRequest @p
    return [pscustomobject]@{ status = [int]$r.StatusCode; raw = $r.Content }
  }
  catch {
    $st = $null
    if ($_.Exception.Response) { $st = [int]$_.Exception.Response.StatusCode }
    return [pscustomobject]@{ status = $st; raw = "" }
  }
}
function Post-Rpc($base, $method, $payload, $session) {
  $body = @{ type = "client-request"; rpcId = "pub-" + [guid]::NewGuid().ToString("N").Substring(0, 8); method = $method; payload = $payload } |
    ConvertTo-Json -Depth 8 -Compress
  $r = Post-Json "$base/api/$method" $body $session
  $j = try { $r.raw | ConvertFrom-Json } catch { $null }
  return [pscustomobject]@{ status = $r.status; json = $j; raw = $r.raw }
}
function Test-WsUpgrade($gwPort, $path, $cookie) {
  # raw RFC6455 upgrade over the gateway; returns the HTTP status line only
  try {
    $sock = New-Object System.Net.Sockets.TcpClient("127.0.0.1", $gwPort)
    $sock.ReceiveTimeout = 3000
    $ns = $sock.GetStream()
    $key = [Convert]::ToBase64String([byte[]](1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16))
    $cookieHdr = if ($cookie) { "Cookie: $cookie`r`n" } else { "" }
    $hb = "GET $path HTTP/1.1`r`nHost: 127.0.0.1:$gwPort`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Key: $key`r`nSec-WebSocket-Version: 13`r`n$cookieHdr`r`n"
    $enc = [System.Text.Encoding]::ASCII
    $ns.Write($enc.GetBytes($hb), 0, $hb.Length)
    $sr = New-Object System.IO.StreamReader($ns, [System.Text.Encoding]::ASCII)
    $line = $sr.ReadLine()
    $sock.Close()
    return $line
  }
  catch {
    return ("EXC " + ($_ | Out-String).Trim())
  }
}

# ---- setup ------------------------------------------------------------------
if ($Port -eq 0) {
  Log "scanning loopback ports for /dsh-mini/api/health ..."
  $Port = Find-Port
}
if ($Port -eq 0) { Log "FAIL: could not locate a listening DSH Mini webServer"; exit 1 }
Log "PORT: $Port"
$B = "http://127.0.0.1:$Port/dsh-mini/api"

$token = ""
try { $token = (Get-Content $tokFile -Raw -ErrorAction Stop).Trim() } catch { }
if (-not $token) { $token = $env:DSH_MINI_TOKEN }
if (-not $token) { Log "FAIL: no bridge token at $tokFile and DSH_MINI_TOKEN unset"; exit 1 }
Log "TOKEN: present ($($token.Length) chars)"

$origBytes = $null
try { $origBytes = [System.IO.File]::ReadAllBytes($cfgPath) } catch { }
$cfgExisted = $null -ne $origBytes

$found = Get-Json "$B/gateway" $null
$gw0 = $null
if ($found.status -eq 200) { $gw0 = ($found.raw | ConvertFrom-Json).gateway }
if (-not $gw0) { Log "FAIL: cannot read gateway status (status=$($found.status))"; exit 1 }
$gwPort = [int]$gw0.gatewayPort
Log "GATEWAY PORT: $gwPort (lanEnabled=$($gw0.lanEnabled) publicMode=$($gw0.publicMode))"
if ($gwPort -le 0) { Log "FAIL: no gateway port"; exit 1 }
$GW = "http://127.0.0.1:$gwPort"

try {
  # ---- A. LAN baseline ------------------------------------------------------
  Assert "A1.baseline-publicMode-off" ($gw0.publicMode -eq $false) "publicMode=$($gw0.publicMode)"

  # ---- B. enable raw cap 100 (LAN), then publicMode --------------------------
  $r = Post-Json "$B/gateway/config" @{ maxUploadMb = 100 } $null
  $g = if ($r.status -eq 200) { ($r.raw | ConvertFrom-Json).gateway } else { $null }
  Assert "B1.raw-cap-set" ($r.status -eq 200 -and $g -and [int]$g.maxUploadMb -eq 100) "status=$($r.status) maxUploadMb=$($g.maxUploadMb)"

  $r = Post-Json "$B/gateway/config" @{ publicMode = $true; publicUrl = $PublicUrl; publicRpcAllow = @("session.list") } $null
  $cfg = if ($r.status -eq 200) { ($r.raw | ConvertFrom-Json) } else { $null }
  $g = if ($cfg) { $cfg.gateway } else { $null }
  Assert "B2.enable" ($r.status -eq 200 -and $g -and $g.publicMode -eq $true) "status=$($r.status) publicMode=$($g.publicMode)"
  Assert "B3.publicUrl" ($g -and $g.publicUrl -eq $PublicUrl) "publicUrl=$($g.publicUrl)"
  Assert "B4.allowlist" ($g -and $g.publicRpcAllow -and @($g.publicRpcAllow).Count -eq 1 -and @($g.publicRpcAllow)[0] -eq "session.list") "allow=$(if ($g.publicRpcAllow) { @($g.publicRpcAllow) -join ',' } else { 'null' })"
  Assert "B5.upload-clamp50" ($g -and [int]$g.maxUploadMb -eq 50) "maxUploadMb=$($g.maxUploadMb) (expect 50 while publicMode on; disk keeps 100)"
  # 网关在 startGateway 里异步重启，POST 响应瞬间 gwListening 可能仍为旧值；
  # 轮询 up 至多 ~3s，确保观察到稳定公网就绪态
  $upOk = $false
  for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Milliseconds 400
    try {
      $vv = Get-Json "$B/gateway" $null
      if ($vv.status -eq 200) {
        $gx = ($vv.raw | ConvertFrom-Json).gateway
        if ($gx.external.up -eq $true) { $upOk = $true; break }
      }
    } catch { }
  }
  Assert "B6.external-up" ($upOk) "external.up=$upOk (publicUrl + gwListening)"

  # ---- C. negative (gateway loopback = tunnel-shaped) --------------------------
  $r = Get-Json "$GW/" $null
  Assert "C1.root-no-token" ($r.status -eq 403) "status=$($r.status)"
  $r = Get-Json "$GW/?token=WRONG-TOKEN" $null
  Assert "C2.root-wrong-token" ($r.status -eq 403) "status=$($r.status)"
  $r = Post-Rpc $GW "host.describe" @{} $null
  Assert "C3.rpc-no-token" ($r.status -eq 403) "status=$($r.status)"

  # admin endpoints via the legacy proxy = tunnel path (must stay loopback-only)
  $r = Post-Json "$GW/dsh-mini/api/gateway/config" @{ publicMode = $false } $null
  Assert "C5.proxy-config-no-token" ($r.status -eq 403) "status=$($r.status)"
  $r = Post-Json "$GW/dsh-mini/api/gateway/config?token=$token" @{ publicMode = $false } $null
  Assert "C6.proxy-config-with-token" ($r.status -eq 403) "status=$($r.status) (loopback-only guard)"
  $r = Post-Json "$GW/dsh-mini/api/gateway/token/reset?token=$token" @{} $null
  Assert "C7.proxy-token-reset" ($r.status -eq 403) "status=$($r.status)"

  # WS over the gateway (tunnel path) without auth
  $L = Test-WsUpgrade $gwPort "/api/events.mux" ""
  Assert "C8.ws-mux-no-auth" ($L -like "HTTP/1.1 403*") $L
  $L = Test-WsUpgrade $gwPort "/api/events.host" ""
  Assert "C9.ws-host-no-auth" ($L -like "HTTP/1.1 403*") $L

  # ---- D. positive (token flow + allowlist) -----------------------------------
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $r = Get-Json "$GW/?token=$token" $session
  Assert "D1.root-token-redirect" ($r.status -eq 200) "status=$($r.status) (302 -> 200 with cookie)"
  $cookie = ""
  try {
    $cook = $session.Cookies.GetCookies([uri]"$GW/")
    $cookie = $cook | Where-Object { $_.Name -eq "dsh_mini_sid" } | Select-Object -First 1 -ExpandProperty Value
  } catch { }
  Assert "D2.session-cookie" ([bool]$cookie) "dsh_mini_sid issued ($($cookie.Length) chars)"
  $cookieHdr = "dsh_mini_sid=$cookie"

  $r = Post-Rpc $GW "session.list" @{} $session
  Assert "D3.rpc-allowlisted" ($r.status -eq 200 -and $r.json -and $r.json.result.ok -eq $true) "status=$($r.status) ok=$($r.json.result.ok)"
  $r = Post-Rpc $GW "host.describe" @{} $session
  Assert "D4.rpc-denied" ($r.status -eq 200 -and $r.json -and $r.json.result.ok -eq $false -and $r.json.result.error.code -eq "rpc-not-allowed") "code=$($r.json.result.error.code)"
  $r = Post-Rpc $GW "settings.update" @{} $session
  Assert "D5.rpc-settings-denied" ($r.status -eq 200 -and $r.json -and $r.json.result.ok -eq $false -and $r.json.result.error.code -eq "rpc-not-allowed") "code=$($r.json.result.error.code)"

  $L = Test-WsUpgrade $gwPort "/api/events.mux" $cookieHdr
  Assert "D6.ws-mux-with-cookie" ($L -like "HTTP/1.1 101*") $L
  $L = Test-WsUpgrade $gwPort "/api/events.host" $cookieHdr
  Assert "D7.ws-host-with-cookie" ($L -like "HTTP/1.1 101*") $L
}
finally {
  # ---- restore --------------------------------------------------------------
  # -KeepOn: leave publicMode + config file as-is (for live tunneling).
  # Without -KeepOn: disable publicMode AND put the original config file back
  #   (removing it if it did not exist), so the environment is pristine.
  if (-not $KeepOn) {
    try {
      $r = Post-Json "$B/gateway/config" @{ publicMode = $false; publicUrl = ""; publicRpcAllow = $null } $null
      Log ("RESTORE-OFF: status=" + $r.status)
    } catch { Log "RESTORE-OFF-ERR: $_" }
  }
  if (-not $KeepOn) {
    try {
      if ($cfgExisted) { [System.IO.File]::WriteAllBytes($cfgPath, $origBytes) }
      else { if (Test-Path $cfgPath) { Remove-Item $cfgPath -Force } }
      Log "RESTORE-CFG: restoredBytes=$cfgExisted removed=$( -not $cfgExisted )"
    } catch { Log "RESTORE-CFG-ERR: $_" }
  }
  # let the 5s config cache TTL expire so the next process sees the restored disk state
  Start-Sleep -Seconds 5
  try {
    $v = Get-Json "$B/gateway" $null
    if ($v.status -eq 200) {
      $g = ($v.raw | ConvertFrom-Json).gateway
      Log "RESTORE-VERIFY: publicMode=$($g.publicMode) maxUploadMb=$($g.maxUploadMb) url=$($g.url)"
    } else { Log "RESTORE-VERIFY: status=$($v.status)" }
  } catch { Log "RESTORE-VERIFY-ERR: $_" }
}

$res = if ($script:fail -eq 0) { "RESULT: PASS" } else { "RESULT: FAIL ($script:fail)" }
Log $res
Log "Done. Full log -> pubmode.txt"
exit $(if ($script:fail -eq 0) { 0 } else { 1 })
