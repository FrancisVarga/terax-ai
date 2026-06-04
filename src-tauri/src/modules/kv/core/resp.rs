//! RESP wire helpers built on `redis-protocol` 6.
//!
//! Two directions:
//!   - **Decode (incoming):** clients always send commands as a RESP2 multibulk
//!     array of bulk strings, regardless of the protocol they negotiated for
//!     replies. So `parse_command` decodes with the RESP2 codec and extracts the
//!     argument byte-vectors.
//!   - **Encode (outgoing):** replies are encoded in the connection's negotiated
//!     dialect. `Reply` is a transport-agnostic response value; `encode_reply`
//!     renders it as a RESP2 or RESP3 `BytesFrame` and serializes it to bytes.
//!
//! Keeping `Reply` separate from the wire frame means command handlers
//! (`dispatch.rs`) never touch RESP2-vs-RESP3 details: they return a `Reply` and
//! this module picks the right frame shape for the peer.

use bytes::{Bytes, BytesMut};
use redis_protocol::resp2::types::BytesFrame as Resp2Frame;
use redis_protocol::resp3::types::BytesFrame as Resp3Frame;

/// The RESP dialect negotiated for a connection. Set to `Resp3` when the client
/// sends `HELLO 3`; defaults to `Resp2`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Proto {
    Resp2,
    Resp3,
}

impl Default for Proto {
    fn default() -> Self {
        Proto::Resp2
    }
}

/// A protocol-agnostic reply. Handlers build these; `encode_reply` turns them
/// into the right wire frame for the peer's `Proto`.
#[derive(Debug, Clone)]
pub enum Reply {
    /// `+OK\r\n` style simple string.
    Simple(String),
    /// `-ERR ...` style error.
    Error(String),
    /// `:N\r\n` integer.
    Int(i64),
    /// A bulk string payload.
    Bulk(Bytes),
    /// A null bulk / null (RESP2 `$-1`, RESP3 `_`).
    Nil,
    /// An array of replies (RESP2 `*`, RESP3 array).
    Array(Vec<Reply>),
    /// A map of key/value reply pairs. RESP3 encodes a real map (`%`); RESP2
    /// flattens it to a 2N array (what RESP2 clients expect from `HELLO`,
    /// `CONFIG GET`, etc.).
    Map(Vec<(Reply, Reply)>),
    /// A pub/sub style server push. RESP3 encodes a `Push` (`>`); RESP2 encodes
    /// a plain array (RESP2 has no push type — clients in RESP2 mode read
    /// pub/sub messages as ordinary arrays).
    Push(Vec<Reply>),
    /// A RESP3 double; RESP2 renders it as a bulk string (RESP2 has no double).
    Double(f64),
    /// A RESP3 boolean; RESP2 renders it as `:1`/`:0`.
    Bool(bool),
}

impl Reply {
    pub fn ok() -> Reply {
        Reply::Simple("OK".into())
    }

    pub fn bulk_str(s: impl Into<String>) -> Reply {
        Reply::Bulk(Bytes::from(s.into()))
    }
}

/// Parse one complete command off the front of `buf`. Commands are RESP2
/// multibulk arrays of bulk strings; inline commands (used by `redis-cli` in
/// some paths and by raw `nc`) are also accepted.
///
/// Returns:
///   - `Ok(Some(args))` — a complete command; its bytes have been drained.
///   - `Ok(None)` — need more bytes (partial frame); leave `buf` untouched.
///   - `Err(msg)` — malformed framing; the caller should reply with an error
///     and may close the connection.
pub fn parse_command(buf: &mut BytesMut) -> Result<Option<Vec<Bytes>>, String> {
    if buf.is_empty() {
        return Ok(None);
    }

    // Inline command support: a line that does not start with '*' is treated as
    // a space-separated inline command (RESP inline protocol). redis-cli's
    // interactive mode and ad-hoc `nc` sessions use this.
    if buf[0] != b'*' {
        return parse_inline(buf);
    }

    match redis_protocol::resp2::decode::decode_bytes_mut(buf) {
        // `decode_bytes_mut` already drained the consumed bytes from `buf`.
        Ok(Some((frame, _consumed, _whole))) => match frame {
            Resp2Frame::Array(items) => {
                let mut args = Vec::with_capacity(items.len());
                for it in items {
                    match it {
                        Resp2Frame::BulkString(b) | Resp2Frame::SimpleString(b) => args.push(b),
                        Resp2Frame::Integer(n) => args.push(Bytes::from(n.to_string())),
                        other => {
                            return Err(format!(
                                "Protocol error: expected bulk string argument, got {other:?}"
                            ))
                        }
                    }
                }
                if args.is_empty() {
                    // Empty multibulk: a no-op ping in real Redis; treat as a
                    // command with no args so the dispatcher can ignore it.
                    return Ok(Some(Vec::new()));
                }
                Ok(Some(args))
            }
            Resp2Frame::Null => Ok(Some(Vec::new())),
            other => Err(format!("Protocol error: expected array, got {other:?}")),
        },
        Ok(None) => Ok(None),
        Err(e) => Err(format!("Protocol error: {e}")),
    }
}

