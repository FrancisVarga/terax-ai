//! `kv_core` — the pure, transport-agnostic heart of the embedded
//! Redis/Valkey-protocol KV server (issue #95).
//!
//! No sockets, no Tauri, no process management here. The serving shell (the
//! `kv-server` sidecar in #96 and the dev in-process fallback in #97) builds the
//! TCP loop on top of this: read bytes -> `resp::parse_command` -> `dispatch` ->
//! `resp::encode_reply` -> write bytes. Pub/sub fan-out is provided to
//! `dispatch` through the `PubSub` trait, implemented by the shell.
//!
//! This is TERAX.md's functional core: every command is a pure function over
//! `(Store, Conn, args, now)`, so the whole surface is unit-testable without a
//! socket (see the `#[cfg(test)]` modules in each file).

pub mod conn;
pub mod dispatch;
pub mod pubsub;
pub mod resp;
pub mod store;
pub mod value;

pub use conn::Conn;
pub use dispatch::{dispatch, Clock, Dispatch, SERVER_NAME, SERVER_VERSION};
pub use pubsub::{NoopPubSub, PubSub};
pub use resp::{encode_reply, parse_command, Proto, Reply};
pub use store::{Store, TtlState};
pub use value::{Entry, Value};
