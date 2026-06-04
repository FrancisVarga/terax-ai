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

use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

use crate::modules::sync::MutexExt;
use crate::modules::workspace;

/// Tauri externalBin base name (no triple, no extension) — must match the entry
/// in `tauri.conf.json` `bundle.externalBin`.
const SIDECAR_BASE: &str = "localfs";

/// Subdirectory of the project's launch cwd that holds the object store. Chosen
/// by the user; sits alongside other `.t-camelot/` project state.
const DATA_SUBDIR: &str = ".t-camelot/s3-local";

/// How the server is running. Resolved once in `init`.
enum Backend {
    /// Out-of-process `localfs` sidecar. `child` is held so `kill` reaps it on
    /// shutdown.
    Sidecar {
        child: Arc<shared_child::SharedChild>,
        port: u16,
    },
    /// In-process server (dev fallback). `stop` signals the serve loop to drain.
    InProcess {
        port: u16,
        stop: Mutex<Option<oneshot::Sender<()>>>,
    },
    /// Server failed to start; endpoint unavailable. Carries the reason for
    /// `s3local_status`.
    Off { reason: String },
}

impl Backend {
    fn port(&self) -> Option<u16> {
        match self {
            Backend::Sidecar { port, .. } | Backend::InProcess { port, .. } => Some(*port),
            Backend::Off { .. } => None,
        }
    }
}

/// Managed Tauri state: the resolved backend + the resolved data root + creds.
#[derive(Default)]
pub struct S3LocalState {
    backend: Mutex<Option<Backend>>,
    root: Mutex<Option<PathBuf>>,
    creds: Mutex<Option<Credentials>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Credentials {
    access_key_id: String,
    secret_access_key: String,
}

impl S3LocalState {
    /// Resolve the data root + credentials, then start the server (sidecar if
    /// staged, else in-process). Non-fatal: any failure installs `Backend::Off`
    /// with a reason so `s3local_status` can report it.
    fn init(&self, app: &AppHandle) {
        let root = match resolve_root() {
            Ok(r) => r,
            Err(e) => {
                *self.backend.lock_safe() = Some(Backend::Off {
                    reason: format!("resolve data root: {e}"),
                });
                return;
            }
        };
        let creds = load_or_create_credentials(app).unwrap_or_else(|_| Credentials {
            // A failure to persist still yields a usable in-memory key for this
            // session; external clients just won't find it on disk.
            access_key_id: "localfs".into(),
            secret_access_key: random_secret(),
        });

        *self.root.lock_safe() = Some(root.clone());
        *self.creds.lock_safe() = Some(creds.clone());

        let backend = match find_sidecar(SIDECAR_BASE) {
            Some(exe) => match spawn_sidecar(&exe, &root, &creds) {
                Ok(b) => b,
                Err(e) => {
                    log::warn!(target: "s3local", "sidecar spawn failed ({e}); using in-process server");
                    self.start_in_process(&root, &creds)
                }
            },
            None => {
                log::info!(target: "s3local", "no localfs sidecar staged; using in-process server (dev)");
                self.start_in_process(&root, &creds)
            }
        };
        if let Some(p) = backend.port() {
            log::info!(target: "s3local", "localfs S3 server listening on http://127.0.0.1:{p} (root: {})", root.display());
        }
        *self.backend.lock_safe() = Some(backend);
    }

    /// Run the server in-process on the Tauri runtime. Binds port 0 (ephemeral),
    /// resolves the port synchronously via `block_on`, then spawns the accept
    /// loop. Returns `Backend::Off` if the bind fails.
    fn start_in_process(&self, root: &std::path::Path, creds: &Credentials) -> Backend {
        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let root = root.to_path_buf();
        let ak = creds.access_key_id.clone();
        let sk = creds.secret_access_key.clone();

        let bound = tauri::async_runtime::block_on(async move {
            localfs::bind(&root, addr, ak, sk).await
        });

        match bound {
            Ok((listener, service)) => {
                let port = match listener.local_addr() {
                    Ok(a) => a.port(),
                    Err(e) => return Backend::Off { reason: e.to_string() },
                };
                let (tx, rx) = oneshot::channel::<()>();
                tauri::async_runtime::spawn(async move {
                    localfs::serve(listener, service, async {
                        let _ = rx.await;
                    })
                    .await;
                });
                Backend::InProcess {
                    port,
                    stop: Mutex::new(Some(tx)),
                }
            }
            Err(reason) => Backend::Off { reason },
        }
    }

    /// Stop the server on app shutdown. Kills the sidecar child or signals the
    /// in-process serve loop to drain.
    pub fn shutdown(&self) {
        match self.backend.lock_safe().as_ref() {
            Some(Backend::Sidecar { child, .. }) => {
                let _ = child.kill();
            }
            Some(Backend::InProcess { stop, .. }) => {
                if let Some(tx) = stop.lock_safe().take() {
                    let _ = tx.send(());
                }
            }
            _ => {}
        }
    }

