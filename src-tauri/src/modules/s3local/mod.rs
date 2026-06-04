//! Local-only, 100% S3-compatible object store — the *server* half of the S3
//! feature, complementing `modules::s3` (the read-only S3 *browser/client*).
//!
//! This runs a real S3 endpoint on loopback, backed by the project's
//! `<launch-cwd>/.t-camelot/s3-local/` directory. Any S3 client — the AWS CLI,
//! boto3, `s5cmd`, or the app's own S3 browser — can talk to it with path-style
//! addressing. The app auto-seeds a browser connection pointing at it
//! ([`s3local_seed_connection`]), so the existing S3 tab doubles as the file
//! viewer with no new UI.
//!
//! ## Sidecar vs in-process (mirrors `modules::otel`)
//!
//!   - SIDECAR (packaged): on boot we spawn the `localfs` binary staged next to
//!     the app exe, passing `--root/--port/--access-key/--secret-key`. It binds
//!     an ephemeral port and prints `LOCALFS_PORT=<n>`, which we read back.
//!   - IN-PROCESS (dev fallback): when no `localfs` binary is staged (running
//!     from the source tree), we run the IDENTICAL server in-process via the
//!     `localfs` crate library (`localfs::bind` + `localfs::serve`) on the Tauri
//!     runtime. Keeps the dev loop fast (no second cargo build to iterate on).
//!
//! Either way the endpoint is `http://127.0.0.1:<port>` with the same key, so
//! the browser connection and external clients are unaffected by which mode runs.
//!
//! ## Credentials
//!
//! A single access/secret key pair is generated once and persisted as plain JSON
//! under the app data dir. This is deliberately NOT the OS keyring: the key only
//! authenticates loopback requests to a server holding files the user already
//! owns on the same disk, so keyring-grade protection buys nothing — and a plain
//! file keeps key generation out of the async-keyring path during sync `setup()`.
//! External clients (aws-cli, scripts) read the same persisted key so they keep
//! working across app restarts.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

use crate::modules::sync::MutexExt;

/// Tauri externalBin base name (no triple, no extension) — must match the entry
/// in `tauri.conf.json` `bundle.externalBin`.
const SIDECAR_BASE: &str = "localfs";

/// Subdirectory of the project's launch cwd that holds the object store. Chosen
/// by the user; sits alongside other `.t-camelot/` project state.
const DATA_SUBDIR: &str = ".t-camelot/s3-local";

/// One running localfs server for a single project root.
enum Server {
    /// Out-of-process `localfs` sidecar. `child` is held so `kill` reaps it.
    Sidecar {
        child: Arc<shared_child::SharedChild>,
        port: u16,
    },
    /// In-process server (dev fallback). `stop` signals the serve loop to drain.
    InProcess {
        port: u16,
        stop: Mutex<Option<oneshot::Sender<()>>>,
    },
}

impl Server {
    fn port(&self) -> u16 {
        match self {
            Server::Sidecar { port, .. } | Server::InProcess { port, .. } => *port,
        }
    }
    fn stop(&self) {
        match self {
            Server::Sidecar { child, .. } => {
                let _ = child.kill();
            }
            Server::InProcess { stop, .. } => {
                if let Some(tx) = stop.lock_safe().take() {
                    let _ = tx.send(());
                }
            }
        }
    }
}

