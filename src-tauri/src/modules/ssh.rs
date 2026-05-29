use russh::client::{self, Handle, Handler};
use russh::keys::key;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// One resolved SSH host alias from `~/.ssh/config`.
///
/// Only concrete aliases are surfaced — pattern entries (`Host *`, `Host
/// web-*`) are skipped because they describe defaults for other hosts, not a
/// server you can click to connect to.
#[derive(Debug, Serialize)]
pub struct SshHost {
    /// The `Host` alias — what `ssh <alias>` is invoked with.
    pub alias: String,
    /// Resolved `HostName`, if set (else falls back to the alias on connect).
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    /// `IdentityFile` paths declared for this host, in config order (`~` and
    /// relative paths expanded). Honored before the built-in default key list.
    #[serde(skip)]
    pub identity_files: Vec<PathBuf>,
    /// `IdentitiesOnly yes` — when set, ONLY `identity_files` are tried; the
    /// default key list and any agent identities are not.
    #[serde(skip)]
    pub identities_only: bool,
    /// Source config file (the main file or an `Include`d one) for debugging.
    pub source: String,
}

fn ssh_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("config"))
}

/// True when a Host token is a glob/negation pattern rather than a literal
/// alias. Such entries set options for matching hosts and aren't connectable.
fn is_pattern(token: &str) -> bool {
    token.contains('*') || token.contains('?') || token.starts_with('!')
}

/// Split a directive line into (keyword, value). SSH config is whitespace- or
/// `=`-separated and keywords are case-insensitive.
fn split_directive(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    // Allow `Key=Value` and `Key Value` (with optional surrounding spaces).
    let (key, rest) = match line.find(|c: char| c.is_whitespace() || c == '=') {
        Some(idx) => {
            let key = &line[..idx];
            let rest = line[idx..].trim_start_matches(['=', ' ', '\t']);
            (key, rest)
        }
        None => (line, ""),
    };
    Some((key.to_ascii_lowercase(), rest.trim().to_string()))
}

/// Expand an `Include` value into concrete file paths. Relative paths resolve
/// against `~/.ssh`. Globs are expanded shallowly via directory listing.
fn resolve_includes(value: &str, ssh_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for raw in value.split_whitespace() {
        let expanded = if let Some(stripped) = raw.strip_prefix("~/") {
            dirs::home_dir()
                .map(|h| h.join(stripped))
                .unwrap_or_else(|| PathBuf::from(raw))
        } else {
            let p = PathBuf::from(raw);
            if p.is_absolute() {
                p
            } else {
                ssh_dir.join(raw)
            }
        };

        if expanded.exists() {
            out.push(expanded);
            continue;
        }
        // Shallow glob: only the final component may contain a wildcard.
        if let (Some(parent), Some(name)) = (expanded.parent(), expanded.file_name()) {
            let name = name.to_string_lossy();
            if is_pattern(&name) {
                if let Ok(entries) = std::fs::read_dir(parent) {
                    for entry in entries.flatten() {
                        let fname = entry.file_name();
                        if glob_match(&name, &fname.to_string_lossy()) {
                            out.push(entry.path());
                        }
                    }
                }
            }
        }
    }
    out
}

/// Expand a single config path value (`IdentityFile`): strip surrounding
/// quotes, expand a leading `~/`, and resolve relative paths against `~/.ssh`.
/// Returns `None` for an empty value.
fn expand_user_path(raw: &str, ssh_dir: &Path) -> Option<PathBuf> {
    let raw = raw.trim().trim_matches('"');
    if raw.is_empty() {
        return None;
    }
    if let Some(stripped) = raw.strip_prefix("~/") {
        return Some(
            dirs::home_dir()
                .map(|h| h.join(stripped))
                .unwrap_or_else(|| PathBuf::from(raw)),
        );
    }
    let p = PathBuf::from(raw);
    Some(if p.is_absolute() { p } else { ssh_dir.join(raw) })
}

/// Minimal glob matcher supporting `*` and `?` — enough for SSH `Include`
/// filenames. Not a general-purpose globber.
fn glob_match(pattern: &str, text: &str) -> bool {
    fn inner(p: &[u8], t: &[u8]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some(b'*'), _) => inner(&p[1..], t) || (!t.is_empty() && inner(p, &t[1..])),
            (Some(b'?'), Some(_)) => inner(&p[1..], &t[1..]),
            (Some(pc), Some(tc)) if pc == tc => inner(&p[1..], &t[1..]),
            _ => false,
        }
    }
    inner(pattern.as_bytes(), text.as_bytes())
}

