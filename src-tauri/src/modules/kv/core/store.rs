//! The concurrent key-value store backing the server.
//!
//! `DashMap` lets per-connection tasks read and write shared state without a
//! single global lock. Expiry is enforced two ways, matching real Redis/Valkey:
//!
//!   - **Lazy:** every read path (`get`, `exists`, ...) checks the deadline and
//!     treats an expired key as absent, deleting it opportunistically. Covers
//!     hot keys with no background cost.
//!   - **Active:** `sweep()` scans and evicts expired keys so a key that is
//!     written with a TTL and then never touched again does not leak memory.
//!     The serving shell (issue #97) calls it on a timer.
//!
//! All deadlines are monotonic `Instant`s (see `value.rs` for why). The only
//! epoch-ms conversion lives in the TTL command handlers.

use std::time::{Duration, Instant};

use bytes::Bytes;
use dashmap::DashMap;

use super::value::{Entry, Value};

/// Outcome of a numeric mutation (`INCR`/`DECR`/`INCRBY`).
pub enum IncrError {
    /// The existing value is a string that does not parse as an i64.
    NotAnInteger,
    /// The operation would overflow an i64.
    Overflow,
    /// The key holds a non-string value.
    WrongType,
}

#[derive(Default)]
pub struct Store {
    map: DashMap<String, Entry>,
}

impl Store {
    pub fn new() -> Self {
        Store {
            map: DashMap::new(),
        }
    }

    /// Number of live (non-expired) keys. Lazily evicts any expired key it
    /// encounters so the count never includes a logically dead key.
    pub fn dbsize(&self, now: Instant) -> usize {
        // Collect expired keys first, then remove, to avoid holding shard locks
        // across a remove (DashMap deadlocks if you mutate while iterating the
        // same shard).
        let expired: Vec<String> = self
            .map
            .iter()
            .filter(|e| e.value().is_expired_at(now))
            .map(|e| e.key().clone())
            .collect();
        for k in &expired {
            self.map.remove_if(k, |_, v| v.is_expired_at(now));
        }
        self.map.len()
    }

    /// Remove every expired key. Returns the number evicted. Called by the
    /// active-expiry timer.
    pub fn sweep(&self, now: Instant) -> usize {
        let expired: Vec<String> = self
            .map
            .iter()
            .filter(|e| e.value().is_expired_at(now))
            .map(|e| e.key().clone())
            .collect();
        let mut removed = 0;
        for k in &expired {
            if self.map.remove_if(k, |_, v| v.is_expired_at(now)).is_some() {
                removed += 1;
            }
        }
        removed
    }

    /// Drop an expired key on the read path and report whether the key is now
    /// absent. Centralizes the lazy-expiry check.
    fn evict_if_expired(&self, key: &str, now: Instant) -> bool {
        if let Some(e) = self.map.get(key) {
            if e.value().is_expired_at(now) {
                drop(e);
                self.map.remove_if(key, |_, v| v.is_expired_at(now));
                return true;
            }
            false
        } else {
            true
        }
    }

    /// `GET`-style read of a string value. Returns `None` if missing/expired,
    /// `Some(Err(()))` if the key holds a non-string (WRONGTYPE).
    #[allow(clippy::result_unit_err)]
    pub fn get_str(&self, key: &str, now: Instant) -> Option<Result<Bytes, ()>> {
        if self.evict_if_expired(key, now) {
            return None;
        }
        self.map.get(key).map(|e| match &e.value().value {
            Value::Str(b) => Ok(b.clone()),
            #[allow(unreachable_patterns)]
            _ => Err(()),
        })
    }

    /// True if the key exists and is not expired.
    pub fn exists(&self, key: &str, now: Instant) -> bool {
        !self.evict_if_expired(key, now)
    }