/// Managed Tauri state: one localfs server PER project root.
///
/// Terax is multi-window/multi-project; each window's S3 tab calls
/// [`s3local_ensure`] with its own project dir, which lazily spawns (or reuses)
/// a server rooted at `<project>/.t-camelot/s3-local`. Keying by the canonical
/// data root gives true per-project isolation — opening two project windows
/// yields two independent object stores. The one shared bit is the loopback
/// credential (a per-install key; the trust boundary is loopback, not the key).
#[derive(Default)]
pub struct S3LocalState {
    /// canonical data root -> running server.
    servers: Mutex<HashMap<PathBuf, Server>>,
    creds: Mutex<Option<Credentials>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Credentials {
    access_key_id: String,
    secret_access_key: String,
}

/// Result of [`s3local_ensure`]: the running endpoint for a project's S3 server.
#[derive(Serialize)]
pub struct ServerInfo {
    /// `http://127.0.0.1:<port>` for this project's server.
    endpoint: String,
    /// Absolute on-disk data root (`<project>/.t-camelot/s3-local`).
    root: String,
    /// The local access key id (the secret never crosses IPC).
    access_key_id: String,
}

impl S3LocalState {
    /// Lazily ensure a server is running for `project_dir`'s data root, returning
    /// its endpoint. Reuses an existing server for the same root (idempotent), so
    /// repeated calls from the same window are cheap. Spawns the sidecar if staged,
    /// else runs in-process (dev).
    fn ensure(&self, app: &AppHandle, project_dir: &std::path::Path) -> Result<ServerInfo, String> {
        let root = resolve_root(project_dir)?;
        let creds = self.creds(app);

        // Fast path: already running for this root.
        if let Some(srv) = self.servers.lock_safe().get(&root) {
            return Ok(ServerInfo {
                endpoint: format!("http://127.0.0.1:{}", srv.port()),
                root: root.display().to_string(),
                access_key_id: creds.access_key_id.clone(),
            });
        }

        let server = match find_sidecar(SIDECAR_BASE) {
            Some(exe) => spawn_sidecar(&exe, &root, &creds).or_else(|e| {
                log::warn!(target: "s3local", "sidecar spawn failed ({e}); using in-process server");
                start_in_process(&root, &creds)
            })?,
            None => {
                log::info!(target: "s3local", "no localfs sidecar staged; using in-process server (dev)");
                start_in_process(&root, &creds)?
            }
        };
        let port = server.port();
        log::info!(target: "s3local", "localfs S3 server listening on http://127.0.0.1:{port} (root: {})", root.display());

        // Insert; if another caller raced us to the same root, keep the first and
        // stop ours (avoids two servers on the same dir).
        let mut guard = self.servers.lock_safe();
        if let Some(existing) = guard.get(&root) {
            let info = ServerInfo {
                endpoint: format!("http://127.0.0.1:{}", existing.port()),
                root: root.display().to_string(),
                access_key_id: creds.access_key_id.clone(),
            };
            drop(guard);
            server.stop();
            return Ok(info);
        }
        guard.insert(root.clone(), server);
        Ok(ServerInfo {
            endpoint: format!("http://127.0.0.1:{port}"),
            root: root.display().to_string(),
            access_key_id: creds.access_key_id,
        })
    }

    /// The shared per-install loopback credential, loaded+persisted on first use.
    fn creds(&self, app: &AppHandle) -> Credentials {
        let mut guard = self.creds.lock_safe();
        guard
            .get_or_insert_with(|| {
                load_or_create_credentials(app).unwrap_or_else(|_| Credentials {
                    access_key_id: "localfs".into(),
                    secret_access_key: random_secret(),
                })
            })
            .clone()
    }

    /// Stop every running server on app shutdown.
    pub fn shutdown(&self) {
        for (_, srv) in self.servers.lock_safe().drain() {
            srv.stop();
        }
    }

    /// Endpoint + creds for an already-running server at `project_dir`'s root, or
    /// an error if none is running yet (the frontend must call `ensure` first).
    fn lookup(&self, project_dir: &std::path::Path) -> Result<(String, Credentials), String> {
        let root = resolve_root(project_dir)?;
        let guard = self.servers.lock_safe();
        let srv = guard
            .get(&root)
            .ok_or_else(|| format!("no local S3 server running for {}", root.display()))?;
        let endpoint = format!("http://127.0.0.1:{}", srv.port());
        drop(guard);
        let creds = self
            .creds
            .lock_safe()
            .clone()
            .ok_or("local S3 credentials unavailable")?;
        Ok((endpoint, creds))
    }
}

/// Run a server in-process on the Tauri runtime (dev fallback). Binds port 0,
/// resolves the port via `block_on`, spawns the accept loop.
fn start_in_process(root: &std::path::Path, creds: &Credentials) -> Result<Server, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let root = root.to_path_buf();
    let ak = creds.access_key_id.clone();
    let sk = creds.secret_access_key.clone();

    let (listener, service) =
        tauri::async_runtime::block_on(async move { localfs::bind(&root, addr, ak, sk).await })?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (tx, rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        localfs::serve(listener, service, async {
            let _ = rx.await;
        })
        .await;
    });
    Ok(Server::InProcess {
        port,
        stop: Mutex::new(Some(tx)),
    })
}

/// Resolve `<project_dir>/.t-camelot/s3-local/`, creating it. `project_dir` is
/// the window's project root (the dir the file explorer shows). Canonicalized so
/// the path handed to the sidecar — and used as the server-map key — is stable.
fn resolve_root(project_dir: &std::path::Path) -> Result<PathBuf, String> {
    if !project_dir.is_dir() {
        return Err(format!("project dir not found: {}", project_dir.display()));
    }
    let root = project_dir.join(DATA_SUBDIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    std::fs::canonicalize(&root).map_err(|e| format!("canonicalize {}: {e}", root.display()))
}

/// Path of the persisted local credentials JSON under the app data dir.
fn creds_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("s3local_credentials.json"))
}