fn parse_file(path: &Path, ssh_dir: &Path, visited: &mut HashSet<PathBuf>, out: &mut Vec<SshHost>) {
    // Guard against Include cycles.
    let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if !visited.insert(canon) {
        return;
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let source = path.to_string_lossy().to_string();

    // The aliases declared on the current `Host` line accumulate the directives
    // that follow until the next Host/Match block.
    let mut current: Vec<SshHost> = Vec::new();
    let flush = |current: &mut Vec<SshHost>, out: &mut Vec<SshHost>| {
        out.append(current);
    };

    for line in content.lines() {
        let Some((key, value)) = split_directive(line) else {
            continue;
        };
        match key.as_str() {
            "include" => {
                // Includes are processed inline so their hosts keep config order.
                flush(&mut current, out);
                for inc in resolve_includes(&value, ssh_dir) {
                    parse_file(&inc, ssh_dir, visited, out);
                }
            }
            "host" => {
                flush(&mut current, out);
                for alias in value.split_whitespace() {
                    if is_pattern(alias) {
                        continue;
                    }
                    current.push(SshHost {
                        alias: alias.to_string(),
                        hostname: None,
                        user: None,
                        port: None,
                        identity_files: Vec::new(),
                        identities_only: false,
                        source: source.clone(),
                    });
                }
            }
            // A `Match` block ends the current Host scope; we don't resolve
            // Match conditions, so just stop attributing directives to hosts.
            "match" => flush(&mut current, out),
            "hostname" => {
                for h in current.iter_mut() {
                    h.hostname = Some(value.clone());
                }
            }
            "user" => {
                for h in current.iter_mut() {
                    h.user = Some(value.clone());
                }
            }
            "port" => {
                if let Ok(port) = value.parse::<u16>() {
                    for h in current.iter_mut() {
                        h.port = Some(port);
                    }
                }
            }
            "identityfile" => {
                // A host may list multiple IdentityFile lines; accumulate them.
                if let Some(path) = expand_user_path(&value, ssh_dir) {
                    for h in current.iter_mut() {
                        h.identity_files.push(path.clone());
                    }
                }
            }
            "identitiesonly" => {
                let yes = value.eq_ignore_ascii_case("yes");
                for h in current.iter_mut() {
                    h.identities_only = yes;
                }
            }
            _ => {}
        }
    }
    flush(&mut current, out);
}

/// Read and parse the user's `~/.ssh/config`, returning connectable host
/// aliases in declaration order. Missing config is not an error — it yields an
/// empty list so the UI shows an empty state rather than a failure.
#[tauri::command]
pub fn ssh_list_hosts() -> Result<Vec<SshHost>, String> {
    let Some(config) = ssh_config_path() else {
        return Ok(Vec::new());
    };
    if !config.exists() {
        return Ok(Vec::new());
    }
    let ssh_dir = config.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut visited = HashSet::new();
    let mut out = Vec::new();
    parse_file(&config, &ssh_dir, &mut visited, &mut out);
    Ok(out)
}

// ───────────────────────── SFTP remote filesystem ─────────────────────────
//
// The terminal `ssh` already gives interactive access; this layer is a separate
// SFTP session (pure-Rust russh) used purely so the file-explorer tree can
// browse the remote host. Sessions are async and stored behind an Arc so they
// can be shared across `read_dir` calls without re-authenticating.

/// A directory entry over SFTP, shaped to match the local `fs_read_dir`
/// `DirEntry` so the frontend tree renders both identically.
#[derive(Debug, Serialize)]
pub struct RemoteDirEntry {
    pub name: String,
    /// "file" | "dir" | "symlink".
    pub kind: String,
    pub size: u64,
    /// mtime in seconds since the epoch (0 when unknown).
    pub mtime: u64,
}

/// A live remote connection: the russh handle (kept alive so the transport
/// stays open) plus the SFTP subsystem session built on top of it.
struct RemoteConn {
    sftp: Arc<SftpSession>,
    // Held so the SSH transport isn't dropped while the SFTP session is in use.
    _handle: Handle<ClientHandler>,
}

/// Pool of live SFTP sessions keyed by config alias. One session per host is
/// reused across `read_dir` calls so we don't re-auth on every expand.
#[derive(Clone, Default)]
pub struct SshFsState(Arc<Mutex<HashMap<String, Arc<RemoteConn>>>>);

/// russh client handler. Verifies the offered host key against the user's
/// `~/.ssh/known_hosts` and **fails closed**:
///
/// - key recorded and matches → accept;
/// - key recorded but changed → reject (possible MITM);
/// - host not in known_hosts → reject, because this handler has no interactive
///   prompt. The interactive `ssh` in the terminal *does* prompt on first
///   contact and writes known_hosts, so the intended flow is: connect once in
///   the terminal (which records + verifies the key), then SFTP trusts it.
///
/// This never returns a blanket `Ok(true)` — we refuse to send the user's
/// private key to an unverified peer.
struct ClientHandler {
    host: String,
    port: u16,
}

#[async_trait::async_trait]
impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Use an explicit `~/.ssh/known_hosts` path: russh-keys' built-in
        // `known_hosts_path()` resolves to `~/ssh/known_hosts` (no dot) on
        // Windows, which doesn't match where OpenSSH actually records keys.
        let known_hosts = match dirs::home_dir() {
            Some(h) => h.join(".ssh").join("known_hosts"),
            None => {
                log::error!("SFTP refused: no home directory to locate known_hosts");
                return Ok(false);
            }
        };
        match russh::keys::check_known_hosts_path(
            &self.host,
            self.port,
            server_public_key,
            &known_hosts,
        ) {
            // Recorded and matches.
            Ok(true) => Ok(true),
            // Unknown host — no prompt available here, refuse and let the user
            // verify via the terminal `ssh` first.
            Ok(false) => {
                log::warn!(
                    "SFTP refused: host '{}:{}' not in known_hosts. \
                     Connect once via the ssh terminal to record its key.",
                    self.host,
                    self.port
                );
                Ok(false)
            }
            // Recorded key CHANGED — treat as hostile, never trust.
            Err(e) => {
                log::error!(
                    "SFTP refused: host key for '{}:{}' does not match known_hosts \
                     (possible MITM): {e}",
                    self.host,
                    self.port
                );
                Ok(false)
            }
        }
    }
}