/// Parse a single inline command line if a full `\r\n`- or `\n`-terminated line
/// is present. Splits on ASCII whitespace (good enough for the inline protocol;
/// quoted args are a redis-cli convenience we do not need for library clients).
fn parse_inline(buf: &mut BytesMut) -> Result<Option<Vec<Bytes>>, String> {
    let Some(nl) = buf.iter().position(|&b| b == b'\n') else {
        // No full line yet.
        return Ok(None);
    };
    let line = buf.split_to(nl + 1);
    let line = &line[..line.len() - 1];
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let args: Vec<Bytes> = line
        .split(|&b| b == b' ' || b == b'\t')
        .filter(|s| !s.is_empty())
        .map(Bytes::copy_from_slice)
        .collect();
    Ok(Some(args))
}

/// Serialize a `Reply` to wire bytes in the peer's negotiated dialect.
pub fn encode_reply(reply: &Reply, proto: Proto) -> Bytes {
    match proto {
        Proto::Resp2 => encode_resp2(&to_resp2(reply)),
        Proto::Resp3 => encode_resp3(&to_resp3(reply)),
    }
}

fn encode_resp2(frame: &Resp2Frame) -> Bytes {
    let mut out = BytesMut::new();
    // `int_as_bulkstring = false`: encode integers as the RESP `:` type.
    let _ = redis_protocol::resp2::encode::extend_encode(&mut out, frame, false);
    out.freeze()
}

fn encode_resp3(frame: &Resp3Frame) -> Bytes {
    let mut out = BytesMut::new();
    // RESP3 splits encoding into `complete` (whole frames) and `streaming`; we
    // only emit complete frames.
    let _ = redis_protocol::resp3::encode::complete::extend_encode(&mut out, frame, false);
    out.freeze()
}

/// Lower a `Reply` to a RESP2 frame. RESP3-only shapes degrade: map -> flat
/// 2N array, push -> array, double -> bulk string, bool -> integer.
fn to_resp2(reply: &Reply) -> Resp2Frame {
    match reply {
        Reply::Simple(s) => Resp2Frame::SimpleString(Bytes::from(s.clone())),
        Reply::Error(s) => Resp2Frame::Error(s.clone().into()),
        Reply::Int(n) => Resp2Frame::Integer(*n),
        Reply::Bulk(b) => Resp2Frame::BulkString(b.clone()),
        Reply::Nil => Resp2Frame::Null,
        Reply::Array(items) | Reply::Push(items) => {
            Resp2Frame::Array(items.iter().map(to_resp2).collect())
        }
        Reply::Map(pairs) => {
            let mut flat = Vec::with_capacity(pairs.len() * 2);
            for (k, v) in pairs {
                flat.push(to_resp2(k));
                flat.push(to_resp2(v));
            }
            Resp2Frame::Array(flat)
        }
        Reply::Double(d) => Resp2Frame::BulkString(Bytes::from(format_double(*d))),
        Reply::Bool(b) => Resp2Frame::Integer(if *b { 1 } else { 0 }),
    }
}

/// Lower a `Reply` to a RESP3 frame, using the richer types where they exist.
fn to_resp3(reply: &Reply) -> Resp3Frame {
    match reply {
        Reply::Simple(s) => Resp3Frame::SimpleString {
            data: Bytes::from(s.clone()),
            attributes: None,
        },
        Reply::Error(s) => Resp3Frame::SimpleError {
            data: s.clone().into(),
            attributes: None,
        },
        Reply::Int(n) => Resp3Frame::Number {
            data: *n,
            attributes: None,
        },
        Reply::Bulk(b) => Resp3Frame::BlobString {
            data: b.clone(),
            attributes: None,
        },
        Reply::Nil => Resp3Frame::Null,
        Reply::Array(items) => Resp3Frame::Array {
            data: items.iter().map(to_resp3).collect(),
            attributes: None,
        },
        Reply::Push(items) => Resp3Frame::Push {
            data: items.iter().map(to_resp3).collect(),
            attributes: None,
        },
        Reply::Map(pairs) => {
            let mut map = redis_protocol::resp3::types::FrameMap::new();
            for (k, v) in pairs {
                map.insert(to_resp3(k), to_resp3(v));
            }
            Resp3Frame::Map {
                data: map,
                attributes: None,
            }
        }
        Reply::Double(d) => Resp3Frame::Double {
            data: *d,
            attributes: None,
        },
        Reply::Bool(b) => Resp3Frame::Boolean {
            data: *b,
            attributes: None,
        },
    }
}

