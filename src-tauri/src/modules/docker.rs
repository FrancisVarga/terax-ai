//! Docker integration: list containers and inspect a single one.
//!
//! Rather than depend on a Docker-API crate, we shell out to the `docker` CLI
//! that the user already has on PATH. The CLI resolves `DOCKER_HOST` / the
//! local socket (or Windows named pipe) itself, so this works against local,
//! remote, and Docker-Desktop daemons without us reimplementing transport.
//!
//! `docker ps` is asked for one JSON object per line (`--format "{{json .}}"`);
//! `docker inspect` returns the full JSON array, which we pass through verbatim
//! as a `serde_json::Value` so the frontend can render every field generically
//! (config, environment, mounts, network, …) without us modeling the schema.

use serde::Serialize;
use serde_json::Value;
use std::process::Stdio;
use tokio::process::Command;

/// One container row for the list view. Mirrors the subset of `docker ps`
/// `--format json` fields we surface; serde snake_case maps to the TS type.
#[derive(Debug, Serialize)]
pub struct DockerContainer {
    /// Full or short container ID (`docker ps` returns the short 12-char form).
    pub id: String,
    pub name: String,
    pub image: String,
    /// Raw status string, e.g. "Up 3 hours" or "Exited (0) 2 days ago".
    pub status: String,
    /// "running" | "exited" | "paused" | "created" | … (the `State` column).
    pub state: String,
    /// Published/exposed ports as Docker prints them, e.g. "0.0.0.0:8080->80/tcp".
    pub ports: String,
    pub created: String,
}

/// A plausible SSH config alias: letters, digits, and the punctuation OpenSSH
/// allows in a Host token. Used to gate the value before it becomes part of a
/// `docker -H ssh://<alias>` argument, so a hostile alias can't inject flags or
/// a different transport scheme.
fn valid_alias(alias: &str) -> bool {
    !alias.is_empty()
        && alias
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Run `docker` with `args` against an optional remote `host` (an SSH config
/// alias). When `host` is set, `-H ssh://<alias>` is prepended so Docker's
/// native SSH transport connects to that server's daemon — reusing the user's
/// `~/.ssh/config` (hostname/user/port/key) exactly like the terminal `ssh`.
/// `None` targets the local daemon.
///
/// A non-zero exit (or a missing `docker` binary) becomes an `Err(String)` the
/// UI renders inline — the common cases being "docker not installed" and
/// "daemon not running".
async fn run_docker(host: Option<&str>, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("docker");
    if let Some(alias) = host {
        if !valid_alias(alias) {
            return Err(format!("invalid ssh host alias: {alias}"));
        }
        cmd.arg("-H").arg(format!("ssh://{alias}"));
    }
    let output = cmd
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| {
            // ErrorKind::NotFound → docker isn't on PATH at all.
            if e.kind() == std::io::ErrorKind::NotFound {
                "`docker` not found on PATH. Is Docker installed?".to_string()
            } else {
                format!("failed to run docker: {e}")
            }
        })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        // A stopped/absent daemon shows up here; surface it as-is.
        Err(if msg.is_empty() {
            format!("docker exited with status {}", output.status)
        } else {
            msg.to_string()
        })
    }
}

/// Pull a string field from a `docker ps` JSON line, tolerating absence.
fn field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// List containers via `docker ps`. Includes stopped containers (`-a`) so the
/// panel shows everything, not just running ones. Missing/empty output yields
/// an empty list rather than an error.
#[tauri::command]
pub async fn docker_list_containers(
    host: Option<String>,
) -> Result<Vec<DockerContainer>, String> {
    // `--no-trunc` keeps full names/IDs; one JSON object per line.
    let stdout = run_docker(
        host.as_deref(),
        &["ps", "-a", "--no-trunc", "--format", "{{json .}}"],
    )
    .await?;

    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            // Skip a malformed line rather than failing the whole list.
            Err(_) => continue,
        };
        out.push(DockerContainer {
            id: field(&v, "ID"),
            name: field(&v, "Names"),
            image: field(&v, "Image"),
            status: field(&v, "Status"),
            state: field(&v, "State"),
            ports: field(&v, "Ports"),
            created: field(&v, "CreatedAt"),
        });
    }
    Ok(out)
}