/// Identity selection resolved from `~/.ssh/config` for a host.
struct ResolvedIdentity {
    /// `IdentityFile` paths in config order (may be empty).
    files: Vec<PathBuf>,
    /// `IdentitiesOnly yes` — restrict auth to `files` only.
    only: bool,
}

/// Resolve a host alias to (hostname, user, port, identity) using the parsed
/// config, falling back to the alias itself as the hostname when no `HostName`
/// is set — mirroring how the ssh client treats a bare alias.
fn resolve_host(
    alias: &str,
) -> Result<(String, Option<String>, u16, ResolvedIdentity), String> {
    let hosts = ssh_list_hosts()?;
    let entry = hosts.into_iter().find(|h| h.alias == alias);
    match entry {
        Some(h) => Ok((
            h.hostname.unwrap_or_else(|| alias.to_string()),
            h.user,
            h.port.unwrap_or(22),
            ResolvedIdentity {
                files: h.identity_files,
                only: h.identities_only,
            },
        )),
        // Not in config — still allow a bare host:port style alias.
        None => Ok((
            alias.to_string(),
            None,
            22,
            ResolvedIdentity {
                files: Vec::new(),
                only: false,
            },
        )),
    }
}

/// Best-effort local username for when the config sets no `User`.
fn whoami() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".to_string())
}

/// Authenticate with public keys, honoring the host's `IdentityFile`/
/// `IdentitiesOnly` from `~/.ssh/config`:
///
/// - `IdentityFile` entries are tried first, in config order;
/// - with `IdentitiesOnly yes`, ONLY those entries are tried;
/// - otherwise we fall back to the conventional default key names.
///
/// Returns the first key that successfully authenticates. Passphrase-protected
/// keys are skipped (loaded with no passphrase) — consistent with the
/// keys-only, no-prompt policy.
async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    identity: &ResolvedIdentity,
) -> Result<(), String> {
    let Some(ssh_dir) = dirs::home_dir().map(|h| h.join(".ssh")) else {
        return Err("no home directory".to_string());
    };

    // Build the ordered candidate list: configured IdentityFiles first, then
    // the default names unless IdentitiesOnly restricts us to the configured set.
    let mut candidates: Vec<PathBuf> = identity.files.clone();
    if !identity.only {
        for name in ["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"] {
            let p = ssh_dir.join(name);
            if !candidates.contains(&p) {
                candidates.push(p);
            }
        }
    }

    let mut tried = 0;
    for key_path in &candidates {
        if !key_path.exists() {
            continue;
        }
        let key = match russh::keys::load_secret_key(key_path, None) {
            Ok(k) => k,
            // Encrypted / unsupported key — move on.
            Err(_) => continue,
        };
        tried += 1;
        match handle.authenticate_publickey(user, Arc::new(key)).await {
            Ok(true) => return Ok(()),
            Ok(false) => continue,
            Err(e) => return Err(format!("auth error: {e}")),
        }
    }

    if tried == 0 {
        if identity.only {
            Err("no usable IdentityFile keys for this host (IdentitiesOnly yes)".to_string())
        } else {
            Err("no usable private keys (IdentityFile or ~/.ssh defaults)".to_string())
        }
    } else {
        Err(format!("public-key authentication rejected for user '{user}'"))
    }
}

