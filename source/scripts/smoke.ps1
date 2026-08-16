param(
  [int]$Port = 0,
  [string]$Text = "用一句话介绍你自己"
)
# DSH Mini loopback smoke test. Auto-discovers the webServer port if -Port is 0.
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'

$log = "E:\WorkBuddy Zone\dsh_desktop\dsh-mini\smoke.txt"
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

# 2) new session
try {
  $n = Invoke-WebRequest -Uri "$B/threads/new" -Method POST -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
  $sid = (($n.Content | ConvertFrom-Json).id)
  Log "NEW_SESSION: $sid"
} catch { Log "FAIL new: $_"; exit 1 }

# 3) send
try {
  $s = Invoke-WebRequest -Uri "$B/threads/$sid/send" -Method POST -ContentType "application/json" `
    -Body (@{text=$Text} | ConvertTo-Json) -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
  Log "SEND: $($s.Content)"
} catch { Log "FAIL send: $_"; exit 1 }

# 4) SSE stream capture (~12s) via raw TCP
$streamLog = "E:\WorkBuddy Zone\dsh_desktop\dsh-mini\smoke_stream.txt"
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

# 5) poll history until assistant text appears
$got = $false
for ($i = 0; $i -lt 15; $i++) {
  try {
    $hh = Invoke-WebRequest -Uri "$B/threads/$sid/history" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    $hist = $hh.Content | ConvertFrom-Json
    $assistant = ($hist.steps | Where-Object { $_.type -eq 'assistant' -and $_.text })
    if ($assistant) {
      $got = $true
      Log "HISTORY_OK: assistant replied $(($assistant.text).Length) chars; first 80: $(($assistant.text).Substring(0,[Math]::Min(80,$assistant.text.Length)))"
      break
    }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $got) { Log "FAIL: no assistant reply observed in history within timeout" }

# 6) stop (best-effort)
try {
  $st = Invoke-WebRequest -Uri "$B/threads/$sid/stop" -Method POST -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
  Log "STOP: $($st.Content)"
} catch { Log "WARN stop: $_" }

Log (if ($got) { "RESULT: PASS" } else { "RESULT: FAIL" })
Log "Done. Stream raw lines -> smoke_stream.txt ; full log -> smoke.txt"
