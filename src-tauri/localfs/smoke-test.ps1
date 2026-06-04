# Smoke test for the localfs S3 sidecar: exercises bucket + object + multipart +
# auth against the built release binary using the real AWS CLI (SigV4 SDK).
# Run from anywhere; paths are absolute. Exits non-zero on first failure.
$ErrorActionPreference = "Stop"

$bin  = "E:\workspace\terax-ai-localfs\src-tauri\target\release\localfs.exe"
$root = Join-Path $env:TEMP "localfs-smoke-$(Get-Random)"
$port = 9123
$AK   = "localtest"
$SK   = "localtestsecret123"

New-Item -ItemType Directory -Force -Path $root | Out-Null
Write-Host "root = $root"

# Start the server.
$proc = Start-Process -FilePath $bin `
  -ArgumentList @("--root", $root, "--port", $port, "--access-key", $AK, "--secret-key", $SK) `
  -PassThru -RedirectStandardOutput "$root\stdout.log" -RedirectStandardError "$root\stderr.log"

Start-Sleep -Seconds 1
if ($proc.HasExited) { Get-Content "$root\stderr.log"; throw "server exited early" }

$env:AWS_ACCESS_KEY_ID     = $AK
$env:AWS_SECRET_ACCESS_KEY = $SK
$env:AWS_DEFAULT_REGION    = "us-east-1"
$ep = "http://127.0.0.1:$port"

function S3 { param([Parameter(ValueFromRemainingArguments)]$a) aws --endpoint-url $ep @a }

try {
  Write-Host "== create bucket =="
  S3 s3 mb s3://demo

  Write-Host "== put object =="
  "hello localfs" | Out-File -Encoding ascii "$root\r.txt"
  S3 s3 cp "$root\r.txt" s3://demo/r.txt

  Write-Host "== list =="
  S3 s3 ls s3://demo/

  Write-Host "== roundtrip =="
  S3 s3 cp s3://demo/r.txt "$root\out.txt"
  $a = Get-Content "$root\r.txt" -Raw; $b = Get-Content "$root\out.txt" -Raw
  if ($a -ne $b) { throw "roundtrip mismatch" }
  Write-Host "roundtrip OK"

  Write-Host "== multipart (12MB, forces >5MB parts) =="
  $big = "$root\big.bin"
  $fs = [System.IO.File]::Create($big)
  $buf = New-Object byte[] (1MB); (New-Object Random).NextBytes($buf)
  for ($i=0; $i -lt 12; $i++) { $fs.Write($buf,0,$buf.Length) }
  $fs.Close()
  # Force multipart with a low threshold.
  S3 --cli-read-timeout 60 s3 cp "$big" s3://demo/big.bin --expected-size 12582912
  S3 s3 cp s3://demo/big.bin "$root\big.out"
  if ((Get-FileHash $big).Hash -ne (Get-FileHash "$root\big.out").Hash) { throw "multipart roundtrip hash mismatch" }
  Write-Host "multipart OK"

  Write-Host "== delete object + delete bucket =="
  S3 s3 rm s3://demo/r.txt
  S3 s3 rm s3://demo/big.bin
  S3 s3 rb s3://demo

  Write-Host "== auth negative (wrong secret -> 403) =="
  $env:AWS_SECRET_ACCESS_KEY = "WRONGSECRET"
  $denied = $false
  try { S3 s3 ls 2>$null } catch { $denied = $true }
  $code = $LASTEXITCODE
  if ($code -eq 0) { throw "wrong secret was accepted (expected 403)" }
  Write-Host "auth correctly rejected wrong secret (exit $code)"

  Write-Host "`nALL SMOKE TESTS PASSED"
}
finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
