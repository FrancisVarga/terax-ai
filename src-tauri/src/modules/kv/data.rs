//! Data CRUD commands for the KV browser UI (issue #107).
//!
//! The webview cannot speak RESP directly (no raw TCP + CSP), so the `kv` tab
//! calls these Tauri commands, which run a real `redis` client against the
//! running server at 127.0.0.1:<port> - the SAME socket external clients use, so
//! the UI is never a separate source of truth and AUTH is honored.
//!
//! A fresh short-lived connection per call keeps this simple and avoids holding
//! a connection across the command boundary; the cost is negligible on loopback
//! for an interactive UI. Pub/sub uses a dedicated streaming connection bridged
//! to a Tauri `Channel` (see `kv_data_subscribe`).

use redis::AsyncCommands;
use serde::Serialize;
use tauri::ipc::Channel;

use super::lifecycle::KvState;

/// Build a connection URL from the current port + optional password.
fn conn_url(state: &KvState) -> String {
    match state.requirepass() {
        Some(pass) => format!("redis://:{pass}@127.0.0.1:{}/", state.port()),
        None => format!("redis://127.0.0.1:{}/", state.port()),
    }
}

async fn connect(state: &KvState) -> Result<redis::aio::MultiplexedConnection, String> {
    redis::Client::open(conn_url(state))
        .map_err(|e| format!("kv client open: {e}"))?
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| format!("kv connect (is the server enabled?): {e}"))
}

#[derive(Serialize)]
pub struct KvKeyInfo {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// Remaining TTL in ms: -1 = no expiry, -2 = missing.
    pub ttl_ms: i64,
}

#[derive(Serialize)]
pub struct KvScanPage {
    pub cursor: u64,
    pub keys: Vec<KvKeyInfo>,
}

/// `SCAN` one page, enriching each key with type + TTL. `match`/`count` are
/// optional. Returns the next cursor (0 = iteration complete).
#[tauri::command]
pub async fn kv_data_scan(
    state: tauri::State<'_, KvState>,
    cursor: u64,
    pattern: Option<String>,
    count: Option<u64>,
) -> Result<KvScanPage, String> {
    let mut con = connect(&state).await?;
    let mut cmd = redis::cmd("SCAN");
    cmd.arg(cursor);
    if let Some(p) = &pattern {
        cmd.arg("MATCH").arg(p);
    }
    cmd.arg("COUNT").arg(count.unwrap_or(100));
    let (next, keys): (u64, Vec<String>) =
        cmd.query_async(&mut con).await.map_err(|e| format!("scan: {e}"))?;

    let mut infos = Vec::with_capacity(keys.len());
    for key in keys {
        let kind: String = redis::cmd("TYPE")
            .arg(&key)
            .query_async(&mut con)
            .await
            .unwrap_or_else(|_| "unknown".into());
        let ttl_ms: i64 = con.pttl(&key).await.unwrap_or(-2);
        infos.push(KvKeyInfo { key, kind, ttl_ms });
    }
    Ok(KvScanPage { cursor: next, keys: infos })
}

#[derive(Serialize)]
pub struct KvValue {
    pub value: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub ttl_ms: i64,
}

/// Read a key's value (string type only in Phase 1), type, and TTL. Returns
/// `None` if the key is missing.
#[tauri::command]
pub async fn kv_data_get(
    state: tauri::State<'_, KvState>,
    key: String,
) -> Result<Option<KvValue>, String> {
    let mut con = connect(&state).await?;
    let kind: String = redis::cmd("TYPE")
        .arg(&key)
        .query_async(&mut con)
        .await
        .map_err(|e| format!("type: {e}"))?;
    if kind == "none" {
        return Ok(None);
    }
    let value: Option<String> = con.get(&key).await.map_err(|e| format!("get: {e}"))?;
    let ttl_ms: i64 = con.pttl(&key).await.unwrap_or(-1);
    Ok(value.map(|value| KvValue { value, kind, ttl_ms }))
}

