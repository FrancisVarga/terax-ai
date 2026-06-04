# End-to-end conformance test: DuckDB (httpfs/S3) writes a Parquet file to the
# localfs S3 server and reads it back, against the built release binary.
#
# DuckDB's httpfs extension is a strict, independent S3 client — it performs real
# AWS SigV4 signing, multipart PUT for the COPY ... TO, and ranged GET for the
# Parquet footer + row groups on read. A green run here is strong evidence the
# server is genuinely S3-compatible beyond the AWS CLI (a different SDK lineage).
#
# Requires: the `duckdb` CLI on PATH. Run from anywhere; paths are absolute.
$ErrorActionPreference = "Stop"

$bin  = "E:\workspace\terax-ai-localfs\src-tauri\target\release\localfs.exe"
$root = Join-Path $env:TEMP "localfs-duckdb-$(Get-Random)"
$port = 9234
$AK   = "localtest"
$SK   = "localtestsecret123"

if (-not (Get-Command duckdb -ErrorAction SilentlyContinue)) {
  throw "duckdb CLI not found on PATH. Install from https://duckdb.org/docs/installation/ to run this test."
}

New-Item -ItemType Directory -Force -Path $root | Out-Null
Write-Host "root = $root"

$proc = Start-Process -FilePath $bin `
  -ArgumentList @("--root", $root, "--port", $port, "--access-key", $AK, "--secret-key", $SK) `
  -PassThru -RedirectStandardOutput "$root\stdout.log" -RedirectStandardError "$root\stderr.log"

Start-Sleep -Seconds 1
if ($proc.HasExited) { Get-Content "$root\stderr.log"; throw "server exited early" }

# DuckDB needs the bucket to exist before COPY ... TO. Create it with the AWS CLI
# if available; otherwise DuckDB can't auto-create buckets, so this is required.
$env:AWS_ACCESS_KEY_ID     = $AK
$env:AWS_SECRET_ACCESS_KEY = $SK
$env:AWS_DEFAULT_REGION    = "us-east-1"
$ep = "http://127.0.0.1:$port"
if (Get-Command aws -ErrorAction SilentlyContinue) {
  aws --endpoint-url $ep s3 mb s3://lake | Out-Null
} else {
  Write-Warning "aws CLI not found; relying on DuckDB to create the bucket (may fail)."
}

# DuckDB SQL: configure the S3 endpoint for httpfs (path-style, plain HTTP loopback),
# generate a 50k-row table, COPY it TO a Parquet object (write path = PUT/multipart),
# then read it back via parquet_scan (read path = ranged GET) and verify the count
# and an aggregate round-trip.
$sql = @"
INSTALL httpfs;
LOAD httpfs;
SET s3_endpoint='127.0.0.1:$port';
SET s3_use_ssl=false;
SET s3_url_style='path';
SET s3_region='us-east-1';
SET s3_access_key_id='$AK';
SET s3_secret_access_key='$SK';

-- write path: COPY a generated table to a Parquet object on the local S3 server
COPY (
  SELECT i AS id, i * 2 AS doubled, ('row-' || i) AS label
  FROM range(50000) t(i)
) TO 's3://lake/data/sample.parquet' (FORMAT PARQUET);

-- read path: scan it back over httpfs (ranged GET of footer + row groups)
SELECT
  count(*)        AS n,
  sum(doubled)    AS sum_doubled,
  min(label)      AS first_label
FROM parquet_scan('s3://lake/data/sample.parquet');
"@

try {
  Write-Host "== DuckDB COPY TO + parquet_scan over httpfs =="
  $out = $sql | duckdb -csv
  Write-Host $out

  # Expected: 50000 rows; sum(i*2) for i in [0,50000) = 2 * (49999*50000/2) = 2499950000.
  if ($out -notmatch "50000") { throw "row count 50000 not found in DuckDB output" }
  if ($out -notmatch "2499950000") { throw "sum_doubled 2499950000 not found (read-back mismatch)" }

  # Confirm the object actually landed on disk under the server root.
  $obj = Join-Path $root "lake\data\sample.parquet"
  if (-not (Test-Path $obj)) { throw "expected object missing on disk: $obj" }
  $size = (Get-Item $obj).Length
  Write-Host "object on disk: $obj ($size bytes)"

  Write-Host "`nDUCKDB HTTPFS PARQUET TEST PASSED"
}
finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