/// Format a double the way Redis does (`inf`/`-inf`, no trailing zeros).
fn format_double(d: f64) -> String {
    if d.is_infinite() {
        if d > 0.0 {
            "inf".into()
        } else {
            "-inf".into()
        }
    } else if d == d.trunc() && d.abs() < 1e17 {
        format!("{}", d as i64)
    } else {
        format!("{d}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn multibulk(parts: &[&str]) -> BytesMut {
        let mut b = BytesMut::new();
        b.extend_from_slice(format!("*{}\r\n", parts.len()).as_bytes());
        for p in parts {
            b.extend_from_slice(format!("${}\r\n{}\r\n", p.len(), p).as_bytes());
        }
        b
    }

    #[test]
    fn parse_multibulk_command() {
        let mut buf = multibulk(&["SET", "k", "v"]);
        let args = parse_command(&mut buf).unwrap().unwrap();
        let got: Vec<&[u8]> = args.iter().map(|b| b.as_ref()).collect();
        assert_eq!(got, vec![b"SET".as_ref(), b"k".as_ref(), b"v".as_ref()]);
        assert!(buf.is_empty(), "consumed bytes drained");
    }

    #[test]
    fn parse_partial_returns_none() {
        // Half a frame: header says 3 args but only one provided.
        let mut buf = BytesMut::from(&b"*3\r\n$3\r\nSET\r\n"[..]);
        assert!(parse_command(&mut buf).unwrap().is_none());
    }

    #[test]
    fn parse_inline_command() {
        let mut buf = BytesMut::from(&b"PING\r\n"[..]);
        let args = parse_command(&mut buf).unwrap().unwrap();
        assert_eq!(args, vec![Bytes::from_static(b"PING")]);
    }

    #[test]
    fn parse_two_pipelined_commands() {
        let mut buf = multibulk(&["PING"]);
        buf.unsplit(multibulk(&["GET", "k"]));
        let a = parse_command(&mut buf).unwrap().unwrap();
        assert_eq!(a, vec![Bytes::from_static(b"PING")]);
        let b = parse_command(&mut buf).unwrap().unwrap();
        assert_eq!(b.len(), 2);
        assert!(buf.is_empty());
    }

    #[test]
    fn encode_simple_resp2_and_resp3() {
        assert_eq!(&encode_reply(&Reply::ok(), Proto::Resp2)[..], b"+OK\r\n");
        assert_eq!(&encode_reply(&Reply::ok(), Proto::Resp3)[..], b"+OK\r\n");
    }

    #[test]
    fn encode_nil_differs_by_proto() {
        assert_eq!(&encode_reply(&Reply::Nil, Proto::Resp2)[..], b"$-1\r\n");
        assert_eq!(&encode_reply(&Reply::Nil, Proto::Resp3)[..], b"_\r\n");
    }

    #[test]
    fn encode_bulk_and_int() {
        assert_eq!(
            &encode_reply(&Reply::bulk_str("hi"), Proto::Resp2)[..],
            b"$2\r\nhi\r\n"
        );
        assert_eq!(&encode_reply(&Reply::Int(42), Proto::Resp2)[..], b":42\r\n");
    }

    #[test]
    fn map_flattens_in_resp2_is_map_in_resp3() {
        let m = Reply::Map(vec![(Reply::bulk_str("a"), Reply::Int(1))]);
        // RESP2: 2-element array.
        assert_eq!(
            &encode_reply(&m, Proto::Resp2)[..],
            b"*2\r\n$1\r\na\r\n:1\r\n"
        );
        // RESP3: real map with one pair.
        assert_eq!(
            &encode_reply(&m, Proto::Resp3)[..],
            b"%1\r\n$1\r\na\r\n:1\r\n"
        );
    }

    #[test]
    fn push_is_array_in_resp2_push_in_resp3() {
        let p = Reply::Push(vec![Reply::bulk_str("message"), Reply::bulk_str("ch"), Reply::bulk_str("hi")]);
        let r2 = encode_reply(&p, Proto::Resp2);
        assert!(r2.starts_with(b"*3\r\n"), "resp2 push is a plain array");
        let r3 = encode_reply(&p, Proto::Resp3);
        assert!(r3.starts_with(b">3\r\n"), "resp3 push uses > prefix");
    }
}
