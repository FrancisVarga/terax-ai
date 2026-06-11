use russh::client::{self, Handle, Handler};
use russh::keys::{PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, Sig};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, Notify};

use crate::modules::shell::ringbuffer::BoundedRingBuffer;

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
    /// True when `git check-ignore` matches this entry on the remote host, so
    /// the explorer dims it like the local tree does. False when the remote dir
    /// is not inside a git work tree (git errors → empty match set).
    pub ignored: bool,
}

/// A live remote connection: the russh handle (kept alive so the transport
/// stays open) plus the SFTP subsystem session built on top of it.
struct RemoteConn {
    sftp: Arc<SftpSession>,
    // Held so the SSH transport isn't dropped while the SFTP session is in use,
    // and reused to open exec channels (e.g. the package.json `find` walk).
    handle: Handle<ClientHandler>,
}

impl RemoteConn {
    /// Run a single command over a fresh exec channel and return its stdout.
    /// stderr is dropped (the caller only cares about the path list); a non-zero
    /// exit is NOT fatal — `find` returns 1 when it hits an unreadable dir but
    /// still prints everything it could walk, mirroring the local rg exit-2
    /// behavior in `fs_glob_rg`.
    async fn exec(&self, command: &str) -> Result<String, String> {
        Ok(self.exec_full(command).await?.stdout_string())
    }

    /// Run a command over a fresh exec channel, capturing stdout, stderr, and the
    /// exit code separately. Used by remote git/grep where the exit code and
    /// stderr drive control flow (e.g. "no commits yet", "not a repository").
    async fn exec_full(&self, command: &str) -> Result<RemoteExec, String> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("open exec channel: {e}"))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("exec failed: {e}"))?;

        let mut stdout: Vec<u8> = Vec::new();
        let mut stderr: Vec<u8> = Vec::new();
        let mut exit_code: Option<i32> = None;
        loop {
            match channel.wait().await {
                // `data` is stdout; `extended_data` stream 1 is stderr.
                Some(ChannelMsg::Data { ref data }) => stdout.extend_from_slice(data),
                Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                    stderr.extend_from_slice(data)
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status as i32)
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        Ok(RemoteExec {
            stdout,
            stderr,
            exit_code,
        })
    }
}

/// Captured result of a one-shot remote command.
struct RemoteExec {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: Option<i32>,
}

impl RemoteExec {
    fn stdout_string(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    fn stderr_string(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }

    fn ok(&self) -> bool {
        self.exit_code == Some(0)
    }
}

/// Pool of live SFTP sessions keyed by config alias. One session per host is
/// reused across `read_dir` calls so we don't re-auth on every expand.
#[derive(Clone, Default)]
pub struct SshFsState(Arc<Mutex<HashMap<String, Arc<RemoteConn>>>>);

// ───────────────────────── Remote background tasks ─────────────────────────
//
// A remote task (e.g. `pnpm run dev` on the SSH host) runs over a long-lived
// exec channel. A tokio task drains stdout+stderr into a bounded ring buffer;
// the frontend polls it with the SAME (handle, offset) shape as the local
// `shell_bg_*` commands, so the task-runner store can treat local and remote
// runs identically. Killing signals the remote process (SIGKILL) so a detached
// `dev` server doesn't outlive the panel.

const REMOTE_RING_CAP: usize = 4 * 1024 * 1024;

/// A streaming remote process: its output ring buffer, exit state, and a kill
/// signal the drain loop selects on.
struct RemoteBgProc {
    command: String,
    cwd: Option<String>,
    started_at_ms: u64,
    buffer: StdMutex<BoundedRingBuffer>,
    exited: AtomicBool,
    exit_code: AtomicI32,
    exit_unknown: AtomicBool,
    /// Notified to request a kill; the drain loop signals the channel and stops.
    kill: Arc<Notify>,
}

#[derive(Serialize)]
pub struct RemoteBgLogResponse {
    pub bytes: String,
    pub next_offset: u64,
    pub dropped: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

impl RemoteBgProc {
    fn read_logs(&self, since: u64) -> RemoteBgLogResponse {
        let (bytes, next_offset, dropped) = {
            let buf = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
            buf.read_from(since)
        };
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        RemoteBgLogResponse {
            bytes: String::from_utf8_lossy(&bytes).into_owned(),
            next_offset,
            dropped,
            exited,
            exit_code,
        }
    }
}

#[derive(Serialize)]
pub struct RemoteBgProcInfo {
    pub handle: u32,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

/// Registry of live remote background tasks, keyed by an opaque handle the
/// frontend polls. Separate from {@link SshFsState} so the SFTP pool and the
/// task registry have independent lifetimes.
#[derive(Clone, Default)]
pub struct SshBgState {
    procs: Arc<Mutex<HashMap<u32, Arc<RemoteBgProc>>>>,
    next_id: Arc<AtomicU32>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl RemoteConn {
    /// Spawn a long-running command over an exec channel and stream its output
    /// into `proc`'s ring buffer. The returned future runs until the remote
    /// process exits or `proc.kill` is notified. Spawned onto the tokio runtime
    /// by the caller so the command keeps running across poll calls.
    async fn run_streaming(self: Arc<Self>, command: String, proc: Arc<RemoteBgProc>) {
        let mut channel = match self.handle.channel_open_session().await {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("open channel: {e}\n");
                proc.buffer
                    .lock()
                    .unwrap_or_else(|x| x.into_inner())
                    .push(msg.as_bytes());
                proc.exit_unknown.store(true, Ordering::Release);
                proc.exited.store(true, Ordering::Release);
                return;
            }
        };
        if let Err(e) = channel.exec(true, command.as_bytes()).await {
            let msg = format!("exec: {e}\n");
            proc.buffer
                .lock()
                .unwrap_or_else(|x| x.into_inner())
                .push(msg.as_bytes());
            proc.exit_unknown.store(true, Ordering::Release);
            proc.exited.store(true, Ordering::Release);
            return;
        }

        let kill = proc.kill.clone();
        let mut killed = false;
        loop {
            tokio::select! {
                // Kill requested: SIGKILL the remote process, then close.
                _ = kill.notified(), if !killed => {
                    killed = true;
                    let _ = channel.signal(Sig::KILL).await;
                    let _ = channel.close().await;
                }
                msg = channel.wait() => {
                    match msg {
                        // stdout and stderr both fold into the one buffer so the
                        // log view is interleaved like a real terminal.
                        Some(ChannelMsg::Data { ref data }) => {
                            proc.buffer.lock().unwrap_or_else(|e| e.into_inner()).push(data);
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            proc.buffer.lock().unwrap_or_else(|e| e.into_inner()).push(data);
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            proc.exit_code.store(exit_status as i32, Ordering::Release);
                        }
                        Some(ChannelMsg::ExitSignal { .. }) => {
                            // Process killed by a signal — no numeric exit code.
                            proc.exit_unknown.store(true, Ordering::Release);
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
            }
        }
        proc.exited.store(true, Ordering::Release);
    }
}

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

// russh 0.61's `Handler` trait uses native `async fn` (RPITIT), not
// `#[async_trait]`. Annotating the impl with async_trait now desugars to a boxed
// future whose lifetimes no longer match the trait (E0195), so the attribute is
// gone and `check_server_key` stays a plain `async fn`.
impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
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

/// Try every identity loaded into the running ssh-agent. Encrypted on-disk keys
/// are deliberately not unlocked in-app (no passphrase prompt this milestone);
/// the supported path for them is `ssh-add` into the agent, which this honors.
///
/// Returns `Ok(true)` only when an agent identity authenticates. Any other
/// outcome (no agent, no identities, all rejected, transport error) yields
/// `Ok(false)` so the caller falls back to on-disk keys — the agent is an
/// addition, never a hard requirement.
///
/// russh-keys 0.45 only implements the Unix-domain-socket agent client
/// (`connect_env` reads `SSH_AUTH_SOCK`); it has no Windows named-pipe support,
/// so this is a no-op on Windows and on-disk keys are used there.
#[cfg(unix)]
async fn try_agent_auth(handle: &mut Handle<ClientHandler>, user: &str) -> bool {
    use russh::keys::agent::client::AgentClient;
    use russh::keys::agent::AgentIdentity;

    let mut agent = match AgentClient::connect_env().await {
        Ok(a) => a,
        // No SSH_AUTH_SOCK, or the socket is gone — nothing to try.
        Err(_) => return false,
    };
    let identities = match agent.request_identities().await {
        Ok(ids) => ids,
        Err(_) => return false,
    };
    for identity in identities {
        // russh 0.61 removed `authenticate_future`. The agent now acts as a
        // `Signer`: hand its public key to `authenticate_publickey_with` and let
        // the agent sign the challenge over the same `&mut agent` borrow. Only
        // plain public-key identities are tried here; agent certificates are not
        // part of this milestone's key-auth path.
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        match handle
            .authenticate_publickey_with(user, key, None, &mut agent)
            .await
        {
            Ok(res) if res.success() => return true,
            _ => continue,
        }
    }
    false
}

#[cfg(not(unix))]
async fn try_agent_auth(_handle: &mut Handle<ClientHandler>, _user: &str) -> bool {
    false
}

/// Authenticate, preferring the ssh-agent then falling back to on-disk keys,
/// honoring the host's `IdentityFile` / `IdentitiesOnly` from `~/.ssh/config`:
///
/// - the running ssh-agent's identities are tried first (covers encrypted keys
///   the user has `ssh-add`ed — the supported path for passphrase keys);
/// - then `IdentityFile` entries, in config order;
/// - with `IdentitiesOnly yes`, ONLY those entries are tried after the agent;
/// - otherwise we fall back to the conventional default key names.
///
/// Returns once a key successfully authenticates. Encrypted on-disk keys are
/// skipped (loaded with no passphrase) — consistent with the keys-only,
/// no-in-app-prompt policy; load them into the agent instead.
async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    identity: &ResolvedIdentity,
) -> Result<(), String> {
    // ssh-agent first: this is how passphrase-protected keys are supported.
    if try_agent_auth(handle, user).await {
        return Ok(());
    }

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
            // Encrypted / unsupported key — move on (use ssh-agent for these).
            Err(_) => continue,
        };
        tried += 1;
        // russh 0.61: authenticate_publickey takes a PrivateKeyWithHashAlg (None
        // = default hash; for RSA this maps to legacy sha-rsa) and returns an
        // AuthResult, so success is `.success()` rather than a bare bool.
        let key = PrivateKeyWithHashAlg::new(Arc::new(key), None);
        match handle.authenticate_publickey(user, key).await {
            Ok(res) if res.success() => return Ok(()),
            Ok(_) => continue,
            Err(e) => return Err(format!("auth error: {e}")),
        }
    }

