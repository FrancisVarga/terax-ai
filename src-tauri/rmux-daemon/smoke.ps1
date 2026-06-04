$ErrorActionPreference = "Stop"
Get-Process rmux-daemon -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$exe = "E:/workspace/terax-rmux-phase0/src-tauri/rmux-daemon/target/debug/rmux-daemon.exe"
$out = New-TemporaryFile
$err = New-TemporaryFile
$proc = Start-Process -FilePath $exe -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden

$port = $null
for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 100
    $line = Get-Content $out -ErrorAction SilentlyContinue | Where-Object { $_ -match 'listening port=(\d+)' }
    if ($line) { $port = [int]$Matches[1]; break }
}
$base = "http://127.0.0.1:$port"
Write-Host "PORT=$port"

$h = Invoke-RestMethod -Uri "$base/health" -Method Get
Write-Host "HEALTH: pid=$($h.daemon_pid) panes=$($h.panes)"

$open = Invoke-RestMethod -Uri "$base/pane/open" -Method Post -ContentType "application/json" -Body '{"cols":80,"rows":24}'
$pane = $open.pane_id
Write-Host "OPENED pane_id=$pane"

function Write-Pane([string]$data) {
    $body = @{ data = $data } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$base/pane/$pane/write" -Method Post -ContentType "application/json" -Body $body | Out-Null
}

# Subscribe to the SSE stream over a raw socket so we can act as the terminal:
# reply to the cursor-position report (ESC[6n) pwsh emits at startup, otherwise
# PSReadLine blocks forever waiting for the reply and never runs our command.
$client = New-Object System.Net.Sockets.TcpClient
$client.Connect("127.0.0.1", $port)
$ns = $client.GetStream()
$req = "GET /pane/$pane/events HTTP/1.1`r`nHost: 127.0.0.1`r`nConnection: keep-alive`r`n`r`n"
$reqBytes = [System.Text.Encoding]::ASCII.GetBytes($req)
$ns.Write($reqBytes, 0, $reqBytes.Length); $ns.Flush()

$decoded = New-Object System.Text.StringBuilder
$sseText = New-Object System.Text.StringBuilder
$buf = New-Object byte[] 16384
$ns.ReadTimeout = 400
$cprSent = $false
$wroteCmd = $false
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 12) {
    $n = 0
    try { $n = $ns.Read($buf, 0, $buf.Length) } catch { $n = 0 }
    if ($n -gt 0) {
        [void]$sseText.Append([System.Text.Encoding]::ASCII.GetString($buf, 0, $n))
        # Parse complete SSE lines collected so far.
        $all = $sseText.ToString()
        $lines = $all -split "`n"
        $sseText.Clear() | Out-Null
        [void]$sseText.Append($lines[-1])   # keep the partial tail
        foreach ($l in $lines[0..($lines.Count - 2)]) {
            $l = $l.TrimEnd("`r")
            if ($l -match '^data: ([A-Za-z0-9+/=]+)$') {
                try {
                    $chunk = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Matches[1]))
                    [void]$decoded.Append($chunk)
                    # Respond to a cursor-position request like a real terminal.
                    if (-not $cprSent -and $chunk.Contains([char]0x1b + "[6n")) {
                        Write-Pane ([char]0x1b + "[1;1R")
                        $cprSent = $true
                        Write-Host "REPLIED to CPR (ESC[6n -> ESC[1;1R)"
                    }
                }
                catch {}
            }
        }
    }
    # The ESC[6n is emitted at spawn, before this subscriber connects, so the
    # broadcast may already have dropped it. If we have not observed it within a
    # short grace window, answer the CPR proactively to unblock PSReadLine. A
    # real terminal frontend subscribes synchronously with open and would see it;
    # this proactive reply only makes the headless smoke test deterministic.
    if (-not $cprSent -and $sw.Elapsed.TotalSeconds -gt 1.5) {
        Write-Pane ([char]0x1b + "[1;1R")
        $cprSent = $true
        Write-Host "REPLIED to CPR proactively (ESC[1;1R)"
    }
    # Once CPR is answered the shell reaches its prompt; type the command.
    if ($cprSent -and -not $wroteCmd -and $sw.Elapsed.TotalSeconds -gt 2.0) {
        Write-Pane "echo hello`r"
        $wroteCmd = $true
        Write-Host "WROTE: echo hello<CR>"
    }
}
$client.Close()

$d = $decoded.ToString()
Write-Host "----- DECODED SSE OUTPUT (control chars shown) -----"
Write-Host ($d -replace "`e", "<ESC>")
if ($d -match "hello") { Write-Host "SMOKE: PASS (saw 'hello' echoed back over SSE)" }
else { Write-Host "SMOKE: FAIL (no 'hello' in decoded output)" }

Invoke-RestMethod -Uri "$base/pane/$pane/resize" -Method Post -ContentType "application/json" -Body '{"cols":100,"rows":30}' | Out-Null
Write-Host "RESIZED ok"
Invoke-RestMethod -Uri "$base/pane/$pane/close" -Method Post | Out-Null
Write-Host "CLOSED ok"
$h2 = Invoke-RestMethod -Uri "$base/health" -Method Get
Write-Host "HEALTH after close: panes=$($h2.panes)"

Stop-Process -Id $proc.Id -Force
Remove-Item $out, $err -ErrorAction SilentlyContinue
