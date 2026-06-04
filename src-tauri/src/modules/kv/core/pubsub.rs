//! Pub/sub fan-out abstraction.
//!
//! The actual cross-connection delivery (a `tokio::broadcast` per channel, or a
//! shared registry) lives in the serving shell (issue #97 / the sidecar), not in
//! the pure core. The dispatcher only needs to (a) record a connection's
//! interest, which lives on `Conn`, and (b) publish a message to all interested
//! subscribers, which it does through this trait. A test or the in-process
//! server provides the implementation.

use bytes::Bytes;

/// A publish sink. `publish` delivers `payload` on `channel` to every subscriber
/// (exact channel subscribers and matching pattern subscribers) and returns the
/// number of clients that received it, which is what `PUBLISH` returns.
pub trait PubSub: Send + Sync {
    fn publish(&self, channel: &str, payload: Bytes) -> i64;

    /// Channels with at least one subscriber (for `PUBSUB CHANNELS`).
    fn active_channels(&self, pattern: Option<&str>) -> Vec<String>;

    /// Subscriber count for a specific channel (for `PUBSUB NUMSUB`).
    fn channel_subscribers(&self, channel: &str) -> i64;

    /// Number of pattern subscriptions across all clients (for `PUBSUB NUMPAT`).
    fn pattern_count(&self) -> i64;
}

/// A no-op pub/sub used by unit tests of non-pubsub commands and as a default
/// when no real sink is wired. `PUBLISH` always reports zero receivers.
pub struct NoopPubSub;

impl PubSub for NoopPubSub {
    fn publish(&self, _channel: &str, _payload: Bytes) -> i64 {
        0
    }
    fn active_channels(&self, _pattern: Option<&str>) -> Vec<String> {
        Vec::new()
    }
    fn channel_subscribers(&self, _channel: &str) -> i64 {
        0
    }
    fn pattern_count(&self) -> i64 {
        0
    }
}