    /// `TYPE` name, or `None` if missing/expired.
    pub fn type_name(&self, key: &str, now: Instant) -> Option<&'static str> {
        if self.evict_if_expired(key, now) {
            return None;
        }
        self.map.get(key).map(|e| e.value().value.type_name())
    }

    /// Set a string value. `keep_ttl` preserves an existing key's expiry;
    /// otherwise `expire_at` replaces it (`None` = persist/no expiry).
    pub fn set_str(&self, key: String, data: Bytes, expire_at: Option<Instant>, keep_ttl: bool) {
        let existing_ttl = if keep_ttl {
            self.map.get(&key).and_then(|e| e.value().expire_at)
        } else {
            None
        };
        let entry = Entry {
            value: Value::Str(data),
            expire_at: if keep_ttl { existing_ttl } else { expire_at },
        };
        self.map.insert(key, entry);
    }

    /// Insert a string only if the key does not already exist (live).
    /// Returns true if it was set. Used by `SETNX` / `SET NX`.
    pub fn set_str_nx(&self, key: String, data: Bytes, expire_at: Option<Instant>, now: Instant) -> bool {
        if self.exists(&key, now) {
            return false;
        }
        self.set_str(key, data, expire_at, false);
        true
    }

    /// Set only if the key already exists (live). Returns true if it was set.
    /// Used by `SET XX`.
    pub fn set_str_xx(&self, key: String, data: Bytes, expire_at: Option<Instant>, keep_ttl: bool, now: Instant) -> bool {
        if !self.exists(&key, now) {
            return false;
        }
        self.set_str(key, data, expire_at, keep_ttl);
        true
    }

    /// Delete a key. Returns true if a live key was removed (an already-expired
    /// key counts as not present).
    pub fn delete(&self, key: &str, now: Instant) -> bool {
        if self.evict_if_expired(key, now) {
            return false;
        }
        self.map.remove(key).is_some()
    }

    /// `APPEND`: append bytes to a string (creating it if absent), return the
    /// new length. `Err(())` signals the key holds a non-string (WRONGTYPE) —
    /// a single-bit failure, so a unit error keeps the call site terse.
    #[allow(clippy::result_unit_err)]
    pub fn append(&self, key: &str, suffix: &[u8], now: Instant) -> Result<usize, ()> {
        self.evict_if_expired(key, now);
        let mut entry = self
            .map
            .entry(key.to_string())
            .or_insert_with(|| Entry::new(Value::Str(Bytes::new())));
        match &entry.value {
            Value::Str(existing) => {
                let mut buf = Vec::with_capacity(existing.len() + suffix.len());
                buf.extend_from_slice(existing);
                buf.extend_from_slice(suffix);
                let len = buf.len();
                entry.value = Value::Str(Bytes::from(buf));
                Ok(len)
            }
            #[allow(unreachable_patterns)]
            _ => Err(()),
        }
    }

    /// `INCRBY`/`DECRBY`/`INCR`/`DECR`. Treats a missing key as 0, parses the
    /// existing string as i64, applies `delta` with overflow check, stores the
    /// result as its decimal string, and returns the new value.
    pub fn incr_by(&self, key: &str, delta: i64, now: Instant) -> Result<i64, IncrError> {
        self.evict_if_expired(key, now);
        let mut entry = self
            .map
            .entry(key.to_string())
            .or_insert_with(|| Entry::new(Value::Str(Bytes::from_static(b"0"))));
        let cur = match &entry.value {
            Value::Str(b) => std::str::from_utf8(b)
                .ok()
                .and_then(|s| s.trim().parse::<i64>().ok())
                .ok_or(IncrError::NotAnInteger)?,
            #[allow(unreachable_patterns)]
            _ => return Err(IncrError::WrongType),
        };
        let next = cur.checked_add(delta).ok_or(IncrError::Overflow)?;
        entry.value = Value::Str(Bytes::from(next.to_string()));
        Ok(next)
    }

    /// Set (or clear with `None`) a key's expiry. Returns false if the key does
    /// not exist (live). Backs `EXPIRE`/`PEXPIRE`/`EXPIREAT`/`PERSIST`.
    pub fn set_expiry(&self, key: &str, expire_at: Option<Instant>, now: Instant) -> bool {
        if self.evict_if_expired(key, now) {
            return false;
        }
        match self.map.get_mut(key) {
            Some(mut e) => {
                e.expire_at = expire_at;
                true
            }
            None => false,
        }
    }

    /// Remaining time to live as a `Duration`, or `None` if the key is missing
    /// or has no expiry. The caller maps the two cases to the right `TTL`
    /// sentinel (-2 missing, -1 no-expiry).
    pub fn ttl(&self, key: &str, now: Instant) -> TtlState {
        if self.evict_if_expired(key, now) {
            return TtlState::Missing;
        }
        match self.map.get(key) {
            Some(e) => match e.expire_at {
                Some(deadline) => TtlState::Expiring(deadline.saturating_duration_since(now)),
                None => TtlState::NoExpiry,
            },
            None => TtlState::Missing,
        }
    }

    /// The absolute expiry deadline of a key, if any. Used by `EXPIRETIME`.
    pub fn expire_at(&self, key: &str, now: Instant) -> Option<Instant> {
        if self.evict_if_expired(key, now) {
            return None;
        }
        self.map.get(key).and_then(|e| e.expire_at)
    }

    /// All live keys (snapshot). Used by `KEYS` and as the cursor source for
    /// `SCAN`. Evicts expired keys as it goes so the result never lists a dead
    /// key.
    pub fn live_keys(&self, now: Instant) -> Vec<String> {
        let mut out = Vec::new();
        let mut expired = Vec::new();
        for e in self.map.iter() {
            if e.value().is_expired_at(now) {
                expired.push(e.key().clone());
            } else {
                out.push(e.key().clone());
            }
        }
        for k in &expired {
            self.map.remove_if(k, |_, v| v.is_expired_at(now));
        }
        out
    }

    /// Remove every key. Backs `FLUSHDB`/`FLUSHALL`.
    pub fn clear(&self) {
        self.map.clear();
    }

    /// Insert a fully-formed entry, bypassing the read-path TTL checks. Used by
    /// snapshot load (the caller has already dropped expired keys and converted
    /// deadlines).
    pub fn insert_loaded(&self, entry: Entry, key: String) {
        self.map.insert(key, entry);
    }

    /// Convert a TTL `Duration` from now into a monotonic deadline. Helper for
    /// the command layer.
    pub fn deadline_in(now: Instant, ttl: Duration) -> Instant {
        now.checked_add(ttl).unwrap_or(now)
    }
}

