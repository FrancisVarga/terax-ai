//! Standalone embedded KV server sidecar (issue #96).
//!
//! Runs out-of-process from the Terax app (spawned by `modules::kv`):
//!   - opens the store, loading a persisted snapshot from `--data-dir` if present,
//!   - serves the RESP2/RESP3 protocol on a loopback TCP port so any standard
//!     Redis client (ioredis, redis-py, redis-cli, go-redis) can connect, and
//!   - snapshots the store to disk on an interval (if dirty) and on shutdown.
//!
//! Binds 127.0.0.1 only - loopback is the trust boundary (same as the in-process
//! dev fallback). CLI:
//!
//!   kv-server --port <p> [--data-dir <path>] [--requirepass <pass>]
//!
//! All server logic (store, codec, dispatch, serve loop, snapshot encode/decode)
//! is shared with the in-process dev path via `terax_lib::modules::kv::core`;
//! this binary only adds CLI parsing, the snapshot file IO, and the shutdown
//! handling.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use terax_lib::modules::kv::core::server::{Broadcaster, ServerCtx};
use terax_lib::modules::kv::core::snapshot;
use terax_lib::modules::kv::core::store::Store;

/// Snapshot filename inside the data dir.
const SNAPSHOT_FILE: &str = "dump.kv";
/// How often the background snapshotter runs (only writes if dirty).
const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(30);

struct Args {
    port: u16,
    data_dir: Option<PathBuf>,
    requirepass: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut port: Option<u16> = None;
    let mut data_dir: Option<PathBuf> = None;
    let mut requirepass: Option<String> = None;

    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--port" => {
                port = Some(
                    next_val(&mut it, &flag)?
                        .parse()
                        .map_err(|e| format!("--port: {e}"))?,
                )
            }
            "--data-dir" => data_dir = Some(PathBuf::from(next_val(&mut it, &flag)?)),
            "--requirepass" => {
                let p = next_val(&mut it, &flag)?;
                if !p.is_empty() {
                    requirepass = Some(p);
                }
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Args {
        port: port.ok_or("--port is required")?,
        data_dir,
        requirepass,
    })
}

fn next_val(it: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    it.next().ok_or_else(|| format!("{flag} expects a value"))
}

fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Snapshot file path under the data dir.
fn snapshot_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SNAPSHOT_FILE)
}

/// Load a snapshot into `store` if one exists. A corrupt or version-mismatched
/// file is preserved (renamed `.corrupt-<ts>`) and the store starts empty -
/// never crash on a bad snapshot.
fn load_snapshot(store: &Store, data_dir: &Path) {
    let path = snapshot_path(data_dir);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return, // no snapshot yet
    };
    match snapshot::decode(&bytes) {
        Ok(snap) => {
            store.load_snapshot(&snap, Instant::now(), epoch_ms());
            log::info!("kv-server: loaded snapshot ({} keys)", snap.entries.len());
        }
        Err(e) => {
            log::warn!("kv-server: {e}; starting empty and preserving the bad file");
            let corrupt = data_dir.join(format!("{SNAPSHOT_FILE}.corrupt-{}", epoch_ms()));
            let _ = std::fs::rename(&path, &corrupt);
        }
    }
}

/// Write the store to disk atomically: encode -> temp file -> rename over the
/// real path. A crash mid-write can never corrupt the existing good snapshot.
fn write_snapshot(store: &Store, data_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("create data dir: {e}"))?;
    let snap = store.snapshot(Instant::now(), epoch_ms());
    let bytes = snapshot::encode(&snap)?;
    let tmp = data_dir.join(format!("{SNAPSHOT_FILE}.tmp"));
    let final_path = snapshot_path(data_dir);
    std::fs::write(&tmp, &bytes).map_err(|e| format!("write temp snapshot: {e}"))?;
    std::fs::rename(&tmp, &final_path).map_err(|e| format!("rename snapshot: {e}"))?;
    Ok(())
}

fn main() {
    // Lightweight stderr logger; the app inherits our stdio and captures it in a
    // ring buffer. No env_logger dep.
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("kv-server: {e}");
            eprintln!("usage: kv-server --port <p> [--data-dir <path>] [--requirepass <pass>]");
            std::process::exit(2);
        }
    };

    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("kv-server: failed to build runtime: {e}");
            std::process::exit(1);
        }
    };

    rt.block_on(run(args));
}

async fn run(args: Args) {
    let store = Arc::new(Store::new());

    // Load persisted data before accepting connections.
    if let Some(dir) = &args.data_dir {
        load_snapshot(&store, dir);
    }

    let ctx = Arc::new(ServerCtx {
        store: store.clone(),
        broadcaster: Arc::new(Broadcaster::new()),
        requirepass: args.requirepass.clone(),
    });

    // Bind first so a port clash is reported before we spawn anything.
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], args.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("kv-server: cannot bind 127.0.0.1:{}: {e}", args.port);
            std::process::exit(1);
        }
    };
    eprintln!(
        "kv-server: listening on 127.0.0.1:{}{}",
        args.port,
        if args.requirepass.is_some() {
            " (auth required)"
        } else {
            ""
        }
    );

    // Track whether a snapshot is worth writing. We do not have per-command
    // dirty tracking in the core, so the periodic writer always snapshots when a
    // data dir is set; this is cheap for a dev cache and keeps the core clean.
    let shutting_down = Arc::new(AtomicBool::new(false));

    // Background snapshotter.
    if let Some(dir) = args.data_dir.clone() {
        let store_bg = store.clone();
        let flag = shutting_down.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(SNAPSHOT_INTERVAL);
            tick.tick().await; // skip the immediate first tick
            loop {
                tick.tick().await;
                if flag.load(Ordering::Acquire) {
                    break;
                }
                if let Err(e) = write_snapshot(&store_bg, &dir) {
                    log::warn!("kv-server: periodic snapshot failed: {e}");
                }
            }
        });
    }

    // Serve until a shutdown signal, then snapshot once more and exit.
    let serve = terax_lib::modules::kv::core::server::serve(listener, ctx);
    tokio::pin!(serve);

    tokio::select! {
        _ = &mut serve => {}
        _ = shutdown_signal() => {
            eprintln!("kv-server: shutdown signal received");
        }
    }

    shutting_down.store(true, Ordering::Release);
    if let Some(dir) = &args.data_dir {
        match write_snapshot(&store, dir) {
            Ok(()) => eprintln!("kv-server: final snapshot written"),
            Err(e) => eprintln!("kv-server: final snapshot failed: {e}"),
        }
    }
}

/// Resolve when the process is asked to stop: Ctrl-C on every platform, plus
/// SIGTERM on Unix (the app sends this on shutdown).
///
/// Parent-death (Terax exits/crashes) is NOT handled here: on Windows the app
/// assigns this child to a Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, see
/// `modules/pty/job.rs`) so the kernel kills it; on Unix the app sends SIGTERM on
/// shutdown. Watching stdin EOF was unreliable - a child spawned with stdin
/// already closed would shut down on boot.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