/// Load the persisted local key, or generate + persist one on first run.
fn load_or_create_credentials(app: &AppHandle) -> Result<Credentials, String> {
    let path = creds_path(app)?;
    if path.exists() {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        if let Ok(c) = serde_json::from_slice::<Credentials>(&bytes) {
            return Ok(c);
        }
    }
    let creds = Credentials {
        access_key_id: "localfs".into(),
        secret_access_key: random_secret(),
    };
    let bytes = serde_json::to_vec(&creds).map_err(|e| e.to_string())?;
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(creds)
}

/// Generate a 40-char alphanumeric secret (AWS secret-key shape). Uses the
/// process+time entropy already available without adding a rand dep: a UUID v4
/// pair gives 256 bits, hex-encoded and trimmed.
fn random_secret() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("{a}{b}")[..40].to_string()
}

/// Locate the `localfs` sidecar next to the app binary (Tauri strips the triple
/// suffix at install). `None` in dev -> in-process fallback.
fn find_sidecar(base: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    };
    let candidate = dir.join(name);
    candidate.is_file().then_some(candidate)
}

/// Spawn the sidecar on an ephemeral port and read back `LOCALFS_PORT=<n>` from
/// its stdout. Blocks briefly on the first line of stdout — the binary prints
/// the port immediately after binding, before entering the accept loop.
fn spawn_sidecar(
    exe: &std::path::Path,
    root: &std::path::Path,
    creds: &Credentials,
) -> Result<Server, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--root")
        .arg(root)
        .arg("--port")
        .arg("0")
        .arg("--access-key")
        .arg(&creds.access_key_id)
        .arg("--secret-key")
        .arg(&creds.secret_access_key);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let child = shared_child::SharedChild::spawn(&mut cmd)
        .map_err(|e| format!("spawn {}: {e}", exe.display()))?;
    let child = Arc::new(child);

    // Read the port line from the child's stdout. `take_stdout` hands us the
    // pipe; the first line is `LOCALFS_PORT=<n>`.
    let stdout = child
        .take_stdout()
        .ok_or("sidecar stdout was not piped")?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("reading sidecar port: {e}"))?;
    let port = parse_port_line(&line)
        .ok_or_else(|| format!("sidecar did not report a port (got: {line:?})"))?;

    // Drain the rest of stdout in the background so the pipe never blocks the
    // child (it may log diagnostics after the port line).
    std::thread::spawn(move || {
        let mut sink = String::new();
        while reader.read_line(&mut sink).map(|n| n > 0).unwrap_or(false) {
            sink.clear();
        }
    });

    Ok(Server::Sidecar { child, port })
}

/// Parse `LOCALFS_PORT=<n>` from a stdout line.
fn parse_port_line(line: &str) -> Option<u16> {
    line.trim().strip_prefix("LOCALFS_PORT=")?.parse().ok()
}

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

/// Ensure a localfs server is running for `projectDir`'s `.t-camelot/s3-local`
/// data root and return its endpoint. The frontend calls this with its window's
/// project root (the file-explorer root) so each project gets its own server +
/// store. Idempotent per root.
#[tauri::command]
pub fn s3local_ensure(
    app: AppHandle,
    state: State<'_, S3LocalState>,
    project_dir: String,
) -> Result<ServerInfo, String> {
    state.ensure(&app, std::path::Path::new(&project_dir))
}

/// Stable-per-root connection id for the seeded local S3 browser connection. The
/// canonical data root is hashed into the id so each project gets its own
/// connection entry (re-seeding the same project updates in place).
fn local_conn_id(root: &str) -> String {
    // Cheap stable hash of the root path (FNV-1a) -> hex; avoids a hashing dep.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in root.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("localfs-{h:016x}")
}

/// A short display label for the project a local store belongs to — the project
/// dir's last path segment (e.g. "w88_data"), so multiple local connections are
/// distinguishable in the browser.
fn project_label(root: &str) -> String {
    // root is `<project>/.t-camelot/s3-local` (canonical). Walk up two segments.
    let p = std::path::Path::new(root);
    let project = p.parent().and_then(|p| p.parent());
    project
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .map(|s| format!("Local · {s}"))
        .unwrap_or_else(|| "Local (.t-camelot)".to_string())
}