/// The three states `TTL`/`PTTL` distinguish.
pub enum TtlState {
    /// Key does not exist (-> -2).
    Missing,
    /// Key exists with no expiry (-> -1).
    NoExpiry,
    /// Key exists and expires after this remaining duration.
    Expiring(Duration),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn now() -> Instant {
        Instant::now()
    }

    #[test]
    fn set_get_round_trip() {
        let s = Store::new();
        let t = now();
        s.set_str("k".into(), Bytes::from_static(b"v"), None, false);
        assert_eq!(s.get_str("k", t).unwrap().unwrap(), Bytes::from_static(b"v"));
    }

    #[test]
    fn missing_key_is_none() {
        let s = Store::new();
        assert!(s.get_str("nope", now()).is_none());
    }

    #[test]
    fn lazy_expiry_hides_and_removes() {
        let s = Store::new();
        let t0 = now();
        let past = t0 - Duration::from_secs(1);
        s.set_str("k".into(), Bytes::from_static(b"v"), Some(past), false);
        // Read after the deadline: gone.
        assert!(s.get_str("k", t0).is_none());
        // And physically evicted.
        assert_eq!(s.dbsize(t0), 0);
    }

    #[test]
    fn active_sweep_evicts_untouched_expired() {
        let s = Store::new();
        let t0 = now();
        s.set_str("live".into(), Bytes::from_static(b"v"), None, false);
        s.set_str("dead".into(), Bytes::from_static(b"v"), Some(t0 - Duration::from_secs(1)), false);
        assert_eq!(s.sweep(t0), 1);
        assert!(s.exists("live", t0));
        assert!(!s.exists("dead", t0));
    }

