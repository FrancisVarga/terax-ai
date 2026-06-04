//! Snapshot serialization for persistence (#98).
//!
//! The store holds expiry as monotonic `Instant`s, which are meaningless across
//! a process restart and cannot be serialized. So a snapshot stores each key's
//! value plus its expiry as an **absolute epoch-ms** timestamp (or `None`).
//!
//! Direction:
//!   - **save:** for each entry, convert its `Instant` deadline to epoch-ms via
//!     the current (now, epoch_ms) reference pair.
//!   - **load:** drop any key already past its absolute expiry (never resurrect
//!     an expired key), and convert the remaining absolute expiries back to
//!     monotonic deadlines relative to the load-time reference pair.
//!
//! This module owns only the in-memory <-> serializable transform and the byte
//! (de)serialization. Reading/writing the actual file (atomic temp+rename, path
//! resolution, the `.t-camelot` dir) lives in the serving shell so the core
//! stays IO-free and unit-testable.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::store::Store;
use super::value::{Entry, Value};

/// One persisted key. `expire_at_ms` is absolute epoch-ms, `None` = no expiry.
#[derive(Serialize, Deserialize)]
pub struct SnapshotEntry {
    pub key: String,
    pub value: Value,
    pub expire_at_ms: Option<i64>,
}

/// The whole persisted store. Versioned so a future format change can be
/// detected and migrated/skipped rather than mis-parsed.
#[derive(Serialize, Deserialize)]
pub struct Snapshot {
    pub version: u32,
    pub entries: Vec<SnapshotEntry>,
}

pub const SNAPSHOT_VERSION: u32 = 1;

impl Store {
    /// Build a serializable snapshot of all live keys. `now`/`epoch_ms` are the
    /// monotonic+wall reference pair used to convert deadlines to absolute time.
    /// Expired keys are skipped (a snapshot never persists a dead key).
    pub fn snapshot(&self, now: Instant, epoch_ms: i64) -> Snapshot {
        let mut entries = Vec::new();
        for key in self.live_keys(now) {
            // live_keys already evicted expired ones; re-read each entry's value
            // and deadline under its own short lock.
            self.snapshot_entry(&key, now, epoch_ms, &mut entries);
        }
        Snapshot {
            version: SNAPSHOT_VERSION,
            entries,
        }
    }

    /// Push one key's snapshot entry if it is a live string. Returns Some(()) if
    /// pushed. Kept separate so `snapshot` reads each key under its own short
    /// lock rather than holding a map-wide guard.
    fn snapshot_entry(
        &self,
        key: &str,
        now: Instant,
        epoch_ms: i64,
        out: &mut Vec<SnapshotEntry>,
    ) -> Option<()> {
        let value = match self.get_str(key, now)? {
            Ok(b) => Value::Str(b),
            Err(()) => return None, // non-string Phase 2 types: skip for now
        };
        let expire_at_ms = self
            .expire_at(key, now)
            .map(|deadline| epoch_ms + deadline.saturating_duration_since(now).as_millis() as i64);
        out.push(SnapshotEntry {
            key: key.to_string(),
            value,
            expire_at_ms,
        });
        Some(())
    }

    /// Replace the store contents from a snapshot. Keys already past their
    /// absolute expiry are dropped; future expiries are converted back to
    /// monotonic deadlines. Existing contents are cleared first.
    pub fn load_snapshot(&self, snap: &Snapshot, now: Instant, epoch_ms: i64) {
        self.clear();
        for e in &snap.entries {
            let expire_at = match e.expire_at_ms {
                Some(abs_ms) => {
                    let remaining = abs_ms - epoch_ms;
                    if remaining <= 0 {
                        continue; // already expired; never resurrect
                    }
                    Some(Store::deadline_in(
                        now,
                        std::time::Duration::from_millis(remaining as u64),
                    ))
                }
                None => None,
            };
            match &e.value {
                Value::Str(b) => self.insert_loaded(Entry {
                    value: Value::Str(b.clone()),
                    expire_at,
                }, e.key.clone()),
            }
        }
    }
}

/// Serialize a snapshot to bytes (bincode). Internal format; not user-facing.
pub fn encode(snap: &Snapshot) -> Result<Vec<u8>, String> {
    bincode::serialize(snap).map_err(|e| format!("snapshot encode failed: {e}"))
}

/// Deserialize a snapshot from bytes. A version mismatch is surfaced so the
/// caller can choose to start empty rather than mis-load.
pub fn decode(bytes: &[u8]) -> Result<Snapshot, String> {
    let snap: Snapshot =
        bincode::deserialize(bytes).map_err(|e| format!("snapshot decode failed: {e}"))?;
    if snap.version != SNAPSHOT_VERSION {
        return Err(format!(
            "snapshot version mismatch: file is v{}, expected v{}",
            snap.version, SNAPSHOT_VERSION
        ));
    }
    Ok(snap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use std::time::{Duration, Instant};

    fn refs() -> (Instant, i64) {
        (Instant::now(), 1_700_000_000_000)
    }

    #[test]
    fn round_trip_no_ttl() {
        let s = Store::new();
        let (now, epoch) = refs();
        s.set_str("k".into(), Bytes::from_static(b"v"), None, false);
        let snap = s.snapshot(now, epoch);
        let bytes = encode(&snap).unwrap();
        let decoded = decode(&bytes).unwrap();

        let s2 = Store::new();
        s2.load_snapshot(&decoded, now, epoch);
        assert_eq!(s2.get_str("k", now).unwrap().unwrap(), Bytes::from_static(b"v"));
    }

    #[test]
    fn ttl_preserved_across_reload() {
        let s = Store::new();
        let (now, epoch) = refs();
        let deadline = Store::deadline_in(now, Duration::from_secs(100));
        s.set_str("k".into(), Bytes::from_static(b"v"), Some(deadline), false);
        let snap = s.snapshot(now, epoch);

        // Reload at the same reference: TTL should be ~100s, not reset, not gone.
        let s2 = Store::new();
        s2.load_snapshot(&snap, now, epoch);
        match s2.ttl("k", now) {
            super::super::store::TtlState::Expiring(d) => {
                assert!(d.as_secs() >= 99 && d.as_secs() <= 100)
            }
            _ => panic!("expected Expiring"),
        }
    }

    #[test]
    fn expired_on_load_is_dropped() {
        let (now, epoch) = refs();
        // Build a snapshot by hand with an already-past absolute expiry.
        let snap = Snapshot {
            version: SNAPSHOT_VERSION,
            entries: vec![SnapshotEntry {
                key: "old".into(),
                value: Value::Str(Bytes::from_static(b"v")),
                expire_at_ms: Some(epoch - 1000), // 1s before the load epoch
            }],
        };
        let s2 = Store::new();
        s2.load_snapshot(&snap, now, epoch);
        assert!(!s2.exists("old", now), "expired-on-load key must be dropped");
    }

    #[test]
    fn version_mismatch_errors() {
        let snap = Snapshot {
            version: 999,
            entries: vec![],
        };
        let bytes = encode(&snap).unwrap();
        assert!(decode(&bytes).is_err());
    }
}
