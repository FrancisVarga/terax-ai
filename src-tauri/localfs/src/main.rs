//! Local-only, 100% S3-compatible object-storage sidecar — a smaller RustFS.
//!
//! Runs out-of-process from the Terax app (spawned by `modules::s3local`):
//!   - serves the full S3 API on loopback against a plain local directory,
//!   - storage semantics from the conformance-tested `s3s_fs::FileSystem`,
//!   - `s3s` enforces AWS SigV4 on every request via `SimpleAuth`.
//!
//! Binds 127.0.0.1 only — loopback is the trust boundary, same as the
//! otel-collector sidecar. The data root is the project's
//! `<project-cwd>/.t-camelot/s3-local/`, passed as an absolute path by the app.
//!
//! CLI:
//!   localfs --root <abs-dir> --port <p> --access-key <ak> --secret-key <sk>
//!
//! `--port 0` binds an ephemeral port; the chosen port is printed to stdout as
//! `LOCALFS_PORT=<n>` on a line by itself so the parent can capture it.
//!
//! The serve loop itself lives in the crate library ([`localfs::serve`]) so the
//! app's in-process dev fallback runs the identical server.

use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;

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
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, args.port));
    let (listener, service) =
        localfs::bind(&args.root, addr, args.access_key, args.secret_key).await?;

    // Contract with the parent (modules::s3local): emit the resolved port on its
    // own line so `--port 0` ephemeral binding is observable. Flushed before we
    // block in the accept loop.
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    println!("LOCALFS_PORT={port}");
    let _ = std::io::stdout().flush();

    // Shut down on ctrl-c (the parent kills us on app exit; this is a fallback).
    localfs::serve(listener, service, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await;

    Ok(())
}
