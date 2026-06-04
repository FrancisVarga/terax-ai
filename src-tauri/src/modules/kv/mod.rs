//! Embedded Redis/Valkey-protocol key-value server (epic #94).
//!
//! Layered like the otel module:
//!   - `core` (#95): pure store + RESP codec + command dispatch. No IO.
//!   - serving shell (#96 sidecar / #97 in-process dev fallback): the TCP loop
//!     and pub/sub fan-out that drive `core`.
//!   - app lifecycle (#97): spawn/watchdog/status, mirroring `modules/bunqueue`.
//!
//! This file currently exposes `core`; the lifecycle (`KvState`, commands) lands
//! in #97 and is added here as a sibling submodule.

pub mod core;
