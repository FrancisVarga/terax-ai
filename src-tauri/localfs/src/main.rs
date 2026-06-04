//! Local-only, 100% S3-compatible object-storage sidecar — a smaller RustFS.
//!
//! Runs out-of-process from the Terax app (spawned by `modules::s3local`):
//!   - serves the full S3 API on loopback against a plain local directory,
//!   - the storage semantics come from the conformance-tested `s3s_fs::FileSystem`
//!     (bucket/object CRUD, ListObjectsV2, multipart, copy, checksums, ranges…),
//!   - `s3s` itself enforces AWS SigV4 on every request via `SimpleAuth`.
//!
//! Everything binds 127.0.0.1 only — loopback is the trust boundary, same as the
//! otel-collector sidecar. The data root is the project's
//! `<project-cwd>/.t-camelot/s3-local/`, passed as an absolute path by the app.
//!
//! CLI:
//!   localfs --root <abs-dir> --port <p> --access-key <ak> --secret-key <sk>
//!
//! `--port 0` binds an ephemeral port; the chosen port is printed to stdout as
//! `LOCALFS_PORT=<n>` on a line by itself so the parent can capture it.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use s3s::auth::SimpleAuth;
use s3s::service::S3ServiceBuilder;
use s3s_fs::FileSystem;

use tokio::net::TcpListener;

use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as ConnBuilder;

/// Parsed CLI args. Hand-rolled to keep the binary dependency-light (no clap),
/// matching the otel-collector sidecar's style.
struct Args {
    root: PathBuf,
    port: u16,
    access_key: String,
    secret_key: String,
}

fn parse_args() -> Result<Args, String> {
    let mut root: Option<PathBuf> = None;
    let mut port: Option<u16> = None;
    let mut access_key: Option<String> = None;
    let mut secret_key: Option<String> = None;

    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--root" => root = Some(PathBuf::from(next_val(&mut it, &flag)?)),
            "--port" => {
                port = Some(
                    next_val(&mut it, &flag)?
                        .parse()
                        .map_err(|e| format!("--port: {e}"))?,
                )
            }
            "--access-key" => access_key = Some(next_val(&mut it, &flag)?),
            "--secret-key" => secret_key = Some(next_val(&mut it, &flag)?),
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    Ok(Args {
        root: root.ok_or("--root is required")?,
        port: port.ok_or("--port is required")?,
        access_key: access_key.ok_or("--access-key is required")?,
        secret_key: secret_key.ok_or("--secret-key is required")?,
    })
}

fn next_val(it: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    it.next().ok_or_else(|| format!("{flag} expects a value"))
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("localfs: {e}");
            std::process::exit(2);
        }
    };

    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("localfs: failed to build runtime: {e}");
            std::process::exit(1);
        }
    };

    if let Err(e) = rt.block_on(run(args)) {
        eprintln!("localfs: {e}");
        std::process::exit(1);
    }
}

async fn run(args: Args) -> Result<(), String> {
    // `FileSystem::new` canonicalizes the root (and resolves it against the
    // process cwd if relative) — we always pass an absolute `--root`, so the
    // sidecar's own working directory is irrelevant. The dir must already exist;
    // the app creates it before spawning us.
    let fs = FileSystem::new(&args.root)
        .map_err(|e| format!("opening data root {}: {e:?}", args.root.display()))?;

    let service = {
        let mut b = S3ServiceBuilder::new(fs);
        // Real AWS SigV4 verification. A request signed with the wrong secret is
        // rejected with 403 SignatureDoesNotMatch by s3s before reaching storage.
        b.set_auth(SimpleAuth::from_single(args.access_key, args.secret_key));
        b.build()
    };

    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, args.port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("binding {addr}: {e}"))?;
    let local_addr = listener.local_addr().map_err(|e| e.to_string())?;

    // Contract with the parent (modules::s3local): emit the resolved port on its
    // own line so `--port 0` ephemeral binding is observable. Must be flushed
    // before we block in the accept loop.
    println!("LOCALFS_PORT={}", local_addr.port());
    use std::io::Write;
    let _ = std::io::stdout().flush();

    let http_server = ConnBuilder::new(TokioExecutor::new());
    let graceful = hyper_util::server::graceful::GracefulShutdown::new();
    let mut ctrl_c = std::pin::pin!(tokio::signal::ctrl_c());

    loop {
        let (socket, _) = tokio::select! {
            res = listener.accept() => match res {
                Ok(conn) => conn,
                Err(err) => {
                    eprintln!("localfs: error accepting connection: {err}");
                    continue;
                }
            },
            _ = ctrl_c.as_mut() => break,
        };

        let conn = http_server.serve_connection(TokioIo::new(socket), service.clone());
        let conn = graceful.watch(conn.into_owned());
        tokio::spawn(async move {
            let _ = conn.await;
        });
    }

    tokio::select! {
        () = graceful.shutdown() => {}
        () = tokio::time::sleep(std::time::Duration::from_secs(10)) => {}
    }

    Ok(())
}