/// Establish a fresh SSH transport + SFTP session for `alias`.
async fn open_conn(alias: &str) -> Result<Arc<RemoteConn>, String> {
    let (host, user, port, identity) = resolve_host(alias)?;
    let user = user.unwrap_or_else(whoami);

    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..Default::default()
    });

    let handler = ClientHandler {
        host: host.clone(),
        port,
    };
    let mut handle = client::connect(config, (host.as_str(), port), handler)
        .await
        .map_err(|e| {
            // A rejected host key surfaces as a connect/disconnect error from
            // russh. Give the user the actionable next step.
            format!(
                "connect {host}:{port} failed: {e}. \
                 If this host is new, open it once in the ssh terminal to verify \
                 and record its key in known_hosts, then retry."
            )
        })?;

    authenticate(&mut handle, &user, &identity).await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("open channel: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("request sftp subsystem: {e}"))?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("start sftp: {e}"))?;

    Ok(Arc::new(RemoteConn {
        sftp: Arc::new(sftp),
        _handle: handle,
    }))
}

/// Get the pooled connection for `alias`, opening one if absent.
async fn get_conn(state: &SshFsState, alias: &str) -> Result<Arc<RemoteConn>, String> {
    {
        let pool = state.0.lock().await;
        if let Some(conn) = pool.get(alias) {
            return Ok(conn.clone());
        }
    }
    let conn = open_conn(alias).await?;
    let mut pool = state.0.lock().await;
    // Another task may have raced us — keep whichever landed first.
    let entry = pool.entry(alias.to_string()).or_insert(conn);
    Ok(entry.clone())
}

fn file_type_str(ft: FileType) -> &'static str {
    match ft {
        FileType::Dir => "dir",
        FileType::Symlink => "symlink",
        _ => "file",
    }
}

#[tauri::command]
pub async fn ssh_fs_connect(
    state: tauri::State<'_, SshFsState>,
    alias: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    let conn = get_conn(&state, &alias).await?;
    // Resolve the remote home directory (".") as the initial root.
    conn.sftp
        .canonicalize(".")
        .await
        .map_err(|e| format!("resolve remote home: {e}"))
        .map(|p| p.replace('\\', "/"))
}

#[tauri::command]
pub async fn ssh_fs_read_dir(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    path: String,
    show_hidden: bool,
) -> Result<Vec<RemoteDirEntry>, String> {
    let state = state.inner().clone();
    let conn = get_conn(&state, &alias).await?;

    let read = conn
        .sftp
        .read_dir(&path)
        .await
        .map_err(|e| format!("readdir {path}: {e}"))?;

    let mut out: Vec<RemoteDirEntry> = Vec::new();
    for entry in read {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let meta = entry.metadata();
        out.push(RemoteDirEntry {
            kind: file_type_str(entry.file_type()).to_string(),
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime.map(u64::from).unwrap_or(0),
            name,
        });
    }
    // Dirs first, then case-insensitive name — same ordering feel as local.
    out.sort_by(|a, b| {
        let ad = a.kind == "dir";
        let bd = b.kind == "dir";
        bd.cmp(&ad)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub async fn ssh_fs_read_file(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    path: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    let conn = get_conn(&state, &alias).await?;
    let bytes = conn
        .sftp
        .read(&path)
        .await
        .map_err(|e| format!("read {path}: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn ssh_fs_disconnect(
    state: tauri::State<'_, SshFsState>,
    alias: String,
) -> Result<(), String> {
    let mut pool = state.inner().0.lock().await;
    pool.remove(&alias);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_basics() {
        assert!(glob_match("config.d/*", "config.d/work"));
        assert!(glob_match("*.conf", "prod.conf"));
        assert!(!glob_match("*.conf", "prod.cfg"));
        assert!(glob_match("h?st", "host"));
    }

    #[test]
    fn directive_split() {
        assert_eq!(
            split_directive("  HostName  example.com "),
            Some(("hostname".into(), "example.com".into()))
        );
        assert_eq!(
            split_directive("Port=2222"),
            Some(("port".into(), "2222".into()))
        );
        assert_eq!(split_directive("# comment"), None);
    }
}