    #[test]
    fn ttl_states() {
        let s = Store::new();
        let t0 = now();
        assert!(matches!(s.ttl("missing", t0), TtlState::Missing));
        s.set_str("noexp".into(), Bytes::from_static(b"v"), None, false);
        assert!(matches!(s.ttl("noexp", t0), TtlState::NoExpiry));
        let deadline = Store::deadline_in(t0, Duration::from_secs(100));
        s.set_str("exp".into(), Bytes::from_static(b"v"), Some(deadline), false);
        match s.ttl("exp", t0) {
            TtlState::Expiring(d) => assert!(d.as_secs() >= 99 && d.as_secs() <= 100),
            _ => panic!("expected Expiring"),
        }
    }

    #[test]
    fn set_keepttl_preserves_expiry() {
        let s = Store::new();
        let t0 = now();
        let deadline = Store::deadline_in(t0, Duration::from_secs(50));
        s.set_str("k".into(), Bytes::from_static(b"a"), Some(deadline), false);
        // Overwrite value, keep TTL.
        s.set_str("k".into(), Bytes::from_static(b"b"), None, true);
        match s.ttl("k", t0) {
            TtlState::Expiring(_) => {}
            _ => panic!("KEEPTTL should preserve expiry"),
        }
        // Overwrite without keepttl clears it.
        s.set_str("k".into(), Bytes::from_static(b"c"), None, false);
        assert!(matches!(s.ttl("k", t0), TtlState::NoExpiry));
    }

    #[test]
    fn setnx_only_when_absent() {
        let s = Store::new();
        let t0 = now();
        assert!(s.set_str_nx("k".into(), Bytes::from_static(b"1"), None, t0));
        assert!(!s.set_str_nx("k".into(), Bytes::from_static(b"2"), None, t0));
        assert_eq!(s.get_str("k", t0).unwrap().unwrap(), Bytes::from_static(b"1"));
    }

    #[test]
    fn incr_decr_and_errors() {
        let s = Store::new();
        let t0 = now();
        assert_eq!(s.incr_by("c", 1, t0).ok().unwrap(), 1);
        assert_eq!(s.incr_by("c", 9, t0).ok().unwrap(), 10);
        assert_eq!(s.incr_by("c", -3, t0).ok().unwrap(), 7);
        s.set_str("nan".into(), Bytes::from_static(b"abc"), None, false);
        assert!(matches!(s.incr_by("nan", 1, t0), Err(IncrError::NotAnInteger)));
        s.set_str("max".into(), Bytes::from(i64::MAX.to_string()), None, false);
        assert!(matches!(s.incr_by("max", 1, t0), Err(IncrError::Overflow)));
    }

    #[test]
    fn append_creates_and_extends() {
        let s = Store::new();
        let t0 = now();
        assert_eq!(s.append("k", b"foo", t0).unwrap(), 3);
        assert_eq!(s.append("k", b"bar", t0).unwrap(), 6);
        assert_eq!(s.get_str("k", t0).unwrap().unwrap(), Bytes::from_static(b"foobar"));
    }

    #[test]
    fn delete_and_exists() {
        let s = Store::new();
        let t0 = now();
        s.set_str("k".into(), Bytes::from_static(b"v"), None, false);
        assert!(s.exists("k", t0));
        assert!(s.delete("k", t0));
        assert!(!s.delete("k", t0));
        assert!(!s.exists("k", t0));
    }

    #[test]
    fn set_expiry_on_missing_is_false() {
        let s = Store::new();
        let t0 = now();
        assert!(!s.set_expiry("missing", Some(Store::deadline_in(t0, Duration::from_secs(5))), t0));
        s.set_str("k".into(), Bytes::from_static(b"v"), None, false);
        assert!(s.set_expiry("k", Some(Store::deadline_in(t0, Duration::from_secs(5))), t0));
        assert!(matches!(s.ttl("k", t0), TtlState::Expiring(_)));
        // PERSIST clears it.
        assert!(s.set_expiry("k", None, t0));
        assert!(matches!(s.ttl("k", t0), TtlState::NoExpiry));
    }

    #[test]
    fn live_keys_excludes_expired() {
        let s = Store::new();
        let t0 = now();
        s.set_str("a".into(), Bytes::from_static(b"v"), None, false);
        s.set_str("b".into(), Bytes::from_static(b"v"), Some(t0 - Duration::from_secs(1)), false);
        let keys = s.live_keys(t0);
        assert_eq!(keys, vec!["a".to_string()]);
    }
}
