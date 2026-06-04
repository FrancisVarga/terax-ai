//! Per-connection state that command handlers may read or mutate.
//!
//! Most commands are pure over the shared `Store`, but a few mutate the
//! connection itself: `HELLO` switches the reply protocol, `SUBSCRIBE` records
//! channel interest, `SELECT` changes the logical db, `AUTH` flips the
//! authenticated flag. Keeping this state out of the `Store` means the store
//! stays a plain shared map and the connection owns what is connection-scoped.

use std::collections::HashSet;

use super::resp::Proto;

/// Connection-scoped mutable state. One per client socket.
#[derive(Debug, Default)]
pub struct Conn {
    /// Reply dialect; flipped to `Resp3` by `HELLO 3`.
    pub proto: Proto,
    /// Whether the client has authenticated. When the server has no password,
    /// this is treated as always-authenticated (see `requires_auth`).
    pub authenticated: bool,
    /// Channels this connection is subscribed to (exact match).
    pub channels: HashSet<String>,
    /// Glob patterns this connection is psubscribed to.
    pub patterns: HashSet<String>,
    /// Selected logical db index. We are single-db, so this is accepted and
    /// echoed but does not partition data.
    pub db: i64,
    /// Optional client name set via `CLIENT SETNAME` / `HELLO ... SETNAME`.
    pub name: Option<String>,
}

impl Conn {
    pub fn new() -> Self {
        Conn::default()
    }

    /// Total number of subscriptions (channels + patterns). Redis includes this
    /// count in `subscribe`/`unsubscribe` confirmation replies.
    pub fn subscription_count(&self) -> i64 {
        (self.channels.len() + self.patterns.len()) as i64
    }

    /// True when the connection is in subscriber mode. In RESP2 a subscribed
    /// connection may only run a restricted command set; we are lenient and
    /// allow all commands, but expose this for confirmation-reply shaping.
    pub fn in_subscribe_mode(&self) -> bool {
        !self.channels.is_empty() || !self.patterns.is_empty()
    }
}