/// Ensure the server for `projectDir` is up, then seed (or refresh) a browser
/// connection pointing at it. Each project root gets its own `is_local`
/// connection so the S3 tab shows the store for the active project.
#[tauri::command]
pub async fn s3local_seed_connection(
    app: AppHandle,
    state: State<'_, S3LocalState>,
    s3_state: State<'_, crate::modules::s3::S3State>,
    secrets: State<'_, crate::modules::secrets::SecretsState>,
    project_dir: String,
) -> Result<(), String> {
    let info = state.ensure(&app, std::path::Path::new(&project_dir))?;
    let creds = state.creds(&app);

    let conn = crate::modules::s3::S3Connection {
        id: local_conn_id(&info.root),
        name: project_label(&info.root),
        region: "us-east-1".to_string(),
        endpoint: Some(info.endpoint),
        force_path_style: true,
        bucket: None,
        is_local: true,
    };

    crate::modules::s3::upsert_connection(
        &app,
        &s3_state,
        &secrets,
        conn,
        creds.access_key_id,
        creds.secret_access_key,
    )
    .await
}

// ---------------------------------------------------------------------------
// Mutation commands (local server only)
//
// These route through the running S3 endpoint via aws-sdk-s3 (signed loopback
// HTTP), NOT directly to disk: the s3s_fs `FileSystem` impl stays the single
// source of truth for on-disk layout, etag, and metadata, so the app can never
// drift from what the server serves. The browser gates these to the `is_local`
// connection, but they additionally only ever talk to the local endpoint.
// ---------------------------------------------------------------------------

/// Build an `aws-sdk-s3` client pointed at `project_dir`'s running local server,
/// path-style, with the app-managed key. Errors if no server is running for that
/// project (the frontend must `s3local_ensure`/`s3local_seed_connection` first).
fn local_client(
    state: &S3LocalState,
    project_dir: &str,
) -> Result<aws_sdk_s3::Client, String> {
    use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};

    let (endpoint, creds) = state.lookup(std::path::Path::new(project_dir))?;

    let provider = Credentials::new(
        creds.access_key_id,
        creds.secret_access_key,
        None,
        None,
        "terax-localfs",
    );
    let conf = aws_sdk_s3::config::Builder::new()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("us-east-1"))
        .endpoint_url(endpoint)
        .force_path_style(true)
        .credentials_provider(provider)
        .build();
    Ok(aws_sdk_s3::Client::from_conf(conf))
}

fn aws_err<E: std::error::Error>(ctx: &str, e: E) -> String {
    use aws_smithy_types::error::display::DisplayErrorContext;
    format!("{ctx}: {}", DisplayErrorContext(&e))
}

/// Create a bucket on `projectDir`'s local server.
#[tauri::command]
pub async fn s3local_create_bucket(
    state: State<'_, S3LocalState>,
    project_dir: String,
    bucket: String,
) -> Result<(), String> {
    let client = local_client(&state, &project_dir)?;
    client
        .create_bucket()
        .bucket(&bucket)
        .send()
        .await
        .map_err(|e| aws_err("create bucket", e))?;
    Ok(())
}

/// Delete a bucket on `projectDir`'s local server. S3 semantics: the bucket must
/// be empty (a non-empty bucket yields `BucketNotEmpty` / 409, surfaced verbatim).
#[tauri::command]
pub async fn s3local_delete_bucket(
    state: State<'_, S3LocalState>,
    project_dir: String,
    bucket: String,
) -> Result<(), String> {
    let client = local_client(&state, &project_dir)?;
    client
        .delete_bucket()
        .bucket(&bucket)
        .send()
        .await
        .map_err(|e| aws_err("delete bucket", e))?;
    Ok(())
}

/// Stream a local file into an object on `projectDir`'s local server.
#[tauri::command]
pub async fn s3local_upload(
    state: State<'_, S3LocalState>,
    project_dir: String,
    bucket: String,
    key: String,
    src_path: String,
) -> Result<(), String> {
    let client = local_client(&state, &project_dir)?;
    let body = aws_sdk_s3::primitives::ByteStream::from_path(std::path::Path::new(&src_path))
        .await
        .map_err(|e| format!("reading {src_path}: {e}"))?;
    client
        .put_object()
        .bucket(&bucket)
        .key(&key)
        .body(body)
        .send()
        .await
        .map_err(|e| aws_err("upload object", e))?;
    Ok(())
}

/// Delete an object on `projectDir`'s local server.
#[tauri::command]
pub async fn s3local_delete_object(
    state: State<'_, S3LocalState>,
    project_dir: String,
    bucket: String,
    key: String,
) -> Result<(), String> {
    let client = local_client(&state, &project_dir)?;
    client
        .delete_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| aws_err("delete object", e))?;
    Ok(())
}
