//! The TCP serving loop and a `tokio::broadcast`-backed pub/sub registry.
//!
//! Shared verbatim by the `kv-server` sidecar `main` (#96) and the in-process
//! dev fallback (#97), so there is exactly one serving implementation and the
//! two transports can never drift. The pure command logic lives in `dispatch`;
//! this module is the imperative shell around it: accept connections, frame
//! bytes, drive `dispatch`, and interleave pub/sub pushes.
//!
//! Pub/sub: each channel gets a `broadcast::Sender<Message>`. `PUBLISH` sends on
//! the channel's sender; the receiver count is the number of subscribers, which
//! is what `PUBLISH` returns. Pattern subscribers register their glob and are
//! matched against the channel on publish. A subscribed connection runs a
//! `select!` over its socket reads and its broadcast receivers so it can both
//! answer commands and forward pushed messages on the same socket.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::{Bytes, BytesMut};
use dashmap::DashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

use super::conn::Conn;
use super::dispatch::{dispatch, Clock};
use super::pubsub::PubSub;
use super::resp::{encode_reply, parse_command, Proto, Reply};
use super::store::Store;

/// A delivered pub/sub message: the concrete channel it was published on and the
/// payload. Pattern subscribers need the channel name to build a `pmessage`.
#[derive(Clone)]
pub struct Message {
    pub channel: String,
    pub payload: Bytes,
}

/// Broadcast-backed pub/sub shared across all connections of one server.
#[derive(Default)]
pub struct Broadcaster {
    /// channel -> sender. A channel entry exists while it has live senders or
    /// recent subscribers; empty senders are pruned lazily on publish.
    channels: DashMap<String, broadcast::Sender<Message>>,
    /// Active pattern subscriptions: pattern -> subscriber count. Used for
    /// `PUBSUB NUMPAT` and to decide whether a publish must scan patterns.
    patterns: DashMap<String, usize>,
}

impl Broadcaster {
    pub fn new() -> Self {
        Broadcaster::default()
    }

    /// Subscribe to an exact channel, returning a receiver. Creates the channel
    /// sender on first subscribe.
    fn subscribe(&self, channel: &str) -> broadcast::Receiver<Message> {
        let entry = self
            .channels
            .entry(channel.to_string())
            .or_insert_with(|| broadcast::channel(256).0);
        entry.subscribe()
    }

    fn register_pattern(&self, pattern: &str) {
        *self.patterns.entry(pattern.to_string()).or_insert(0) += 1;
    }

    fn unregister_pattern(&self, pattern: &str) {
        if let Some(mut n) = self.patterns.get_mut(pattern) {
            *n = n.saturating_sub(1);
        }
        self.patterns.remove_if(pattern, |_, v| *v == 0);
    }
}

impl PubSub for Broadcaster {
    fn publish(&self, channel: &str, payload: Bytes) -> i64 {
        let msg = Message {
            channel: channel.to_string(),
            payload,
        };
        let mut delivered = 0i64;
        // Exact-channel subscribers.
        if let Some(sender) = self.channels.get(channel) {
            // `send` returns the number of receivers it was delivered to.
            if let Ok(n) = sender.send(msg.clone()) {
                delivered += n as i64;
            }
        }
        // Pattern subscribers: deliver via each matching pattern's channel
        // sender. Patterns are stored as their own broadcast channels keyed by
        // the pattern string (a subscriber to pattern P listens on channel "P").
        for kv in self.patterns.iter() {
            let pattern = kv.key();
            if super::dispatch::glob_match(pattern.as_bytes(), channel.as_bytes()) {
                if let Some(sender) = self.channels.get(pattern) {
                    if let Ok(n) = sender.send(msg.clone()) {
                        delivered += n as i64;
                    }
                }
            }
        }
        delivered
    }

    fn active_channels(&self, pattern: Option<&str>) -> Vec<String> {
        self.channels
            .iter()
            .filter(|e| e.value().receiver_count() > 0)
            .map(|e| e.key().clone())
            .filter(|c| {
                pattern.map_or(true, |p| super::dispatch::glob_match(p.as_bytes(), c.as_bytes()))
            })
            .collect()
    }