    if tried == 0 {
        if identity.only {
            Err("no usable IdentityFile keys for this host (IdentitiesOnly yes); \
                 add the key to ssh-agent if it is passphrase-protected"
                .to_string())
        } else {
            Err("no usable private keys (ssh-agent, IdentityFile, or ~/.ssh defaults)".to_string())
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
        // russh defaults nodelay to false; Nagle + delayed-ACK adds tens of ms
        // to every write-write-read exchange, and this workload (exec, SFTP,
        // git plumbing) is exactly that shape. OpenSSH sets TCP_NODELAY too.
        nodelay: true,
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
        handle,
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
            ignored: false,
            name,
        });
    }

    // Mark git-ignored entries so the explorer dims them, mirroring the local
    // tree. One `git check-ignore` exec covers the whole directory; a remote dir
    // outside any git work tree yields an empty match set (git exits non-zero,
    // stdout empty) so nothing is dimmed — a safe default.
    let ignored = remote_git_ignored(&conn, &path, &out).await;
    for e in &mut out {
        if ignored.contains(&e.name) {
            e.ignored = true;
        }
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

/// Return the set of entry names in `dir` that git ignores on the remote host.
///
/// Runs a single `git check-ignore` from inside `dir`, passing each child's
/// basename as an argument; git echoes back the ones it ignores (verbatim, so
/// the returned names match `RemoteDirEntry::name` directly). Directories are
/// passed bare — git matches `node_modules` against a `node_modules/` rule
/// regardless of a trailing slash.
///
/// Failure modes all degrade to "nothing ignored": if `dir` is outside a git
/// work tree, git prints a fatal to stderr (dropped by `exec`) and exits
/// non-zero with empty stdout; if `git` is absent the command fails the same
/// way. Either way the caller leaves every entry un-dimmed, which is the
/// pre-existing behavior — so this only ever *adds* correct dimming.
async fn remote_git_ignored(
    conn: &RemoteConn,
    dir: &str,
    entries: &[RemoteDirEntry],
) -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    if entries.is_empty() {
        return HashSet::new();
    }
    // `--` stops git from treating a name that starts with `-` as a flag.
    let args = entries
        .iter()
        .map(|e| sh_single_quote(&e.name))
        .collect::<Vec<_>>()
        .join(" ");
    let cmd = format!(
        "cd {dir} && git check-ignore -- {args} 2>/dev/null",
        dir = sh_single_quote(dir),
    );
    let stdout = match conn.exec(&cmd).await {
        Ok(s) => s,
        Err(_) => return HashSet::new(),
    };
    stdout
        .lines()
        .map(|l| l.trim_end_matches('\r').trim())
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
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

/// Reject a remote path that carries control bytes (NUL, ESC, CR/LF). These are
/// never legitimate in a path and are a classic injection/truncation vector.
/// The richer secret-path deny-list runs frontend-side (`ai/lib/security.ts`)
/// before these commands are invoked; this is the backend defense-in-depth
/// floor that holds regardless of caller.
fn reject_control_bytes(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    if path.chars().any(|c| c.is_control()) {
        return Err("path contains control characters".into());
    }
    Ok(())
}

/// Write `content` to a remote file over SFTP, creating or truncating it.
/// Mirrors the local `fs_write_file` contract (overwrite allowed). SFTP has no
/// atomic-rename-into-place primitive exposed here, so this is a direct write;
/// the no-clobber guards live on the create/rename commands instead.
#[tauri::command]
pub async fn ssh_fs_write_file(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    path: String,
    content: String,
) -> Result<(), String> {
    reject_control_bytes(&path)?;
    let state = state.inner().clone();
    let conn = get_conn(&state, &alias).await?;
    // `create` opens CREATE|TRUNCATE|WRITE so this works whether the file exists
    // or not (the overwrite contract). The bare `SftpSession::write` helper would
    // open WRITE-only and fail on a not-yet-existing path.
    let mut file = conn
        .sftp
        .create(&path)
        .await
        .map_err(|e| format!("write {path}: {e}"))?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|e| format!("write {path}: {e}"))?;
    file.shutdown()
        .await
        .map_err(|e| format!("write {path}: {e}"))
}

/// Create an empty remote file. Fails if it already exists (no-clobber), matching
/// `fs_create_file`.
#[tauri::command]
pub async fn ssh_fs_create_file(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    path: String,
) -> Result<(), String> {
    reject_control_bytes(&path)?;
    let state = state.inner().clone();
    let conn = get_conn(&state, &alias).await?;
    if conn.sftp.try_exists(&path).await.unwrap_or(false) {
        return Err(format!("already exists: {path}"));
    }
    // `SftpSession::write` opens with WRITE only (no CREATE) — it fails on a
    // path that doesn't exist yet, so it can't make a new file. `create` opens
    // with CREATE|TRUNCATE|WRITE, which materializes the zero-length file on the
    // server. Explicitly `shutdown` (close) the handle so the create is flushed
    // before we return, rather than relying on Drop ordering.
    let mut file = conn
        .sftp
        .create(&path)
        .await
        .map_err(|e| format!("create file {path}: {e}"))?;
    file.shutdown()
        .await
        .map_err(|e| format!("create file {path}: {e}"))
}

/// Create a remote directory. Fails if it already exists, matching
/// `fs_create_dir`. Unlike the local command this does not create missing
/// parents — SFTP `mkdir` is single-level; the explorer only ever creates one
/// level at a time.
#[tauri::command]
pub async fn ssh_fs_create_dir(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    path: String,
) -> Result<(), String> {
    reject_control_bytes(&path)?;
    let state = state.inner().clone();
    let conn = get_conn(&state, &alias).await?;
    if conn.sftp.try_exists(&path).await.unwrap_or(false) {
        return Err(format!("already exists: {path}"));
    }
    conn.sftp
        .create_dir(&path)
        .await
        .map_err(|e| format!("create dir {path}: {e}"))
}

/// Rename (or move) a remote path. Refuses to overwrite an existing target —
/// the data-loss guard, matching `fs_rename`. The explicit `try_exists` check
/// makes the no-clobber contract independent of server-specific rename
/// semantics.
#[tauri::command]
pub async fn ssh_fs_rename(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    from: String,
    to: String,
) -> Result<(), String> {
    reject_control_bytes(&from)?;
    reject_control_bytes(&to)?;
    let state = state.inner().clone();
    let conn = get_conn(&state, &alias).await?;
    if !conn.sftp.try_exists(&from).await.unwrap_or(false) {
        return Err(format!("not found: {from}"));
    }
    if conn.sftp.try_exists(&to).await.unwrap_or(false) {
        return Err(format!("already exists: {to}"));
    }
    conn.sftp
        .rename(&from, &to)
        .await
        .map_err(|e| format!("rename {from} -> {to}: {e}"))
}

/// Copy a remote file or directory (recursively for dirs) to a new location.
/// Refuses to overwrite an existing target — the data-loss guard, matching
/// `fs_copy` and `ssh_fs_rename`. The `try_exists` check is done once up front;
/// `remote_copy` then recurses without re-checking, since a fresh subtree under
/// a guaranteed-empty destination can't collide.
#[tauri::command]
pub async fn ssh_fs_copy(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    from: String,
    to: String,
) -> Result<(), String> {
    reject_control_bytes(&from)?;
    reject_control_bytes(&to)?;
    let state = state.inner().clone();
    let conn = get_conn(&state, &alias).await?;
    if !conn.sftp.try_exists(&from).await.unwrap_or(false) {
        return Err(format!("not found: {from}"));
    }
    if conn.sftp.try_exists(&to).await.unwrap_or(false) {
        return Err(format!("already exists: {to}"));
    }
    remote_copy(&conn, &from, &to).await
}

/// Recursively copy a remote path. `symlink_metadata` (not `metadata`) keeps us
/// from following a symlink into its target: only a real directory is recursed
/// into; a symlink is copied through the file branch (its bytes) and never
/// walked into. SFTP exposes no link-creation primitive here, so a symlink to a
/// file ends up as a regular file copy — a remote-only divergence from local
/// `fs_copy`, which recreates the link. Files are streamed whole via
/// `read`/`write`, matching how the rest of this module moves remote bytes.
async fn remote_copy(conn: &RemoteConn, from: &str, to: &str) -> Result<(), String> {
    let meta = conn
        .sftp
        .symlink_metadata(from)
        .await
        .map_err(|e| format!("stat {from}: {e}"))?;

    // Only a *real* directory is recursed into. A symlink (even one resolving to
    // a dir) goes through the file branch and is never walked into.
    if meta.file_type() != FileType::Dir {
        let bytes = conn
            .sftp
            .read(from)
            .await
            .map_err(|e| format!("read {from}: {e}"))?;
        return conn
            .sftp
            .write(to, &bytes)
            .await
            .map_err(|e| format!("write {to}: {e}"));
    }

    conn.sftp
        .create_dir(to)
        .await
        .map_err(|e| format!("create dir {to}: {e}"))?;
    let entries = conn
        .sftp
        .read_dir(from)
        .await
        .map_err(|e| format!("readdir {from}: {e}"))?;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let join = |base: &str| {
            if base.ends_with('/') {
                format!("{base}{name}")
            } else {
                format!("{base}/{name}")
            }
        };
        Box::pin(remote_copy(conn, &join(from), &join(to))).await?;
    }
    Ok(())
}

/// Delete a remote file or directory. Directories are removed recursively
/// (depth-first), matching `fs_delete`'s `remove_dir_all` behavior. A symlink is
/// removed as the link itself (`remove_file`), never followed into its target.
#[tauri::command]
pub async fn ssh_fs_delete(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    path: String,
) -> Result<(), String> {
    reject_control_bytes(&path)?;
    let state = state.inner().clone();
    let conn = get_conn(&state, &alias).await?;
    remote_delete(&conn, &path).await
}

/// Recursively delete a remote path. `symlink_metadata` (not `metadata`) keeps
/// us from following a symlink into its target: a linked file/dir is unlinked,
/// not recursed into.
async fn remote_delete(conn: &RemoteConn, path: &str) -> Result<(), String> {
    let meta = conn
        .sftp
        .symlink_metadata(path)
        .await
        .map_err(|e| format!("stat {path}: {e}"))?;

    // A symlink (even one pointing at a dir) is unlinked as a plain file so we
    // never recurse through it and wipe the target's contents.
    let is_real_dir = meta.file_type() == FileType::Dir;
    if !is_real_dir {
        return conn
            .sftp
            .remove_file(path)
            .await
            .map_err(|e| format!("delete {path}: {e}"));
    }

    let entries = conn
        .sftp
        .read_dir(path)
        .await
        .map_err(|e| format!("readdir {path}: {e}"))?;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child = if path.ends_with('/') {
            format!("{path}{name}")
        } else {
            format!("{path}/{name}")
        };
        Box::pin(remote_delete(conn, &child)).await?;
    }
    conn.sftp
        .remove_dir(path)
        .await
        .map_err(|e| format!("delete dir {path}: {e}"))
}

/// Single-quote a string for a POSIX shell: wrap in `'…'` and escape any
/// embedded single quote as `'\''`. Used to splice the remote root path into
/// the `find` command without letting it break out of the argument.
fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Walk a remote tree over SSH and return every file whose basename matches one
/// of `names` (e.g. `package.json`, lockfiles), pruning `node_modules` and
/// `.git`. The walk runs server-side via a single `find` exec — one round-trip
/// instead of hundreds of SFTP `read_dir` calls — so it stays responsive even
/// on deep trees over a high-latency link.
///
/// Returns absolute remote paths (always `/`-separated). Requires a POSIX shell
/// + `find` on the remote, which holds for the Linux hosts this targets.
#[tauri::command]
pub async fn ssh_fs_glob(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    root: String,
    names: Vec<String>,
) -> Result<Vec<String>, String> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let state = state.inner().clone();
    let conn = get_conn(&state, &alias).await?;