/// Create or update a string key, with an optional TTL in ms.
#[tauri::command]
pub async fn kv_data_set(
    state: tauri::State<'_, KvState>,
    key: String,
    value: String,
    ttl_ms: Option<u64>,
) -> Result<(), String> {
    let mut con = connect(&state).await?;
    match ttl_ms {
        Some(ms) if ms > 0 => {
            let _: () = redis::cmd("SET")
                .arg(&key)
                .arg(&value)
                .arg("PX")
                .arg(ms)
                .query_async(&mut con)
                .await
                .map_err(|e| format!("set px: {e}"))?;
        }
        _ => {
            let _: () = con.set(&key, &value).await.map_err(|e| format!("set: {e}"))?;
        }
    }
    Ok(())
}

/// Set or clear a key's TTL. `ttl_ms = None` clears it (PERSIST); `Some(ms)`
/// sets PEXPIRE. Returns false if the key does not exist.
#[tauri::command]
pub async fn kv_data_expire(
    state: tauri::State<'_, KvState>,
    key: String,
    ttl_ms: Option<u64>,
) -> Result<bool, String> {
    let mut con = connect(&state).await?;
    let applied: i64 = match ttl_ms {
        Some(ms) if ms > 0 => con.pexpire(&key, ms as i64).await.map_err(|e| format!("pexpire: {e}"))?,
        _ => con.persist(&key).await.map_err(|e| format!("persist: {e}"))?,
    };
    Ok(applied == 1)
}

/// Delete keys; returns how many were removed.
#[tauri::command]
pub async fn kv_data_del(
    state: tauri::State<'_, KvState>,
    keys: Vec<String>,
) -> Result<i64, String> {
    if keys.is_empty() {
        return Ok(0);
    }
    let mut con = connect(&state).await?;
    con.del(keys).await.map_err(|e| format!("del: {e}"))
}

/// Empty the whole database. Destructive; the UI confirms before calling.
#[tauri::command]
pub async fn kv_data_flushdb(state: tauri::State<'_, KvState>) -> Result<(), String> {
    let mut con = connect(&state).await?;
    redis::cmd("FLUSHDB")
        .query_async::<()>(&mut con)
        .await
        .map_err(|e| format!("flushdb: {e}"))
}

#[tauri::command]
pub async fn kv_data_dbsize(state: tauri::State<'_, KvState>) -> Result<i64, String> {
    let mut con = connect(&state).await?;
    redis::cmd("DBSIZE")
        .query_async(&mut con)
        .await
        .map_err(|e| format!("dbsize: {e}"))
}

/// Publish a message; returns the number of receivers.
#[tauri::command]
pub async fn kv_data_publish(
    state: tauri::State<'_, KvState>,
    channel: String,
    message: String,
) -> Result<i64, String> {
    let mut con = connect(&state).await?;
    con.publish(&channel, &message)
        .await
        .map_err(|e| format!("publish: {e}"))
}

/// A pub/sub message streamed to the frontend.
#[derive(Clone, Serialize)]
pub struct KvPubSubEvent {
    pub channel: String,
    pub payload: String,
    /// Wall-clock ms when received, for the UI log.
    pub at_ms: i64,
}

/// Subscribe to channels and stream messages to the frontend via `channel`.
/// Spawns a dedicated subscriber connection (a connection in subscribe mode
/// cannot run normal commands) that lives until the task is aborted (the
/// frontend drops the Channel / closes the tab) or the connection drops.
#[tauri::command]
pub async fn kv_data_subscribe(
    state: tauri::State<'_, KvState>,
    channels: Vec<String>,
    on_event: Channel<KvPubSubEvent>,
) -> Result<(), String> {
    if channels.is_empty() {
        return Err("no channels to subscribe to".into());
    }
    let url = conn_url(&state);
    let client = redis::Client::open(url).map_err(|e| format!("kv client open: {e}"))?;
    let mut pubsub = client
        .get_async_pubsub()
        .await
        .map_err(|e| format!("pubsub connect: {e}"))?;
    for ch in &channels {
        pubsub.subscribe(ch).await.map_err(|e| format!("subscribe {ch}: {e}"))?;
    }

    tauri::async_runtime::spawn(async move {
        use futures_util::StreamExt;
        let mut stream = pubsub.on_message();
        while let Some(msg) = stream.next().await {
            let payload: String = msg.get_payload().unwrap_or_default();
            let ev = KvPubSubEvent {
                channel: msg.get_channel_name().to_string(),
                payload,
                at_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            };
            // If the frontend dropped the channel, stop streaming.
            if on_event.send(ev).is_err() {
                break;
            }
        }
    });
    Ok(())
}