    fn channel_subscribers(&self, channel: &str) -> i64 {
        self.channels
            .get(channel)
            .map(|s| s.receiver_count() as i64)
            .unwrap_or(0)
    }

    fn pattern_count(&self) -> i64 {
        self.patterns.len() as i64
    }
}

/// Everything a connection task needs: the shared store, the broadcaster, and
/// the optional required password (None = no auth).
pub struct ServerCtx {
    pub store: Arc<Store>,
    pub broadcaster: Arc<Broadcaster>,
    pub requirepass: Option<String>,
}

impl ServerCtx {
    pub fn new(store: Arc<Store>, requirepass: Option<String>) -> Arc<Self> {
        Arc::new(ServerCtx {
            store,
            broadcaster: Arc::new(Broadcaster::new()),
            requirepass,
        })
    }
}

/// Build the `Clock` for one command from the current wall + monotonic time.
fn clock_now() -> Clock {
    Clock {
        now: Instant::now(),
        epoch_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    }
}

/// Run the active-expiry sweep on a timer until the process exits. Spawned once
/// per server. A 1s cadence matches Redis's background cycle granularity well
/// enough for a dev cache.
pub fn spawn_sweeper(store: Arc<Store>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            store.sweep(Instant::now());
        }
    });
}

/// Accept connections on `addr` forever. `addr` MUST be loopback; callers bind
/// 127.0.0.1 only. Returns the bound `TcpListener`'s local addr via the caller
/// (we accept an already-bound listener so the caller can report the real port
/// when binding port 0 in tests).
pub async fn serve(listener: TcpListener, ctx: Arc<ServerCtx>) {
    spawn_sweeper(ctx.store.clone());
    loop {
        match listener.accept().await {
            Ok((stream, _peer)) => {
                let ctx = ctx.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_conn(stream, ctx).await {
                        log::debug!("kv connection ended: {e}");
                    }
                });
            }
            Err(e) => {
                log::warn!("kv accept error: {e}");
                // Brief backoff so a transient accept error does not spin.
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

/// Bind a loopback listener on `port` (0 = OS-assigned) and serve. Convenience
/// for the sidecar `main` and dev fallback. Returns the bound address so the
/// caller can log/report the real port.
pub async fn bind_and_serve(port: u16, ctx: Arc<ServerCtx>) -> std::io::Result<()> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = TcpListener::bind(addr).await?;
    serve(listener, ctx).await;
    Ok(())
}

/// One connection's lifetime: frame bytes, dispatch, interleave pub/sub pushes.
async fn handle_conn(mut stream: TcpStream, ctx: Arc<ServerCtx>) -> std::io::Result<()> {
    let _ = stream.set_nodelay(true);
    let mut conn = Conn::new();
    // If no password is configured, the connection is authenticated from the
    // start; otherwise it must AUTH (or HELLO ... AUTH) before data commands.
    conn.authenticated = ctx.requirepass.is_none();

    let mut read_buf = BytesMut::with_capacity(16 * 1024);
    // Active broadcast receivers for this connection's subscriptions, keyed by
    // the channel/pattern string so unsubscribe can drop the right one.
    let mut receivers: HashMap<String, broadcast::Receiver<Message>> = HashMap::new();

    let mut tmp = [0u8; 16 * 1024];
    loop {
        // Build a future set: socket read + every subscription receiver. We use
        // a manual select via tokio::select! with a futures-unordered-like
        // approach kept simple: poll the socket and each receiver in a biased
        // loop is awkward, so we select between "read socket" and "any receiver
        // has a message" using a helper.
        tokio::select! {
            // Inbound bytes -> parse + dispatch (possibly many pipelined cmds).
            read = stream.read(&mut tmp) => {
                let n = read?;
                if n == 0 {
                    return Ok(()); // peer closed
                }
                read_buf.extend_from_slice(&tmp[..n]);
                if drain_commands(&mut stream, &mut conn, &ctx, &mut read_buf, &mut receivers).await? {
                    return Ok(()); // QUIT
                }
            }
            // A pushed pub/sub message on any subscription.
            msg = recv_any(&mut receivers), if !receivers.is_empty() => {
                if let Some((sub_key, message)) = msg {
                    write_push_message(&mut stream, &conn, &sub_key, &message).await?;
                }
            }
        }
    }
}

/// Parse and dispatch every complete command currently in `buf`. Applies
/// subscription side effects (registering/dropping broadcast receivers) by
/// diffing `conn` before/after each command. Returns Ok(true) on QUIT.
async fn drain_commands(
    stream: &mut TcpStream,
    conn: &mut Conn,
    ctx: &Arc<ServerCtx>,
    buf: &mut BytesMut,
    receivers: &mut HashMap<String, broadcast::Receiver<Message>>,
) -> std::io::Result<bool> {
    loop {
        let args = match parse_command(buf) {
            Ok(Some(args)) => args,
            Ok(None) => return Ok(false), // need more bytes
            Err(msg) => {
                let reply = Reply::Error(msg);
                let bytes = encode_reply(&reply, conn.proto);
                stream.write_all(&bytes).await?;
                // Framing is unrecoverable; close.
                return Ok(true);
            }
        };
        if args.is_empty() {
            continue; // empty inline line: ignore
        }

        // Auth gate: when a password is required, only allow AUTH/HELLO/QUIT/PING
        // until authenticated.
        if !conn.authenticated {
            let name = String::from_utf8_lossy(&args[0]).to_ascii_uppercase();
            let allowed = matches!(name.as_str(), "AUTH" | "HELLO" | "QUIT" | "PING" | "RESET");
            if !allowed {
                let reply = Reply::Error("NOAUTH Authentication required.".into());
                stream.write_all(&encode_reply(&reply, conn.proto)).await?;
                continue;
            }
            // Verify AUTH password against the configured one.
            if name == "AUTH" {
                if !verify_auth(ctx, &args) {
                    let reply = Reply::Error("WRONGPASS invalid username-password pair or user is disabled.".into());
                    stream.write_all(&encode_reply(&reply, conn.proto)).await?;
                    continue;
                }
            }
        }

        let before_channels = conn.channels.clone();
        let before_patterns = conn.patterns.clone();

        let out = dispatch(&ctx.store, conn, ctx.broadcaster.as_ref(), clock_now(), &args);

        // Apply subscription diffs to broadcast receivers.
        sync_subscriptions(ctx, conn, &before_channels, &before_patterns, receivers);

        // Write the reply. SUBSCRIBE/UNSUBSCRIBE return an Array of Push frames;
        // each element must be written as its own frame, not wrapped in an outer
        // array. Detect that shape and unwrap.
        write_reply(stream, conn.proto, &out.reply).await?;

        if out.close {
            return Ok(true);
        }
        if buf.is_empty() {
            return Ok(false);
        }
    }
}

/// Reconcile the connection's subscription sets against the broadcaster: open a
/// receiver for each newly-added channel/pattern, drop receivers for removed
/// ones, and keep the pattern registry counts in sync.
fn sync_subscriptions(
    ctx: &Arc<ServerCtx>,
    conn: &Conn,
    before_channels: &std::collections::HashSet<String>,
    before_patterns: &std::collections::HashSet<String>,
    receivers: &mut HashMap<String, broadcast::Receiver<Message>>,
) {
    // Newly subscribed channels.
    for ch in conn.channels.difference(before_channels) {
        receivers
            .entry(ch.clone())
            .or_insert_with(|| ctx.broadcaster.subscribe(ch));
    }
    // Unsubscribed channels.
    for ch in before_channels.difference(&conn.channels) {
        receivers.remove(ch);
    }
    // Newly subscribed patterns: a pattern listens on a broadcast channel keyed
    // by the pattern string; publish fan-out sends matching messages there.
    for pat in conn.patterns.difference(before_patterns) {
        ctx.broadcaster.register_pattern(pat);
        receivers
            .entry(pat.clone())
            .or_insert_with(|| ctx.broadcaster.subscribe(pat));
    }
    for pat in before_patterns.difference(&conn.patterns) {
        ctx.broadcaster.unregister_pattern(pat);
        receivers.remove(pat);
    }
}

/// Verify an `AUTH` command against the configured password. Accepts both
/// `AUTH <pass>` and `AUTH <user> <pass>` (user ignored; we are password-only).
fn verify_auth(ctx: &Arc<ServerCtx>, args: &[Bytes]) -> bool {
    let Some(required) = ctx.requirepass.as_deref() else {
        return true;
    };
    let pass = match args.len() {
        2 => String::from_utf8_lossy(&args[1]).into_owned(),
        3 => String::from_utf8_lossy(&args[2]).into_owned(),
        _ => return false,
    };
    pass == required
}

/// Write a reply, unwrapping the SUBSCRIBE/UNSUBSCRIBE "array of push frames"
/// shape so each confirmation is its own top-level frame (what clients expect).
async fn write_reply(stream: &mut TcpStream, proto: Proto, reply: &Reply) -> std::io::Result<()> {
    if let Reply::Array(items) = reply {
        if items.iter().all(|r| matches!(r, Reply::Push(_))) && !items.is_empty() {
            for item in items {
                stream.write_all(&encode_reply(item, proto)).await?;
            }
            return Ok(());
        }
    }
    stream.write_all(&encode_reply(reply, proto)).await
}

/// Encode and write a pushed pub/sub message in the connection's dialect. For an
/// exact-channel subscription the frame is `message`; for a pattern it is
/// `pmessage` with the pattern included.
async fn write_push_message(
    stream: &mut TcpStream,
    conn: &Conn,
    sub_key: &str,
    message: &Message,
) -> std::io::Result<()> {
    let is_pattern = conn.patterns.contains(sub_key);
    let push = if is_pattern {
        Reply::Push(vec![
            Reply::bulk_str("pmessage"),
            Reply::bulk_str(sub_key.to_string()),
            Reply::bulk_str(message.channel.clone()),
            Reply::Bulk(message.payload.clone()),
        ])
    } else {
        Reply::Push(vec![
            Reply::bulk_str("message"),
            Reply::bulk_str(message.channel.clone()),
            Reply::Bulk(message.payload.clone()),
        ])
    };
    stream.write_all(&encode_reply(&push, conn.proto)).await
}

/// Await the next message from ANY subscription receiver. Returns the
/// (subscription-key, message). Lagged receivers skip dropped messages. A
/// closed receiver is ignored (its channel had all senders dropped).
async fn recv_any(
    receivers: &mut HashMap<String, broadcast::Receiver<Message>>,
) -> Option<(String, Message)> {
    if receivers.is_empty() {
        // The select! guard prevents calling this when empty, but guard anyway.
        std::future::pending::<()>().await;
        return None;
    }
    // Poll all receivers concurrently; return the first ready one.
    let futures = receivers.iter_mut().map(|(k, rx)| {
        let key = k.clone();
        Box::pin(async move {
            loop {
                match rx.recv().await {
                    Ok(msg) => return Some((key.clone(), msg)),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        })
    });
    futures_util::future::select_all(futures).await.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_to_no_subscribers_is_zero() {
        let b = Broadcaster::new();
        assert_eq!(b.publish("ch", Bytes::from_static(b"hi")), 0);
    }

    #[tokio::test]
    async fn subscriber_receives_published_message() {
        let b = Arc::new(Broadcaster::new());
        let mut rx = b.subscribe("ch");
        assert_eq!(b.publish("ch", Bytes::from_static(b"hi")), 1);
        let msg = rx.recv().await.unwrap();
        assert_eq!(msg.channel, "ch");
        assert_eq!(msg.payload, Bytes::from_static(b"hi"));
    }

    #[tokio::test]
    async fn pattern_subscriber_matches() {
        let b = Arc::new(Broadcaster::new());
        b.register_pattern("news.*");
        let mut rx = b.subscribe("news.*");
        let n = b.publish("news.sports", Bytes::from_static(b"goal"));
        assert_eq!(n, 1);
        let msg = rx.recv().await.unwrap();
        assert_eq!(msg.channel, "news.sports");
    }

    #[tokio::test]
    async fn numsub_and_numpat() {
        let b = Arc::new(Broadcaster::new());
        let _rx = b.subscribe("ch");
        assert_eq!(b.channel_subscribers("ch"), 1);
        b.register_pattern("p*");
        assert_eq!(b.pattern_count(), 1);
    }
}