    // Build: find <root> \( -name 'a' -o -name 'b' \) -type f -not -path '*/node_modules/*' -not -path '*/.git/*'
    let name_tests = names
        .iter()
        .map(|n| format!("-name {}", sh_single_quote(n)))
        .collect::<Vec<_>>()
        .join(" -o ");
    let cmd = format!(
        "find {root} \\( {names} \\) -type f \
         -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null",
        root = sh_single_quote(&root),
        names = name_tests,
    );

    let stdout = conn.exec(&cmd).await?;
    let hits = stdout
        .lines()
        .map(|l| l.trim_end_matches('\r').trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.replace('\\', "/"))
        .collect();
    Ok(hits)
}

/// Spawn a long-running command on the remote host and return a poll handle.
/// `cwd` (an absolute remote path) is prefixed as `cd <cwd> && <command>` since
/// an exec channel has no working-directory concept. Output streams into a ring
/// buffer polled via {@link ssh_bg_logs}.
#[tauri::command]
pub async fn ssh_bg_spawn(
    fs_state: tauri::State<'_, SshFsState>,
    bg_state: tauri::State<'_, SshBgState>,
    alias: String,
    command: String,
    cwd: Option<String>,
) -> Result<u32, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    let fs_state = fs_state.inner().clone();
    let conn = get_conn(&fs_state, &alias).await?;

    // Run under a login-ish shell so the remote PATH (nvm, pnpm shims, etc.) is
    // populated the way an interactive `ssh` session would see it.
    let full = match cwd.as_deref().filter(|s| !s.is_empty()) {
        Some(dir) => format!("cd {} && {}", sh_single_quote(dir), trimmed),
        None => trimmed.clone(),
    };

    let proc = Arc::new(RemoteBgProc {
        command: trimmed,
        cwd,
        started_at_ms: now_ms(),
        buffer: StdMutex::new(BoundedRingBuffer::new(REMOTE_RING_CAP)),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
        exit_unknown: AtomicBool::new(false),
        kill: Arc::new(Notify::new()),
    });

    let id = bg_state.next_id.fetch_add(1, Ordering::Relaxed).max(1);
    bg_state.procs.lock().await.insert(id, proc.clone());

    // Detach: the streaming task outlives this command call.
    tauri::async_runtime::spawn(conn.run_streaming(full, proc));
    Ok(id)
}

