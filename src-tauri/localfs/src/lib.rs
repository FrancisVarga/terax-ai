//! Local-only, 100% S3-compatible object-storage server — a smaller RustFS.
//!
//! The storage semantics come from the conformance-tested `s3s_fs::FileSystem`
//! (bucket/object CRUD, ListObjectsV2, multipart, copy, checksums, ranges…);
//! `s3s` enforces AWS SigV4 via `SimpleAuth`. This crate adds only the hyper
//! serve loop, exposed both as:
//!   - the `localfs` binary (`main.rs`), spawned as a Tauri sidecar in packaged
//!     builds, and
//!   - this library's [`serve`], called in-process by the app's `modules::s3local`
//!     dev fallback when no sidecar binary is staged.
//!
//! Both paths run the IDENTICAL server, so behavior cannot drift between them.

use std::net::SocketAddr;
use std::path::Path;

use s3s::auth::SimpleAuth;
use s3s::service::S3ServiceBuilder;
use s3s_fs::FileSystem;

use tokio::net::TcpListener;

use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as ConnBuilder;

/// Build the SigV4-authed S3 service over a filesystem root and bind a loopback
/// `TcpListener`. Returns the listener (so the caller can read the resolved port
/// for `--port 0` ephemeral binding) plus the built service.
///
/// `root` must already exist; the app creates `<cwd>/.t-camelot/s3-local/` before
/// spawning. `FileSystem::new` canonicalizes it, so an absolute path makes the
/// server independent of its own working directory.
pub async fn bind(
    root: &Path,
    addr: SocketAddr,
    access_key: String,
    secret_key: String,
) -> Result<(TcpListener, S3Service), String> {
    let fs = FileSystem::new(root)
        .map_err(|e| format!("opening data root {}: {e:?}", root.display()))?;

    let mut b = S3ServiceBuilder::new(fs);
    // Real AWS SigV4 verification — a wrong-secret request is rejected with 403
    // SignatureDoesNotMatch by s3s before reaching storage.
    b.set_auth(SimpleAuth::from_single(access_key, secret_key));
    let service = b.build();

    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("binding {addr}: {e}"))?;
    Ok((listener, service))
}

/// The built s3s service type, re-exported so callers can hold it across the
/// accept loop without naming the long s3s path.
pub type S3Service = s3s::service::S3Service;

/// Run the accept loop on an already-bound listener until `shutdown` resolves.
/// Each connection is served on the current tokio runtime. `shutdown` is any
/// future (e.g. a cancellation token or ctrl-c) — when it completes, the loop
/// stops accepting and drains in-flight connections (10s cap).
pub async fn serve<F>(listener: TcpListener, service: S3Service, shutdown: F)
where
    F: std::future::Future<Output = ()> + Send,
{
    let http_server = ConnBuilder::new(TokioExecutor::new());
    let graceful = hyper_util::server::graceful::GracefulShutdown::new();
    let mut shutdown = std::pin::pin!(shutdown);

    loop {
        let (socket, _) = tokio::select! {
            res = listener.accept() => match res {
                Ok(conn) => conn,
                Err(err) => {
                    eprintln!("localfs: error accepting connection: {err}");
                    continue;
                }
            },
            () = shutdown.as_mut() => break,
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
}