    fn status(&self) -> S3LocalStatus {
        let guard = self.backend.lock_safe();
        let (running, port, reason) = match guard.as_ref() {
            Some(Backend::Sidecar { port, .. }) => (true, Some(*port), None),
            Some(Backend::InProcess { port, .. }) => (true, Some(*port), None),
            Some(Backend::Off { reason }) => (false, None, Some(reason.clone())),
            None => (false, None, Some("not initialized".into())),
        };
        S3LocalStatus {
            running,
            endpoint: port.map(|p| format!("http://127.0.0.1:{p}")),
            root: self.root.lock_safe().as_ref().map(|p| p.display().to_string()),
            access_key_id: self.creds.lock_safe().as_ref().map(|c| c.access_key_id.clone()),
            reason,
        }
    }
}

/// Resolve `<launch-cwd>/.t-camelot/s3-local/`, creating it. Falls back to the
/// process cwd if the launch-cwd snapshot is unavailable.
fn resolve_root() -> Result<PathBuf, String> {
    let base = workspace::launch_cwd_snapshot()
        .or_else(|| std::env::current_dir().ok())
        .ok_or("no launch cwd available")?;
    let root = base.join(DATA_SUBDIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    // Canonicalize so the absolute path we hand the sidecar is stable regardless
    // of its own working directory.
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
) -> Result<Backend, String> {
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

    Ok(Backend::Sidecar { child, port })
}

/// Parse `LOCALFS_PORT=<n>` from a stdout line.
fn parse_port_line(line: &str) -> Option<u16> {
    line.trim().strip_prefix("LOCALFS_PORT=")?.parse().ok()
}

/// Resolve + start the server. Called once from `setup()`.
pub fn start(app: &AppHandle, state: &S3LocalState) {
    state.init(app);
}

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct S3LocalStatus {
    /// Whether the S3 endpoint is currently serving.
    running: bool,
    /// `http://127.0.0.1:<port>` when running.
    endpoint: Option<String>,
    /// Absolute path of the data root on disk.
    root: Option<String>,
    /// The local access key id (the secret is never returned over IPC).
    access_key_id: Option<String>,
    /// Why the server is not running, when `running` is false.
    reason: Option<String>,
}

/// Status of the local S3 server (for the S3 tab header / settings).
#[tauri::command]
pub fn s3local_status(state: State<'_, S3LocalState>) -> S3LocalStatus {
    state.status()
}

/// The endpoint URL, or `None` when not running.
#[tauri::command]
pub fn s3local_endpoint(state: State<'_, S3LocalState>) -> Option<String> {
    state.status().endpoint
}

/// Stable connection id for the seeded local S3 browser connection. Fixed so
/// re-seeding updates the same entry (e.g. when the ephemeral port changes
/// across restarts) instead of piling up duplicates.
const LOCAL_CONN_ID: &str = "localfs-builtin";

/// Seed (or refresh) the local S3 server as a connection in the existing S3
/// browser, so the S3 tab doubles as the file viewer. Path-style, `is_local`,
/// pointing at the current loopback endpoint with the app-managed key. Idempotent
/// by `LOCAL_CONN_ID`. Safe to call every boot — the port may change, so we
/// always re-write the endpoint.
#[tauri::command]
pub async fn s3local_seed_connection(
    app: AppHandle,
    state: State<'_, S3LocalState>,
    s3_state: State<'_, crate::modules::s3::S3State>,
    secrets: State<'_, crate::modules::secrets::SecretsState>,
) -> Result<(), String> {
    let status = state.status();
    let Some(endpoint) = status.endpoint else {
        return Err(status.reason.unwrap_or_else(|| "local S3 server not running".into()));
    };
    let creds = state
        .creds
        .lock_safe()
        .clone()
        .ok_or("local S3 credentials unavailable")?;

    let conn = crate::modules::s3::S3Connection {
        id: LOCAL_CONN_ID.to_string(),
        name: "Local (.t-camelot)".to_string(),
        region: "us-east-1".to_string(),
        endpoint: Some(endpoint),
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

/// Build an `aws-sdk-s3` client pointed at the running local endpoint, path-style,
/// with the app-managed key. Errors if the server is not running.
async fn local_client(state: &S3LocalState) -> Result<aws_sdk_s3::Client, String> {
    use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};

    let status = state.status();
    let endpoint = status
        .endpoint
        .ok_or_else(|| status.reason.unwrap_or_else(|| "local S3 server not running".into()))?;
    let creds = state
        .creds
        .lock_safe()
        .clone()
        .ok_or("local S3 credentials unavailable")?;

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

/// Create a bucket on the local server.
#[tauri::command]
pub async fn s3local_create_bucket(
    state: State<'_, S3LocalState>,
    bucket: String,
) -> Result<(), String> {
    let client = local_client(&state).await?;
    client
        .create_bucket()
        .bucket(&bucket)
        .send()
        .await
        .map_err(|e| aws_err("create bucket", e))?;
    Ok(())
}

/// Delete a bucket on the local server. S3 semantics: the bucket must be empty
/// (a non-empty bucket yields `BucketNotEmpty` / 409, surfaced verbatim).
#[tauri::command]
pub async fn s3local_delete_bucket(
    state: State<'_, S3LocalState>,
    bucket: String,
) -> Result<(), String> {
    let client = local_client(&state).await?;
    client
        .delete_bucket()
        .bucket(&bucket)
        .send()
        .await
        .map_err(|e| aws_err("delete bucket", e))?;
    Ok(())
}

/// Stream a local file into an object on the local server. Reads `src_path` off
/// disk and PUTs it; large files still go through a single PUT here (the s3s_fs
/// server handles arbitrary sizes), which is fine for a loopback transfer.
#[tauri::command]
pub async fn s3local_upload(
    state: State<'_, S3LocalState>,
    bucket: String,
    key: String,
    src_path: String,
) -> Result<(), String> {
    let client = local_client(&state).await?;
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

/// Delete an object on the local server.
#[tauri::command]
pub async fn s3local_delete_object(
    state: State<'_, S3LocalState>,
    bucket: String,
    key: String,
) -> Result<(), String> {
    let client = local_client(&state).await?;
    client
        .delete_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| aws_err("delete object", e))?;
    Ok(())
}