#[tauri::command]
pub async fn ssh_bg_logs(
    bg_state: tauri::State<'_, SshBgState>,
    handle: u32,
    since_offset: Option<u64>,
) -> Result<RemoteBgLogResponse, String> {
    let proc = bg_state
        .procs
        .lock()
        .await
        .get(&handle)
        .cloned()
        .ok_or_else(|| "no remote background handle".to_string())?;
    Ok(proc.read_logs(since_offset.unwrap_or(0)))
}

#[tauri::command]
pub async fn ssh_bg_kill(
    bg_state: tauri::State<'_, SshBgState>,
    handle: u32,
) -> Result<(), String> {
    if let Some(proc) = bg_state.procs.lock().await.get(&handle).cloned() {
        proc.kill.notify_one();
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_bg_list(
    bg_state: tauri::State<'_, SshBgState>,
) -> Result<Vec<RemoteBgProcInfo>, String> {
    let map = bg_state.procs.lock().await;
    let mut out: Vec<RemoteBgProcInfo> = map
        .iter()
        .map(|(id, p)| {
            let exited = p.exited.load(Ordering::Acquire);
            let exit_code = if exited && !p.exit_unknown.load(Ordering::Acquire) {
                Some(p.exit_code.load(Ordering::Acquire))
            } else {
                None
            };
            RemoteBgProcInfo {
                handle: *id,
                command: p.command.clone(),
                cwd: p.cwd.clone(),
                started_at_ms: p.started_at_ms,
                exited,
                exit_code,
            }
        })
        .collect();
    out.sort_by_key(|i| i.handle);
    Ok(out)
}

// ───────────────────────── Remote git over SSH exec ─────────────────────────
//
// Remote git reuses the host's own `git` binary over an exec channel, exactly as
// the WSL backend runs `wsl.exe --exec git`. The repo root and every path arg are
// POSIX-single-quoted before being spliced into `cd <root> && git <args>`, so a
// path containing spaces or shell metacharacters can never break out of the
// command. Output is parsed with the SAME parsers the local backend uses
// (`git::parser::parse_porcelain_v2`), so local and remote status render
// identically. The SSH connection is the trust boundary (host-key-verified +
// authenticated), so there is no separate workspace-authorization registry here.

use crate::modules::git::parser::parse_porcelain_v2;
use crate::modules::git::types::{
    GitCommitResult, GitDiffContentResult, GitDiffResult, GitLogEntry, GitPanelSnapshot,
    GitRepoInfo, GitStatusSnapshot,
};

const REMOTE_GIT_TIMEOUT_HINT: &str = "remote git";

/// A hex commit identifier safe to splice into a git revision argument.
fn sha_is_safe(sha: &str) -> bool {
    !sha.is_empty() && sha.len() <= 64 && sha.chars().all(|c| c.is_ascii_hexdigit())
}

/// Build `cd '<root>' && git <single-quoted args...>`. `LC_ALL=C` and
/// `GIT_OPTIONAL_LOCKS=0` mirror the local runner's environment so output is
/// parseable and read-only commands don't take the index lock.
fn remote_git_command(root: &str, args: &[&str]) -> String {
    let mut cmd = format!(
        "cd {} && LC_ALL=C GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 git",
        sh_single_quote(root)
    );
    for a in args {
        cmd.push(' ');
        cmd.push_str(&sh_single_quote(a));
    }
    cmd
}

async fn remote_git(
    state: &SshFsState,
    alias: &str,
    root: &str,
    args: &[&str],
) -> Result<RemoteExec, String> {
    let conn = get_conn(state, alias).await?;
    conn.exec_full(&remote_git_command(root, args)).await
}

/// stdout decoded as lossy UTF-8 (git output is normally UTF-8; non-UTF-8 bytes
/// are replaced rather than failing the whole command).
fn git_text(out: &RemoteExec) -> String {
    out.stdout_string()
}

#[tauri::command]
pub async fn ssh_git_panel_snapshot(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    cwd: String,
) -> Result<GitPanelSnapshot, String> {
    let state = state.inner().clone();
    // Resolve the repo toplevel from the browsed cwd.
    let top = remote_git(&state, &alias, &cwd, &["rev-parse", "--show-toplevel"]).await?;
    if !top.ok() {
        // Not a git repository — empty snapshot, not an error (matches local).
        return Ok(GitPanelSnapshot {
            repo: None,
            status: None,
        });
    }
    let repo_root = top.stdout_string().trim().to_string();
    if repo_root.is_empty() {
        return Ok(GitPanelSnapshot {
            repo: None,
            status: None,
        });
    }
    let status = remote_status_inner(&state, &alias, &repo_root).await?;
    let repo = GitRepoInfo {
        repo_root: repo_root.clone(),
        branch: status.branch.clone(),
        upstream: status.upstream.clone(),
        is_detached: status.is_detached,
    };
    Ok(GitPanelSnapshot {
        repo: Some(repo),
        status: Some(status),
    })
}

#[tauri::command]
pub async fn ssh_git_status(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    repo_root: String,
) -> Result<GitStatusSnapshot, String> {
    let state = state.inner().clone();
    remote_status_inner(&state, &alias, &repo_root).await
}

async fn remote_status_inner(
    state: &SshFsState,
    alias: &str,
    repo_root: &str,
) -> Result<GitStatusSnapshot, String> {
    let out = remote_git(
        state,
        alias,
        repo_root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )
    .await?;
    if !out.ok() {
        return Err(format!(
            "{REMOTE_GIT_TIMEOUT_HINT} status failed: {}",
            out.stderr_string().trim()
        ));
    }
    let parsed = parse_porcelain_v2(&out.stdout_string());
    Ok(GitStatusSnapshot {
        repo_root: repo_root.to_string(),
        branch: parsed.branch,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        is_detached: parsed.is_detached,
        truncated: false,
        changed_files: parsed.files,
    })
}

#[tauri::command]
pub async fn ssh_git_diff(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    repo_root: String,
    path: Option<String>,
    staged: bool,
) -> Result<GitDiffResult, String> {
    let state = state.inner().clone();
    let mut args: Vec<&str> = vec!["diff", "--no-ext-diff"];
    if staged {
        args.push("--cached");
    }
    let rel = path.as_deref().filter(|p| !p.is_empty());
    if let Some(p) = rel {
        args.push("--");
        args.push(p);
    }
    let out = remote_git(&state, &alias, &repo_root, &args).await?;
    if !out.ok() {
        return Err(format!("remote git diff failed: {}", out.stderr_string().trim()));
    }
    Ok(GitDiffResult {
        diff_text: git_text(&out),
        truncated: false,
    })
}

#[tauri::command]
pub async fn ssh_git_diff_content(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    repo_root: String,
    path: String,
    staged: bool,
    original_path: Option<String>,
) -> Result<GitDiffContentResult, String> {
    let state = state.inner().clone();
    let rel = path.trim_start_matches('/').to_string();
    let orig_rel = original_path
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(|p| p.trim_start_matches('/').to_string());

    // Original side: index (`:path`) or HEAD (`HEAD:path`) when staged.
    let original_spec = if staged {
        format!("HEAD:{}", orig_rel.as_deref().unwrap_or(&rel))
    } else {
        format!(":{rel}")
    };
    let original = remote_git(
        &state,
        &alias,
        &repo_root,
        &["show", "--no-textconv", &original_spec],
    )
    .await?;

    // Modified side: index (`:path`) when staged, else the worktree file.
    let modified_text = if staged {
        let m = remote_git(
            &state,
            &alias,
            &repo_root,
            &["show", "--no-textconv", &format!(":{rel}")],
        )
        .await?;
        if m.ok() { m.stdout_string() } else { String::new() }
    } else {
        // Read the worktree file via SFTP for the modified side.
        let conn = get_conn(&state, &alias).await?;
        let abs = if repo_root.ends_with('/') {
            format!("{repo_root}{rel}")
        } else {
            format!("{repo_root}/{rel}")
        };
        match conn.sftp.read(&abs).await {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => String::new(),
        }
    };

    let mut diff_args: Vec<&str> = vec!["diff", "--no-ext-diff"];
    if staged {
        diff_args.push("--cached");
    }
    diff_args.push("--");
    diff_args.push(&rel);
    let patch = remote_git(&state, &alias, &repo_root, &diff_args).await?;

    Ok(GitDiffContentResult {
        original_content: if original.ok() {
            original.stdout_string()
        } else {
            String::new()
        },
        modified_content: modified_text,
        is_binary: false,
        fallback_patch: git_text(&patch),
        truncated: false,
    })
}

#[tauri::command]
pub async fn ssh_git_stage(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    repo_root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let state = state.inner().clone();
    let mut args: Vec<&str> = vec!["add", "--"];
    for p in &paths {
        args.push(p);
    }
    let out = remote_git(&state, &alias, &repo_root, &args).await?;
    if out.ok() {
        Ok(())
    } else {
        Err(format!("remote git add failed: {}", out.stderr_string().trim()))
    }
}

#[tauri::command]
pub async fn ssh_git_unstage(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    repo_root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let state = state.inner().clone();
    let mut args: Vec<&str> = vec!["reset", "HEAD", "--"];
    for p in &paths {
        args.push(p);
    }
    let out = remote_git(&state, &alias, &repo_root, &args).await?;
    if out.ok() {
        return Ok(());
    }
    // No HEAD yet (unborn branch): fall back to `rm --cached`.
    let lower = out.stderr_string().to_ascii_lowercase();
    let no_head = lower.contains("ambiguous argument 'head'")
        || lower.contains("unknown revision")
        || lower.contains("does not have any commits yet");
    if !no_head {
        return Err(format!("remote git reset failed: {}", out.stderr_string().trim()));
    }
    let mut rm_args: Vec<&str> = vec!["rm", "--cached", "-r", "--"];
    for p in &paths {
        rm_args.push(p);
    }
    let out = remote_git(&state, &alias, &repo_root, &rm_args).await?;
    if out.ok() {
        Ok(())
    } else {
        Err(format!("remote git rm --cached failed: {}", out.stderr_string().trim()))
    }
}

#[tauri::command]
pub async fn ssh_git_discard(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    repo_root: String,
    tracked: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    let state = state.inner().clone();
    if !tracked.is_empty() {
        let mut args: Vec<&str> = vec!["restore", "--worktree", "--"];
        for p in &tracked {
            args.push(p);
        }
        let out = remote_git(&state, &alias, &repo_root, &args).await?;
        if !out.ok() {
            return Err(format!("remote git restore failed: {}", out.stderr_string().trim()));
        }
    }
    if !untracked.is_empty() {
        let mut args: Vec<&str> = vec!["clean", "-f", "-d", "--"];
        for p in &untracked {
            args.push(p);
        }
        let out = remote_git(&state, &alias, &repo_root, &args).await?;
        if !out.ok() {
            return Err(format!("remote git clean failed: {}", out.stderr_string().trim()));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_git_commit(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    repo_root: String,
    message: String,
) -> Result<GitCommitResult, String> {
    let trimmed = message.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty commit message".into());
    }
    let state = state.inner().clone();
    let out = remote_git(&state, &alias, &repo_root, &["commit", "-m", &trimmed]).await?;
    if !out.ok() {
        let lower = format!("{}{}", out.stderr_string(), out.stdout_string()).to_ascii_lowercase();
        if lower.contains("nothing to commit") {
            return Err("nothing staged to commit".into());
        }
        return Err(format!("remote git commit failed: {}", out.stderr_string().trim()));
    }
    let shown = remote_git(
        &state,
        &alias,
        &repo_root,
        &["show", "-s", "--format=%H%n%s", "HEAD"],
    )
    .await?;
    let text = shown.stdout_string();
    let mut lines = text.lines();
    let sha = lines.next().unwrap_or("").trim().to_string();
    let summary = lines.next().unwrap_or("").trim().to_string();
    Ok(GitCommitResult {
        commit_sha: sha,
        summary,
    })
}

const REMOTE_LOG_FORMAT: &str = "%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%s";

#[tauri::command]
pub async fn ssh_git_log(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    repo_root: String,
    limit: u32,
    before_sha: Option<String>,
) -> Result<Vec<GitLogEntry>, String> {
    let state = state.inner().clone();
    let bounded = limit.clamp(1, 200);
    let count_arg = format!("--max-count={bounded}");
    let format_arg = format!("--format={REMOTE_LOG_FORMAT}");
    let cursor = match before_sha.as_deref().filter(|s| !s.is_empty()) {
        Some(sha) => {
            if !sha_is_safe(sha) {
                return Err("invalid cursor sha".into());
            }
            Some(format!("{sha}^"))
        }
        None => None,
    };
    let mut args: Vec<&str> = vec!["log", "--no-color", "--shortstat", &count_arg, &format_arg];
    if let Some(c) = cursor.as_deref() {
        args.push(c);
    }
    let out = remote_git(&state, &alias, &repo_root, &args).await?;
    if !out.ok() {
        let lower = out.stderr_string().to_ascii_lowercase();
        if lower.contains("does not have any commits yet")
            || lower.contains("bad default revision")
            || lower.contains("unknown revision")
            || lower.contains("ambiguous argument 'head'")
        {
            return Ok(Vec::new());
        }
        return Err(format!("remote git log failed: {}", out.stderr_string().trim()));
    }
    Ok(parse_remote_log(&out.stdout_string(), bounded as usize))
}

fn parse_remote_log(stdout: &str, cap: usize) -> Vec<GitLogEntry> {
    let mut entries: Vec<GitLogEntry> = Vec::with_capacity(cap);
    for raw in stdout.lines() {
        let line = raw.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if line.contains('\x1f') {
            let mut f = line.splitn(6, '\x1f');
            let sha = f.next().unwrap_or("").to_string();
            if !sha_is_safe(&sha) {
                continue;
            }
            let author = f.next().unwrap_or("").to_string();
            let author_email = f.next().unwrap_or("").to_string();
            let timestamp = f.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
            let parents: Vec<String> = f
                .next()
                .unwrap_or("")
                .split_ascii_whitespace()
                .map(str::to_string)
                .collect();
            let subject = f.next().unwrap_or("").to_string();
            let short_sha = sha.chars().take(7).collect::<String>();
            entries.push(GitLogEntry {
                sha,
                short_sha,
                author,
                author_email,
                timestamp_secs: timestamp,
                parents,
                subject,
                files_changed: 0,
                insertions: 0,
                deletions: 0,
            });
            continue;
        }
        if let Some(cur) = entries.last_mut() {
            if line.contains("file changed") || line.contains("files changed") {
                let (fc, ins, del) = parse_remote_shortstat(line);
                cur.files_changed = fc;
                cur.insertions = ins;
                cur.deletions = del;
            }
        }
    }
    entries
}

fn parse_remote_shortstat(line: &str) -> (u32, u32, u32) {
    let trimmed = line.trim();
    let mut files = 0u32;
    let mut ins = 0u32;
    let mut del = 0u32;
    for part in trimmed.split(',') {
        let part = part.trim();
        let n: u32 = part
            .split_ascii_whitespace()
            .next()
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
        if part.contains("file") {
            files = n;
        } else if part.contains("insertion") {
            ins = n;
        } else if part.contains("deletion") {
            del = n;
        }
    }
    (files, ins, del)
}

#[tauri::command]
pub async fn ssh_git_show_commit(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    repo_root: String,
    sha: String,
) -> Result<GitDiffResult, String> {
    if !sha_is_safe(&sha) {
        return Err("invalid commit identifier".into());
    }
    let state = state.inner().clone();
    let out = remote_git(
        &state,
        &alias,
        &repo_root,
        &[
            "show",
            "--no-color",
            "--no-ext-diff",
            "--patch-with-stat",
            &sha,
            "--",
        ],
    )
    .await?;
    if !out.ok() {
        return Err(format!("remote git show failed: {}", out.stderr_string().trim()));
    }
    Ok(GitDiffResult {
        diff_text: git_text(&out),
        truncated: false,
    })
}

#[tauri::command]
pub async fn ssh_git_resolve_repo(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    cwd: String,
) -> Result<Option<GitRepoInfo>, String> {
    let state = state.inner().clone();
    let top = remote_git(&state, &alias, &cwd, &["rev-parse", "--show-toplevel"]).await?;
    if !top.ok() {
        return Ok(None);
    }
    let repo_root = top.stdout_string().trim().to_string();
    if repo_root.is_empty() {
        return Ok(None);
    }
    // The branch and upstream lookups are independent once the root is known, so
    // run them concurrently — their SSH round-trips overlap on the multiplexed
    // transport (wall-clock ≈ one RTT instead of two).
    let (branch_out, upstream_out) = tokio::join!(
        remote_git(
            &state,
            &alias,
            &repo_root,
            &["rev-parse", "--abbrev-ref", "HEAD"],
        ),
        remote_git(
            &state,
            &alias,
            &repo_root,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        ),
    );
    let branch_out = branch_out?;
    let upstream_out = upstream_out?;
    let branch = branch_out.stdout_string().trim().to_string();
    let upstream = if upstream_out.ok() {
        let u = upstream_out.stdout_string().trim().to_string();
        if u.is_empty() {
            None
        } else {
            Some(u)
        }
    } else {
        None
    };
    Ok(Some(GitRepoInfo {
        repo_root,
        branch: branch.clone(),
        upstream,
        is_detached: branch == "HEAD" || branch.is_empty(),
    }))
}

#[tauri::command]
pub async fn ssh_git_remote_url(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    repo_root: String,
    name: String,
) -> Result<Option<String>, String> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    let key = format!("remote.{name}.url");
    let out = remote_git(&state, &alias, &repo_root, &["config", "--get", &key]).await?;
    if !out.ok() {
        return Ok(None);
    }
    let url = out.stdout_string().trim().to_string();
    Ok(if url.is_empty() { None } else { Some(url) })
}

// ───────────────────────── Remote search + grep over SSH exec ─────────────────────────
//
// File search and content search run the host's own tools over an exec channel:
// `rg` is preferred (fast, gitignore-aware) with a POSIX `find` / `grep -rn`
// fallback so a host without ripgrep still works. Results are shaped to match the
// local `SearchResult`/`GrepResponse` so the fuzzy finder and content-search UI
// render remote and local hits identically. All user-supplied strings (root,
// query, pattern, globs) are POSIX-single-quoted before splicing.

use crate::modules::fs::grep::{GrepHit, GrepResponse};
use crate::modules::fs::search::{SearchHit, SearchResult};

const REMOTE_SEARCH_PRUNE: &str =
    "-not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/target/*' \
     -not -path '*/dist/*' -not -path '*/.next/*'";

/// Strip the `root` prefix from an absolute remote path to get a display-relative
/// path. Both are POSIX (`/`-separated).
fn remote_rel(root: &str, abs: &str) -> String {
    let root_trim = root.trim_end_matches('/');
    abs.strip_prefix(root_trim)
        .map(|s| s.trim_start_matches('/').to_string())
        .unwrap_or_else(|| abs.to_string())
}

fn remote_basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// Fuzzy-ish file search on the remote host. Lists candidate files via
/// `rg --files` (gitignore-aware) and filters them to those whose path contains
/// the query substring (case-insensitive), mirroring the local explorer search
/// feel. Falls back to `find` when ripgrep is absent.
#[tauri::command]
pub async fn ssh_fs_search(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<SearchResult, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            truncated: false,
        });
    }
    let cap = limit.unwrap_or(200).min(1000);
    let state = state.inner().clone();
    let conn = get_conn(&state, &alias).await?;

    // Prefer rg --files; fall back to a pruned find. `2>/dev/null` so a missing
    // tool or unreadable dir doesn't pollute stdout.
    let root_q = sh_single_quote(&root);
    let cmd = format!(
        "(cd {root_q} && rg --files --hidden --glob '!.git' 2>/dev/null) \
         || find {root_q} -type f {prune} 2>/dev/null",
        prune = REMOTE_SEARCH_PRUNE,
    );
    let stdout = conn.exec(&cmd).await?;

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut truncated = false;
    for raw in stdout.lines() {
        let line = raw.trim_end_matches('\r').trim();
        if line.is_empty() {
            continue;
        }
        // rg --files prints paths relative to root; find prints absolute. Build
        // a canonical absolute path either way.
        let abs = if line.starts_with('/') {
            line.replace('\\', "/")
        } else {
            let root_trim = root.trim_end_matches('/');
            format!("{root_trim}/{}", line.replace('\\', "/"))
        };
        let rel = remote_rel(&root, &abs);
        if !rel.to_lowercase().contains(&q) {
            continue;
        }
        if hits.len() >= cap {
            truncated = true;
            break;
        }
        let name = remote_basename(&abs);
        hits.push(SearchHit {
            path: abs,
            rel,
            name,
            is_dir: false,
        });
    }
    Ok(SearchResult { hits, truncated })
}

