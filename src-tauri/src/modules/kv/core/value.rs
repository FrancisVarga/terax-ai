//! Stored values and their optional expiry.
//!
//! Phase 1 only needs a string value, but `Value` is an enum from the start so
//! Phase 2 (hash/list/set/zset) adds variants without touching the `Store` or
//! the entry shape. Expiry is held as a monotonic `Instant` at runtime so a
//! system clock change can never prematurely expire or resurrect a key; the
//! conversion to/from the client's epoch-ms only happens at the command
//! boundary (`TTL`, `PEXPIREAT`, etc.) and at the disk snapshot boundary
//! (persistence, issue #98).

use std::time::Instant;

use bytes::Bytes;

/// A value held in the store. The byte payload of a string is `Bytes` so it can
/// be cloned cheaply (ref-counted) when read and encoded straight into a RESP
/// bulk-string frame without a copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    /// A binary-safe string (the only Phase 1 type).
    Str(Bytes),
}

impl Value {
    /// The Redis `TYPE` name for this value.
    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Str(_) => "string",
        }
    }

    /// Borrow the bytes if this is a string, else `None`. Commands that only
    /// operate on strings (`GET`, `APPEND`, `INCR`, ...) use this to return a
    /// WRONGTYPE error on a non-string value.
    pub fn as_str(&self) -> Option<&Bytes> {
        match self {
            Value::Str(b) => Some(b),
        }
    }
}

/// A map entry: the value plus an optional expiry deadline.
///
/// `expire_at == None` means the key never expires. A `Some(deadline)` already
/// in the past means the key is logically gone; reads treat it as missing
/// (lazy expiry) and the active sweep evicts it.
#[derive(Debug, Clone)]
pub struct Entry {
    pub value: Value,
    pub expire_at: Option<Instant>,
}

impl Entry {
    /// A new entry with no expiry.
    pub fn new(value: Value) -> Self {
        Entry {
            value,
            expire_at: None,
        }
    }

    /// True if this entry has an expiry that has already elapsed as of `now`.
    pub fn is_expired_at(&self, now: Instant) -> bool {
        matches!(self.expire_at, Some(deadline) if deadline <= now)
    }
}