/// A single resource-usage snapshot for a container, parsed from one
/// `docker stats --no-stream` row. Strings like "12.34%" and "1.2kB / 3.4kB"
/// are reduced to numbers here so the frontend can plot them directly.
#[derive(Debug, Serialize, Default)]
pub struct DockerStats {
    /// CPU percent across all cores (Docker's `CPUPerc`, e.g. 12.34).
    pub cpu_percent: f64,
    /// Memory percent of the container's limit (`MemPerc`).
    pub mem_percent: f64,
    /// Memory used, bytes (left side of `MemUsage`).
    pub mem_used: f64,
    /// Memory limit, bytes (right side of `MemUsage`).
    pub mem_limit: f64,
    /// Network received / transmitted, bytes (`NetIO`).
    pub net_rx: f64,
    pub net_tx: f64,
    /// Block read / written, bytes (`BlockIO`).
    pub block_read: f64,
    pub block_write: f64,
    /// Number of PIDs (`PIDs`).
    pub pids: f64,
}

/// Parse a number with a Docker unit suffix (B, kB, MB, GB, TB, KiB, MiB, …)
/// into bytes. Docker stats uses SI (kB = 1000) for net/block and IEC (KiB)
/// for some fields; we handle both. Returns 0 for "--" / unparseable input.
fn parse_bytes(s: &str) -> f64 {
    let s = s.trim();
    if s.is_empty() || s == "--" {
        return 0.0;
    }
    // Split the numeric prefix from the unit suffix.
    let split = s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let Ok(value) = num.trim().parse::<f64>() else {
        return 0.0;
    };
    let mult = match unit.trim() {
        "B" | "" => 1.0,
        "kB" | "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0_f64.powi(4),
        _ => 1.0,
    };
    value * mult
}

/// Parse a percent string like "12.34%" → 12.34. "--" → 0.
fn parse_percent(s: &str) -> f64 {
    s.trim().trim_end_matches('%').trim().parse().unwrap_or(0.0)
}

/// Parse an "A / B" pair (net or block IO) into (A_bytes, B_bytes).
fn parse_pair(s: &str) -> (f64, f64) {
    let mut parts = s.split('/');
    let a = parse_bytes(parts.next().unwrap_or(""));
    let b = parse_bytes(parts.next().unwrap_or(""));
    (a, b)
}

