param(
  [int]$Port = 0,
  [string]$Text = "用一句话介绍你自己"
)
# DSH Mini loopback smoke test (v1.2.0). Auto-discovers the webServer port if -Port is 0.
# Covers: health / gateway / models / upload / threads(new|list|send|stream|history|model|attach) / balance.
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root "smoke.txt"
"" | Set-Content $log
function Log($m) { $m | Tee-Object -FilePath $log -Append }

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
  Log "HEALTH: $($h.Content)"
} catch { Log "FAIL health: $_"; exit 1 }

# 2) gateway status (loopback is token-free)
try {
  $g = Invoke-WebRequest -Uri "$B/gateway" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
  $gw = $g.Content | ConvertFrom-Json
  Log "GATEWAY: lanEnabled=$($gw.gateway.lanEnabled) host=$($gw.gateway.host) port=$($gw.gateway.port) ips=$($gw.gateway.lanIps -join ',') reachable=$($gw.gateway.reachable)"
} catch { Log "WARN gateway: $_" }

# 3) models catalog
try {
  $m = Invoke-WebRequest -Uri "$B/models" -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
  $cat = $m.Content | ConvertFrom-Json
  Log "MODELS: $($cat.models.Count) entries; default=$($cat.default.provider)/$($cat.default.model)"
} catch { Log "WARN models: $_" }

# 4) new session
try {
  $n = Invoke-WebRequest -Uri "$B/threads/new" -Method POST -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
  $sid = (($n.Content | ConvertFrom-Json).id)
  Log "NEW_SESSION: $sid"
} catch { Log "FAIL new: $_"; exit 1 }

# 5) upload a tiny text file (raw body + name query param)
$upPath = ""
try {
  $tmpFile = Join-Path $env:TEMP ("dsh-mini-smoke-" + [guid]::NewGuid().ToString("N") + ".txt")
  "dsh-mini smoke upload" | Set-Content $tmpFile -NoNewline
  $bytes = [System.IO.File]::ReadAllBytes($tmpFile)
  $upUrl = $B + "/upload?session=" + $sid + "&name=smoke-note.txt"
  $u = Invoke-WebRequest -Uri $upUrl -Method POST -Body $bytes -ContentType "application/octet-stream" -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
  $up = $u.Content | ConvertFrom-Json
  $upPath = $up.path
  Log "UPLOAD: name=$($up.name) size=$($up.size) path=$upPath"
  Remove-Item $tmpFile -Force
} catch { Log "WARN upload: $_" }

# 6) send (with attachment reference when upload succeeded)
try {
  $body = @{ text = $Text }
  if ($upPath) { $body.attachments = @(@{ name = "smoke-note.txt"; path = $upPath }) }
  $s = Invoke-WebRequest -Uri "$B/threads/$sid/send" -Method POST -ContentType "application/json" `
    -Body ($body | ConvertTo-Json) -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
  Log "SEND: $($s.Content)"
} catch { Log "FAIL send: $_"; exit 1 }

# 7) SSE stream capture (~12s) via raw TCP
$streamLog = Join-Path $root "smoke_stream.txt"
"" | Set-Content $streamLog
try {
  $sock = New-Object System.Net.Sockets.TcpClient("127.0.0.1", $Port)
  $ns = $sock.GetStream()
  $req = "GET /dsh-mini/api/threads/$sid/stream HTTP/1.1`r`nHost: 127.0.0.1:$Port`r`nAccept: text/event-stream`r`nConnection: close`r`n`r`n"
  $enc = [System.Text.Encoding]::ASCII
  $ns.Write($enc.GetBytes($req), 0, $req.Length)
  $sr = New-Object System.IO.StreamReader($ns)
  $deadline = [datetime]::Now.AddSeconds(12)
  $events = 0
  while ([datetime]::Now -lt $deadline) {
    if ($sr.Peek() -ge 0) {
      $line = $sr.ReadLine()
      if ($line) { $line | Add-Content $streamLog; if ($line -like 'event: step') { $events++ } }
    } else { Start-Sleep -Milliseconds 200 }
  }
  $sock.Close()
  Log "SSE_STEP_EVENTS: $events"
} catch { Log "WARN sse: $_" }

# 8) poll history until assistant text appears
$got = $false
for ($i = 0; $i -lt 15; $i++) {
  try {
    $hh = Invoke-WebRequest -Uri "$B/threads/$sid/history" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    $hist = $hh.Content | ConvertFrom-Json
    $assistant = ($hist.steps | Where-Object { $_.type -eq 'assistant' -and $_.text })
    if ($assistant) {
      $got = $true
      $txt = [string]$assistant.text
      if ($txt.Length -gt 80) { $txt = $txt.Substring(0, 80) }
      Log "HISTORY_OK: title=$($hist.title) model=$($hist.model.provider)/$($hist.model.model) assistant_reply_len=$($assistant.text.Length) first_80=$txt"
      break
    }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $got) { Log "FAIL: no assistant reply observed in history within timeout" }

# 9) model read + per-session switch
try {
  $cur = (Invoke-WebRequest -Uri "$B/threads/$sid/model" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop).Content | ConvertFrom-Json
  Log "MODEL_GET: $($cur.provider)/$($cur.model) (source=$($cur.source))"
  $sw = Invoke-WebRequest -Uri "$B/threads/$sid/model" -Method POST -ContentType "application/json" `
    -Body (@{provider=$cur.provider; model=$cur.model; reasoningEffort=$cur.reasoningEffort} | ConvertTo-Json) `
    -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
  Log "MODEL_SET: $($sw.Content)"
} catch { Log "WARN model switch: $_" }

# 10) attach round-trip (already live -> should return immediately)
try {
  $a = Invoke-WebRequest -Uri "$B/threads/$sid/attach" -Method POST -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
  Log "ATTACH: $($a.Content)"
} catch { Log "WARN attach: $_" }

# 11) thread list includes the new session with folded title/model
try {
  $t = Invoke-WebRequest -Uri "$B/threads" -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
  $threads = ($t.Content | ConvertFrom-Json).threads
  $mine = $threads | Where-Object { $_.id -eq $sid }
  if ($mine) { Log "LIST_OK: found session; title=$($mine.title) live=$($mine.live)" }
  else { Log "WARN list: session not found in /threads" }
  Log "LIST_COUNT: $($threads.Count)"
} catch { Log "WARN list: $_" }

# 12) balance placeholder read
try {
  $bl = Invoke-WebRequest -Uri "$B/balance" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
  Log "BALANCE: $($bl.Content)"
} catch { Log "WARN balance: $_" }

# 13) stop (best-effort)
try {
  $st = Invoke-WebRequest -Uri "$B/threads/$sid/stop" -Method POST -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
  Log "STOP: $($st.Content)"
} catch { Log "WARN stop: $_" }

$res = if ($got) { "RESULT: PASS" } else { "RESULT: FAIL" }
Log $res
Log "Done. Stream raw lines -> smoke_stream.txt ; full log -> smoke.txt"
