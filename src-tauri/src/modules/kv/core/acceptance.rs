//! Acceptance tests (#100): drive `serve` with a REAL Redis client (the `redis`
//! crate) over a live loopback socket, proving that a standard client completes
//! the handshake and runs commands - not just that hand-built frames parse.
//!
//! The handshake is the compatibility bar: a client that gets an error frame
//! during connect disconnects before the first user command. `redis::Client`
//! performs that handshake (and, in RESP3 mode, `HELLO 3`), so a passing
//! round-trip here is strong evidence ioredis / redis-py / go-redis will also
//! connect.
//!
//! These run under `cargo test` with no external binaries.

#![cfg(test)]

use std::sync::Arc;
use std::time::Duration;

use redis::AsyncCommands;
use tokio::net::TcpListener;

use super::server::{serve, Broadcaster, ServerCtx};
use super::store::Store;

/// Start an in-process server on an OS-assigned loopback port. Returns the port.
async fn start_server(requirepass: Option<String>) -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let ctx = Arc::new(ServerCtx {
        store: Arc::new(Store::new()),
        broadcaster: Arc::new(Broadcaster::new()),
        requirepass,
    });
    tokio::spawn(async move { serve(listener, ctx).await });
    // Give the accept loop a moment to be ready.
    tokio::time::sleep(Duration::from_millis(50)).await;
    port
}

async fn client(port: u16) -> redis::aio::MultiplexedConnection {
    let url = format!("redis://127.0.0.1:{port}/");
    redis::Client::open(url)
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .expect("client handshake + connect")
}

#[tokio::test]
async fn real_client_set_get() {
    let port = start_server(None).await;
    let mut con = client(port).await;
    let _: () = con.set("k", "v").await.unwrap();
    let got: String = con.get("k").await.unwrap();
    assert_eq!(got, "v");
}

#[tokio::test]
async fn real_client_del_exists() {
    let port = start_server(None).await;
    let mut con = client(port).await;
    let _: () = con.set("k", "v").await.unwrap();
    let exists: bool = con.exists("k").await.unwrap();
    assert!(exists);
    let removed: i64 = con.del("k").await.unwrap();
    assert_eq!(removed, 1);
    let exists: bool = con.exists("k").await.unwrap();
    assert!(!exists);
}

#[tokio::test]
async fn real_client_incr() {
    let port = start_server(None).await;
    let mut con = client(port).await;
    let a: i64 = con.incr("counter", 1).await.unwrap();
    let b: i64 = con.incr("counter", 41).await.unwrap();
    assert_eq!(a, 1);
    assert_eq!(b, 42);
}

#[tokio::test]
async fn real_client_set_ex_ttl() {
    let port = start_server(None).await;
    let mut con = client(port).await;
    let _: () = redis::cmd("SET")
        .arg("k")
        .arg("v")
        .arg("EX")
        .arg(100)
        .query_async(&mut con)
        .await
        .unwrap();
    let ttl: i64 = con.ttl("k").await.unwrap();
    assert!((99..=100).contains(&ttl), "ttl was {ttl}");
}

#[tokio::test]
async fn real_client_scan_keys() {
    let port = start_server(None).await;
    let mut con = client(port).await;
    for i in 0..5 {
        let _: () = con.set(format!("key:{i}"), i).await.unwrap();
    }
    // The `redis` crate's scan() drives the SCAN cursor protocol end to end.
    let mut found = Vec::new();
    let mut iter: redis::AsyncIter<String> = con.scan().await.unwrap();
    while let Some(k) = iter.next_item().await {
        found.push(k);
    }
    assert_eq!(found.len(), 5, "scan returned {found:?}");
}

#[tokio::test]
async fn real_client_pubsub() {
    let port = start_server(None).await;

    // Subscriber on a dedicated connection.
    let sub_client = redis::Client::open(format!("redis://127.0.0.1:{port}/")).unwrap();
    let mut pubsub = sub_client.get_async_pubsub().await.unwrap();
    pubsub.subscribe("news").await.unwrap();

    // Publisher on another connection.
    let mut pub_con = client(port).await;
    // Small delay so the subscription is registered before publish.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let receivers: i64 = redis::cmd("PUBLISH")
        .arg("news")
        .arg("hello")
        .query_async(&mut pub_con)
        .await
        .unwrap();
    assert_eq!(receivers, 1, "publish should reach the one subscriber");

    let mut stream = pubsub.on_message();
    let msg = tokio::time::timeout(Duration::from_secs(2), {
        use futures_util::StreamExt;
        stream.next()
    })
    .await
    .expect("message within timeout")
    .expect("a message");
    let payload: String = msg.get_payload().unwrap();
    assert_eq!(payload, "hello");
    assert_eq!(msg.get_channel_name(), "news");
}

#[tokio::test]
async fn real_client_auth_required() {
    let port = start_server(Some("s3cret".into())).await;
    // Without auth: a data command must fail with NOAUTH.
    let unauth = redis::Client::open(format!("redis://127.0.0.1:{port}/"))
        .unwrap()
        .get_multiplexed_async_connection()
        .await;
    // The handshake itself may succeed (PING allowed); the data command fails.
    if let Ok(mut con) = unauth {
        let res: redis::RedisResult<()> = con.set("k", "v").await;
        assert!(res.is_err(), "unauthenticated SET must be rejected");
    }
    // With the right password in the URL, it works.
    let mut con = redis::Client::open(format!("redis://:s3cret@127.0.0.1:{port}/"))
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .expect("authenticated connect");
    let _: () = con.set("k", "v").await.unwrap();
    let got: String = con.get("k").await.unwrap();
    assert_eq!(got, "v");
}