/// One-shot resource snapshot via `docker stats --no-stream`. The streaming
/// form never terminates, so the frontend polls this on an interval and keeps
/// its own history for the live graphs. `host` targets a remote daemon.
#[tauri::command]
pub async fn docker_stats(id: String, host: Option<String>) -> Result<DockerStats, String> {
    if id.is_empty() || id.starts_with('-') {
        return Err("invalid container id".to_string());
    }
    let stdout = run_docker(
        host.as_deref(),
        &[
            "stats",
            "--no-stream",
            "--no-trunc",
            "--format",
            "{{json .}}",
            id.as_str(),
        ],
    )
    .await?;

    let line = stdout.lines().find(|l| !l.trim().is_empty());
    let Some(line) = line else {
        // No row → container likely stopped; zeros are a valid "idle" sample.
        return Ok(DockerStats::default());
    };
    let v: Value =
        serde_json::from_str(line.trim()).map_err(|e| format!("parse docker stats: {e}"))?;

    let get = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default();
    let (mem_used, mem_limit) = parse_pair(get("MemUsage"));
    let (net_rx, net_tx) = parse_pair(get("NetIO"));
    let (block_read, block_write) = parse_pair(get("BlockIO"));

    Ok(DockerStats {
        cpu_percent: parse_percent(get("CPUPerc")),
        mem_percent: parse_percent(get("MemPerc")),
        mem_used,
        mem_limit,
        net_rx,
        net_tx,
        block_read,
        block_write,
        pids: get("PIDs").parse().unwrap_or(0.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_units() {
        assert_eq!(parse_bytes("1.5kB"), 1500.0);
        assert_eq!(parse_bytes("2MB"), 2e6);
        assert_eq!(parse_bytes("1KiB"), 1024.0);
        assert_eq!(parse_bytes("--"), 0.0);
        assert_eq!(parse_bytes("512B"), 512.0);
    }

    #[test]
    fn percent_and_pair() {
        assert_eq!(parse_percent("12.34%"), 12.34);
        assert_eq!(parse_percent("--"), 0.0);
        let (a, b) = parse_pair("1.2kB / 3.4kB");
        assert_eq!(a, 1200.0);
        assert_eq!(b, 3400.0);
    }
}

/// Inspect a single container by id or name, returning the first element of
/// `docker inspect`'s JSON array (the full config/state/env/mounts/network blob)
/// for the frontend to render. Errors if the id is unknown.
#[tauri::command]
pub async fn docker_inspect_container(
    id: String,
    host: Option<String>,
) -> Result<Value, String> {
    // Reject anything that isn't a plausible id/name to avoid passing flags.
    if id.is_empty() || id.starts_with('-') {
        return Err("invalid container id".to_string());
    }
    let stdout = run_docker(host.as_deref(), &["inspect", id.as_str()]).await?;
    let parsed: Value =
        serde_json::from_str(&stdout).map_err(|e| format!("parse docker inspect: {e}"))?;

    match parsed {
        // `docker inspect` always returns an array; we want the single element.
        Value::Array(mut arr) if !arr.is_empty() => Ok(arr.swap_remove(0)),
        Value::Array(_) => Err(format!("no such container: {id}")),
        // Defensive: hand back whatever we got if it wasn't an array.
        other => Ok(other),
    }
}

/// Fetch the last `tail` log lines of a container, with timestamps. Docker
/// writes container logs to **both** stdout and stderr, so unlike `run_docker`
/// we merge the two streams here (interleaving is best-effort — they're drained
/// separately) so the UI shows everything the container emitted.
///
/// `tail` is clamped to a sane range; pass a large value for "all". `host`
/// targets a remote daemon over SSH as elsewhere.
#[tauri::command]
pub async fn docker_logs(
    id: String,
    host: Option<String>,
    tail: Option<u32>,
) -> Result<String, String> {
    if id.is_empty() || id.starts_with('-') {
        return Err("invalid container id".to_string());
    }
    if let Some(alias) = host.as_deref() {
        if !valid_alias(alias) {
            return Err(format!("invalid ssh host alias: {alias}"));
        }
    }
    let tail = tail.unwrap_or(1000).clamp(1, 50_000).to_string();

    let mut cmd = Command::new("docker");
    if let Some(alias) = host.as_deref() {
        cmd.arg("-H").arg(format!("ssh://{alias}"));
    }
    let output = cmd
        .args(["logs", "--tail", tail.as_str(), "--timestamps", id.as_str()])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "`docker` not found on PATH. Is Docker installed?".to_string()
            } else {
                format!("failed to run docker: {e}")
            }
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        // On failure docker's diagnostic is on stderr; surface it.
        let msg = stderr.trim();
        return Err(if msg.is_empty() {
            format!("docker logs exited with status {}", output.status)
        } else {
            msg.to_string()
        });
    }

    // Success: container logs may appear on either stream. Concatenate stdout
    // then stderr (each already ordered) rather than dropping either.
    let mut out = String::with_capacity(stdout.len() + stderr.len());
    out.push_str(&stdout);
    if !stderr.is_empty() {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&stderr);
    }
    Ok(out)
}