/// Content search on the remote host. Runs `rg` with JSON output for precise
/// line/column parsing, falling back to `grep -rn` when ripgrep is absent.
#[tauri::command]
pub async fn ssh_fs_grep(
    state: tauri::State<'_, SshFsState>,
    alias: String,
    pattern: String,
    root: String,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
) -> Result<GrepResponse, String> {
    if pattern.trim().is_empty() {
        return Err("empty pattern".into());
    }
    let cap = max_results.unwrap_or(200).clamp(1, 2000);
    let state = state.inner().clone();
    let conn = get_conn(&state, &alias).await?;

    let root_q = sh_single_quote(&root);
    let pat_q = sh_single_quote(&pattern);
    let ci = if case_insensitive.unwrap_or(false) {
        "-i "
    } else {
        ""
    };
    // rg with --no-heading --line-number --with-filename gives `path:line:text`.
    // grep -rn fallback emits the same shape. Both prune VCS/build dirs.
    let cmd = format!(
        "(cd {root_q} && rg --no-heading --line-number --with-filename --color=never {ci}-e {pat_q} . 2>/dev/null) \
         || grep -rn {ci}-e {pat_q} {root_q} {prune} 2>/dev/null",
        prune = "--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target --exclude-dir=dist",
    );
    let stdout = conn.exec(&cmd).await?;

    let mut hits: Vec<GrepHit> = Vec::new();
    let mut truncated = false;
    let mut files: std::collections::HashSet<String> = std::collections::HashSet::new();
    for raw in stdout.lines() {
        let line = raw.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        // Parse `path:line:text`. The path may itself contain ':' (rare on
        // POSIX) — split on the first two colons only.
        let mut parts = line.splitn(3, ':');
        let path_raw = match parts.next() {
            Some(p) => p,
            None => continue,
        };
        let line_no = match parts.next().and_then(|n| n.trim().parse::<u64>().ok()) {
            Some(n) => n,
            None => continue,
        };
        let text = parts.next().unwrap_or("").to_string();

        let abs = if path_raw.starts_with('/') {
            path_raw.replace('\\', "/")
        } else {
            // rg with `.` prints `./rel`; normalize against root.
            let rel = path_raw.trim_start_matches("./");
            let root_trim = root.trim_end_matches('/');
            format!("{root_trim}/{}", rel.replace('\\', "/"))
        };
        // Cap first: past the limit we stop counting/cloning entirely, so
        // `files_scanned` reflects the streamed prefix we actually kept rather
        // than every line we'd otherwise allocate a `HashSet` entry for.
        if hits.len() >= cap {
            truncated = true;
            break;
        }
        files.insert(abs.clone());
        let rel = remote_rel(&root, &abs);
        hits.push(GrepHit {
            path: abs,
            rel,
            line: line_no,
            text,
        });
    }
    Ok(GrepResponse {
        hits,
        truncated,
        files_scanned: files.len(),
    })
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

    #[test]
    fn single_quote_escapes_embedded_quote() {
        // The classic command-injection guard: a path with a single quote must
        // close, escape, and reopen so it stays one shell argument.
        assert_eq!(sh_single_quote("a'b"), "'a'\\''b'");
        assert_eq!(sh_single_quote("plain"), "'plain'");
        // A path that tries to break out stays fully contained: every embedded
        // quote is escaped as `'\''`, so the metacharacters that follow are
        // literal bytes inside the quoting, not shell syntax. (The result DOES
        // contain the substring "; rm" — that's fine, it is inert text.)
        let evil = "/tmp/x'; rm -rf / #";
        let quoted = sh_single_quote(evil);
        // Exact expected POSIX quoting: the lone `'` becomes `'\''`, everything
        // else is wrapped verbatim. A shell parses this as one argument equal to
        // the original string — the `;`, `rm`, `#` are inert literal bytes.
        assert_eq!(quoted, "'/tmp/x'\\''; rm -rf / #'");
    }

    #[test]
    fn remote_git_command_quotes_root_and_args() {
        let cmd = remote_git_command("/srv/repo with space", &["status", "--short"]);
        assert!(cmd.contains("cd '/srv/repo with space' &&"));
        assert!(cmd.ends_with("git 'status' '--short'"));
    }

    #[test]
    fn remote_git_command_contains_injection_attempt() {
        // A repo path containing shell metacharacters cannot escape the cd arg:
        // the embedded `'` is escaped as `'\''`, so `; rm -rf /;` survives only
        // as inert bytes inside the single-quoted path, never as shell syntax.
        let cmd = remote_git_command("/repo'; rm -rf /; '", &["status"]);
        assert!(cmd.starts_with("cd '/repo'\\''; rm -rf /; '\\''' &&"));
        assert!(cmd.ends_with("git 'status'"));
    }

    #[test]
    fn reject_control_bytes_blocks_nul_and_newline() {
        assert!(reject_control_bytes("/ok/path").is_ok());
        assert!(reject_control_bytes("").is_err());
        assert!(reject_control_bytes("/bad\npath").is_err());
        assert!(reject_control_bytes("/bad\0path").is_err());
        assert!(reject_control_bytes("/bad\x1bpath").is_err());
    }

    #[test]
    fn sha_safety() {
        assert!(sha_is_safe("abc123"));
        assert!(sha_is_safe(&"f".repeat(40)));
        assert!(!sha_is_safe(""));
        assert!(!sha_is_safe("abcg"));
        assert!(!sha_is_safe(";rm -rf /"));
        assert!(!sha_is_safe(&"a".repeat(65)));
    }

    #[test]
    fn shortstat_parsing() {
        assert_eq!(
            parse_remote_shortstat(" 5 files changed, 12 insertions(+), 3 deletions(-)"),
            (5, 12, 3)
        );
        assert_eq!(
            parse_remote_shortstat(" 1 file changed, 1 insertion(+)"),
            (1, 1, 0)
        );
        assert_eq!(parse_remote_shortstat("no stat"), (0, 0, 0));
    }

    #[test]
    fn remote_log_parsing_interleaves_shortstat() {
        let sha = "a".repeat(40);
        let stdout = format!(
            "{sha}\x1fAda\x1fada@x\x1f1700000000\x1f\x1fInitial commit\n \
             2 files changed, 9 insertions(+), 1 deletion(-)\n"
        );
        let entries = parse_remote_log(&stdout, 10);
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.sha, sha);
        assert_eq!(e.author, "Ada");
        assert_eq!(e.subject, "Initial commit");
        assert_eq!(e.files_changed, 2);
        assert_eq!(e.insertions, 9);
        assert_eq!(e.deletions, 1);
    }

    #[test]
    fn remote_log_skips_non_hex_sha_lines() {
        // A subject line that happens to contain the unit separator must not be
        // mistaken for a commit header when its first field isn't a valid sha.
        let stdout = "not-a-sha\x1fx\x1fx\x1f0\x1f\x1fsubject\n";
        assert!(parse_remote_log(stdout, 10).is_empty());
    }

    #[test]
    fn remote_rel_strips_root_prefix() {
        assert_eq!(remote_rel("/srv/app", "/srv/app/src/main.rs"), "src/main.rs");
        assert_eq!(remote_rel("/srv/app/", "/srv/app/x"), "x");
        // A path outside the root is returned unchanged.
        assert_eq!(remote_rel("/srv/app", "/etc/passwd"), "/etc/passwd");
    }

    // Locks the host-key-verification invariant that `check_server_key` is built
    // on across the russh 0.45 -> 0.61 upgrade: the SFTP path refuses any host
    // whose key is NOT recorded in known_hosts (no in-app prompt, fail closed),
    // and accepts a host only on an exact match. This is the MITM guard; a
    // regression here would silently trust unknown/changed server keys.
    #[test]
    fn known_hosts_refuses_unknown_and_accepts_match() {
        use russh::keys::{check_known_hosts_path, PrivateKey};
        use std::io::Write;

        // A real server key (ed25519) and its public half, as russh 0.61 types.
        // `rand::rng()` yields a `ThreadRng: CryptoRng`, the bound `random` wants.
        let server_key = PrivateKey::random(
            &mut rand::rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .expect("generate ed25519 test key");
        let server_pub = server_key.public_key();

        let dir = tempfile::tempdir().expect("tempdir");
        let kh = dir.path().join("known_hosts");

        // Empty known_hosts: an unknown host must be refused (Ok(false)), never
        // trusted by default.
        std::fs::File::create(&kh).expect("create known_hosts");
        assert_eq!(
            check_known_hosts_path("known.example.com", 22, server_pub, &kh).ok(),
            Some(false),
            "unknown host must not be trusted"
        );

        // Record the exact key for the host, then the same host+key must verify.
        let line = format!(
            "known.example.com {}\n",
            server_pub.to_openssh().expect("encode openssh pubkey")
        );
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&kh)
            .expect("append known_hosts");
        f.write_all(line.as_bytes()).expect("write known_hosts");
        assert_eq!(
            check_known_hosts_path("known.example.com", 22, server_pub, &kh).ok(),
            Some(true),
            "recorded host+key must verify"
        );

        // A DIFFERENT host name with that recorded key is still unknown.
        assert_eq!(
            check_known_hosts_path("evil.example.com", 22, server_pub, &kh).ok(),
            Some(false),
            "key recorded for another host must not authorize a new host"
        );
    }
}
