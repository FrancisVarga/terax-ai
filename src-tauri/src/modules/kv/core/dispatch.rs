//! Command dispatch: parse an argv, route to a handler, return a `Reply`.
//!
//! Design: a single `dispatch` entry point matches on the uppercased command
//! name. Unknown commands and arity errors return proper RESP errors (never
//! panic, never hang) so a partial command set behaves like "Redis with fewer
//! commands" rather than a broken server. Handlers are grouped by family
//! (handshake/meta, string/key/generic, ttl, pubsub) and kept small; adding a
//! command is a localized new match arm + handler + test.
//!
//! Handlers receive the shared `Store`, the per-connection `Conn`, the argv, the
//! pub/sub sink, and a `now` instant (injected so tests are deterministic and
//! the serving loop uses a single clock read per command).

use std::time::{Duration, Instant};

use bytes::Bytes;

use super::conn::Conn;
use super::pubsub::PubSub;
use super::resp::{Proto, Reply};
use super::store::{IncrError, Store, TtlState};

/// Server identity reported by `HELLO` / `INFO`.
pub const SERVER_NAME: &str = "terax-kv";
pub const SERVER_VERSION: &str = "0.1.0";

/// Outcome flags the serving loop may need beyond the reply (e.g. close the
/// socket after replying to `QUIT`).
pub struct Dispatch {
    pub reply: Reply,
    pub close: bool,
}

impl Dispatch {
    fn reply(reply: Reply) -> Self {
        Dispatch { reply, close: false }
    }
    fn close(reply: Reply) -> Self {
        Dispatch { reply, close: true }
    }
}

/// Wall-clock epoch milliseconds, paired with the monotonic `now`, so TTL
/// commands that speak absolute time (`EXPIREAT`, `EXPIRETIME`) can convert
/// between the client's epoch and our monotonic deadlines.
#[derive(Clone, Copy)]
pub struct Clock {
    pub now: Instant,
    pub epoch_ms: i64,
}

/// Route one command. `args[0]` is the command name (case-insensitive).
pub fn dispatch(
    store: &Store,
    conn: &mut Conn,
    pubsub: &dyn PubSub,
    clock: Clock,
    args: &[Bytes],
) -> Dispatch {
    if args.is_empty() {
        // Empty inline line / empty multibulk: no-op, no reply needed. Reply
        // with an empty simple string the loop can choose to skip; simplest is
        // to treat it as a PING-less no-op by returning OK-less. We return a nil
        // the loop suppresses.
        return Dispatch::reply(Reply::Nil);
    }
    let name = String::from_utf8_lossy(&args[0]).to_ascii_uppercase();
    let a = &args[1..]; // command arguments after the name

    match name.as_str() {
        // ---- handshake / connection ----
        "PING" => Dispatch::reply(cmd_ping(a)),
        "ECHO" => Dispatch::reply(arity(a, 1, 1, "echo").unwrap_or_else(|| Reply::Bulk(a[0].clone()))),
        "HELLO" => Dispatch::reply(cmd_hello(conn, a)),
        "AUTH" => Dispatch::reply(cmd_auth(conn, a)),
        "SELECT" => Dispatch::reply(cmd_select(conn, a)),
        "QUIT" => Dispatch::close(Reply::ok()),
        "RESET" => {
            *conn = Conn::new();
            Dispatch::reply(Reply::Simple("RESET".into()))
        }
        "CLIENT" => Dispatch::reply(cmd_client(conn, a)),
        "COMMAND" => Dispatch::reply(cmd_command(a)),
        "CONFIG" => Dispatch::reply(cmd_config(a)),
        "INFO" => Dispatch::reply(cmd_info()),
        "DBSIZE" => Dispatch::reply(Reply::Int(store.dbsize(clock.now) as i64)),
        "FLUSHDB" | "FLUSHALL" => {
            store.clear();
            Dispatch::reply(Reply::ok())
        }

        // ---- strings ----
        "GET" => Dispatch::reply(cmd_get(store, clock, a)),
        "SET" => Dispatch::reply(cmd_set(store, clock, a)),
        "SETNX" => Dispatch::reply(cmd_setnx(store, clock, a)),
        "SETEX" => Dispatch::reply(cmd_setex(store, clock, a, false)),
        "PSETEX" => Dispatch::reply(cmd_setex(store, clock, a, true)),
        "GETSET" => Dispatch::reply(cmd_getset(store, clock, a)),
        "GETDEL" => Dispatch::reply(cmd_getdel(store, clock, a)),
        "APPEND" => Dispatch::reply(cmd_append(store, clock, a)),
        "STRLEN" => Dispatch::reply(cmd_strlen(store, clock, a)),
        "MGET" => Dispatch::reply(cmd_mget(store, clock, a)),
        "MSET" => Dispatch::reply(cmd_mset(store, clock, a)),
        "INCR" => Dispatch::reply(cmd_incr_by(store, clock, &[a, &[Bytes::from_static(b"1")]].concat(), 1)),
        "DECR" => Dispatch::reply(cmd_incr_by(store, clock, &[a, &[Bytes::from_static(b"1")]].concat(), -1)),
        "INCRBY" => Dispatch::reply(cmd_incrby(store, clock, a, 1)),
        "DECRBY" => Dispatch::reply(cmd_incrby(store, clock, a, -1)),

        // ---- generic keys ----
        "DEL" | "UNLINK" => Dispatch::reply(cmd_del(store, clock, a)),
        "EXISTS" => Dispatch::reply(cmd_exists(store, clock, a)),
        "TYPE" => Dispatch::reply(cmd_type(store, clock, a)),
        "KEYS" => Dispatch::reply(cmd_keys(store, clock, a)),
        "SCAN" => Dispatch::reply(cmd_scan(store, clock, a)),
        "TOUCH" => Dispatch::reply(cmd_exists(store, clock, a)), // same count semantics
        "RANDOMKEY" => Dispatch::reply(cmd_randomkey(store, clock)),

        // ---- ttl ----
        "EXPIRE" => Dispatch::reply(cmd_expire(store, clock, a, ExpireUnit::Sec, false)),
        "PEXPIRE" => Dispatch::reply(cmd_expire(store, clock, a, ExpireUnit::Ms, false)),
        "EXPIREAT" => Dispatch::reply(cmd_expire(store, clock, a, ExpireUnit::Sec, true)),
        "PEXPIREAT" => Dispatch::reply(cmd_expire(store, clock, a, ExpireUnit::Ms, true)),
        "TTL" => Dispatch::reply(cmd_ttl(store, clock, a, false)),
        "PTTL" => Dispatch::reply(cmd_ttl(store, clock, a, true)),
        "PERSIST" => Dispatch::reply(cmd_persist(store, clock, a)),
        "EXPIRETIME" => Dispatch::reply(cmd_expiretime(store, clock, a, false)),
        "PEXPIRETIME" => Dispatch::reply(cmd_expiretime(store, clock, a, true)),

        // ---- pub/sub ----
        "SUBSCRIBE" => Dispatch::reply(cmd_subscribe(conn, a, false)),
        "UNSUBSCRIBE" => Dispatch::reply(cmd_unsubscribe(conn, a, false)),
        "PSUBSCRIBE" => Dispatch::reply(cmd_subscribe(conn, a, true)),
        "PUNSUBSCRIBE" => Dispatch::reply(cmd_unsubscribe(conn, a, true)),
        "PUBLISH" => Dispatch::reply(cmd_publish(pubsub, a)),
        "PUBSUB" => Dispatch::reply(cmd_pubsub(pubsub, a)),

        other => Dispatch::reply(Reply::Error(format!(
            "ERR unknown command '{}', with args beginning with: {}",
            other,
            a.first()
                .map(|b| format!("'{}'", String::from_utf8_lossy(b)))
                .unwrap_or_default()
        ))),
    }
}

// ---------------------------------------------------------------------------
// arity + arg helpers
// ---------------------------------------------------------------------------

/// Return `Some(error_reply)` if `args.len()` is outside `[min, max]` (use
/// `max = usize::MAX` for unbounded). `None` means arity is fine.
fn arity(args: &[Bytes], min: usize, max: usize, name: &str) -> Option<Reply> {
    if args.len() < min || args.len() > max {
        Some(Reply::Error(format!(
            "ERR wrong number of arguments for '{name}' command"
        )))
    } else {
        None
    }
}

fn as_str(b: &Bytes) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn parse_i64(b: &Bytes) -> Result<i64, Reply> {
    std::str::from_utf8(b)
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .ok_or_else(|| Reply::Error("ERR value is not an integer or out of range".into()))
}

// ---------------------------------------------------------------------------
// handshake / meta
// ---------------------------------------------------------------------------

fn cmd_ping(a: &[Bytes]) -> Reply {
    match a.len() {
        0 => Reply::Simple("PONG".into()),
        1 => Reply::Bulk(a[0].clone()),
        _ => Reply::Error("ERR wrong number of arguments for 'ping' command".into()),
    }
}

fn cmd_hello(conn: &mut Conn, a: &[Bytes]) -> Reply {
    // HELLO [protover [AUTH user pass] [SETNAME name]]
    let mut i = 0;
    if i < a.len() {
        // First arg, if present and numeric, is the protocol version.
        match as_str(&a[i]).parse::<u8>() {
            Ok(2) => {
                conn.proto = Proto::Resp2;
                i += 1;
            }
            Ok(3) => {
                conn.proto = Proto::Resp3;
                i += 1;
            }
            Ok(_) => {
                return Reply::Error(
                    "NOPROTO unsupported protocol version".into(),
                )
            }
            Err(_) => { /* not a version token; leave proto as-is */ }
        }
    }
    // Optional AUTH / SETNAME sub-args.
    while i < a.len() {
        match as_str(&a[i]).to_ascii_uppercase().as_str() {
            "AUTH" if i + 2 < a.len() => {
                conn.authenticated = true;
                i += 3;
            }
            "SETNAME" if i + 1 < a.len() => {
                conn.name = Some(as_str(&a[i + 1]));
                i += 2;
            }
            _ => i += 1,
        }
    }
    hello_map(conn)
}

fn hello_map(conn: &Conn) -> Reply {
    let proto = match conn.proto {
        Proto::Resp2 => 2,
        Proto::Resp3 => 3,
    };
    Reply::Map(vec![
        (Reply::bulk_str("server"), Reply::bulk_str("redis")),
        (Reply::bulk_str("version"), Reply::bulk_str("7.4.0")),
        (Reply::bulk_str("proto"), Reply::Int(proto)),
        (Reply::bulk_str("id"), Reply::Int(1)),
        (Reply::bulk_str("mode"), Reply::bulk_str("standalone")),
        (Reply::bulk_str("role"), Reply::bulk_str("master")),
        (Reply::bulk_str("modules"), Reply::Array(vec![])),
    ])
}

fn cmd_auth(conn: &mut Conn, a: &[Bytes]) -> Reply {
    if a.is_empty() || a.len() > 2 {
        return Reply::Error("ERR wrong number of arguments for 'auth' command".into());
    }
    // The core accepts any AUTH and marks the conn authenticated. Whether a
    // password is actually required, and verification, is enforced by the
    // serving shell before dispatch (it knows the configured password). Here we
    // never reject, so a no-password server returns OK and a configured server
    // has already gated this path.
    conn.authenticated = true;
    Reply::ok()
}

fn cmd_select(conn: &mut Conn, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 1, 1, "select") {
        return e;
    }
    match parse_i64(&a[0]) {
        Ok(n) if n >= 0 => {
            conn.db = n;
            Reply::ok()
        }
        Ok(_) => Reply::Error("ERR DB index is out of range".into()),
        Err(e) => e,
    }
}

fn cmd_client(conn: &mut Conn, a: &[Bytes]) -> Reply {
    if a.is_empty() {
        return Reply::Error("ERR wrong number of arguments for 'client' command".into());
    }
    match as_str(&a[0]).to_ascii_uppercase().as_str() {
        "SETINFO" => Reply::ok(),
        "SETNAME" => {
            if a.len() >= 2 {
                conn.name = Some(as_str(&a[1]));
            }
            Reply::ok()
        }
        "GETNAME" => match &conn.name {
            Some(n) => Reply::bulk_str(n.clone()),
            None => Reply::Bulk(Bytes::new()),
        },
        "ID" => Reply::Int(1),
        "INFO" => Reply::bulk_str(format!(
            "id=1 addr=127.0.0.1:0 name={} db={}",
            conn.name.clone().unwrap_or_default(),
            conn.db
        )),
        "NO-EVICT" | "NO-TOUCH" | "REPLY" => Reply::ok(),
        other => Reply::Error(format!("ERR Unknown CLIENT subcommand '{other}'")),
    }
}

fn cmd_command(a: &[Bytes]) -> Reply {
    // Enough to satisfy clients that probe COMMAND on connect. We do not
    // enumerate the full command table.
    match a.first().map(|b| as_str(b).to_ascii_uppercase()) {
        Some(s) if s == "COUNT" => Reply::Int(0),
        Some(s) if s == "DOCS" => Reply::Map(vec![]),
        Some(s) if s == "INFO" => Reply::Array(vec![]),
        _ => Reply::Array(vec![]),
    }
}

fn cmd_config(a: &[Bytes]) -> Reply {
    if a.is_empty() {
        return Reply::Error("ERR wrong number of arguments for 'config' command".into());
    }
    match as_str(&a[0]).to_ascii_uppercase().as_str() {
        "GET" => {
            // Return a small known set; clients that probe maxmemory/save expect
            // a (possibly empty) map, never an error.
            let mut pairs = Vec::new();
            for key in a[1..].iter().map(as_str) {
                let val = match key.as_str() {
                    "maxmemory" => Some("0"),
                    "maxmemory-policy" => Some("noeviction"),
                    "save" => Some(""),
                    "appendonly" => Some("no"),
                    "timeout" => Some("0"),
                    _ => None,
                };
                if let Some(v) = val {
                    pairs.push((Reply::bulk_str(key), Reply::bulk_str(v)));
                }
            }
            Reply::Map(pairs)
        }
        "SET" => Reply::ok(),
        "RESETSTAT" | "REWRITE" => Reply::ok(),
        other => Reply::Error(format!("ERR Unknown CONFIG subcommand '{other}'")),
    }
}

fn cmd_info() -> Reply {
    let body = format!(
        "# Server\r\nredis_version:7.4.0\r\nredis_mode:standalone\r\n\
         terax_kv_name:{SERVER_NAME}\r\nterax_kv_version:{SERVER_VERSION}\r\n\
         # Clients\r\nconnected_clients:1\r\n\
         # Keyspace\r\n"
    );
    Reply::Bulk(Bytes::from(body))
}

// ---------------------------------------------------------------------------
// strings
// ---------------------------------------------------------------------------

fn cmd_get(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 1, 1, "get") {
        return e;
    }
    match store.get_str(&as_str(&a[0]), clock.now) {
        Some(Ok(b)) => Reply::Bulk(b),
        Some(Err(())) => wrongtype(),
        None => Reply::Nil,
    }
}

/// Parsed SET options.
struct SetOpts {
    expire_at: Option<Instant>,
    keep_ttl: bool,
    nx: bool,
    xx: bool,
    get: bool,
}

fn parse_set_opts(clock: Clock, a: &[Bytes]) -> Result<SetOpts, Reply> {
    let mut opts = SetOpts {
        expire_at: None,
        keep_ttl: false,
        nx: false,
        xx: false,
        get: false,
    };
    let mut i = 0;
    while i < a.len() {
        let tok = as_str(&a[i]).to_ascii_uppercase();
        match tok.as_str() {
            "EX" | "PX" | "EXAT" | "PXEXAT" => {
                let val = a
                    .get(i + 1)
                    .ok_or_else(|| Reply::Error("ERR syntax error".into()))?;
                let n = parse_i64(val)?;
                opts.expire_at = Some(match tok.as_str() {
                    "EX" => Store::deadline_in(clock.now, Duration::from_secs(n.max(0) as u64)),
                    "PX" => Store::deadline_in(clock.now, Duration::from_millis(n.max(0) as u64)),
                    "EXAT" => abs_deadline(clock, n.saturating_mul(1000)),
                    "PXEXAT" => abs_deadline(clock, n),
                    _ => unreachable!(),
                });
                i += 2;
            }
            "KEEPTTL" => {
                opts.keep_ttl = true;
                i += 1;
            }
            "NX" => {
                opts.nx = true;
                i += 1;
            }
            "XX" => {
                opts.xx = true;
                i += 1;
            }
            "GET" => {
                opts.get = true;
                i += 1;
            }
            _ => return Err(Reply::Error("ERR syntax error".into())),
        }
    }
    if opts.nx && opts.xx {
        return Err(Reply::Error("ERR syntax error".into()));
    }
    Ok(opts)
}

fn cmd_set(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 2, usize::MAX, "set") {
        return e;
    }
    let key = as_str(&a[0]);
    let val = a[1].clone();
    let opts = match parse_set_opts(clock, &a[2..]) {
        Ok(o) => o,
        Err(e) => return e,
    };

    // Capture the prior value first if GET was requested.
    let prior = if opts.get {
        match store.get_str(&key, clock.now) {
            Some(Ok(b)) => Some(b),
            Some(Err(())) => return wrongtype(),
            None => None,
        }
    } else {
        None
    };

    let applied = if opts.nx {
        store.set_str_nx(key.clone(), val, opts.expire_at, clock.now)
    } else if opts.xx {
        store.set_str_xx(key.clone(), val, opts.expire_at, opts.keep_ttl, clock.now)
    } else {
        store.set_str(key.clone(), val, opts.expire_at, opts.keep_ttl);
        true
    };

    if opts.get {
        return match prior {
            Some(b) => Reply::Bulk(b),
            None => Reply::Nil,
        };
    }
    if applied {
        Reply::ok()
    } else {
        // NX/XX condition not met.
        Reply::Nil
    }
}

fn cmd_setnx(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 2, 2, "setnx") {
        return e;
    }
    let set = store.set_str_nx(as_str(&a[0]), a[1].clone(), None, clock.now);
    Reply::Int(if set { 1 } else { 0 })
}

fn cmd_setex(store: &Store, clock: Clock, a: &[Bytes], ms: bool) -> Reply {
    let name = if ms { "psetex" } else { "setex" };
    if let Some(e) = arity(a, 3, 3, name) {
        return e;
    }
    let ttl = match parse_i64(&a[1]) {
        Ok(n) if n > 0 => n,
        Ok(_) => return Reply::Error(format!("ERR invalid expire time in '{name}' command")),
        Err(e) => return e,
    };
    let dur = if ms {
        Duration::from_millis(ttl as u64)
    } else {
        Duration::from_secs(ttl as u64)
    };
    store.set_str(
        as_str(&a[0]),
        a[2].clone(),
        Some(Store::deadline_in(clock.now, dur)),
        false,
    );
    Reply::ok()
}

fn cmd_getset(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 2, 2, "getset") {
        return e;
    }
    let key = as_str(&a[0]);
    let prior = match store.get_str(&key, clock.now) {
        Some(Ok(b)) => Some(b),
        Some(Err(())) => return wrongtype(),
        None => None,
    };
    store.set_str(key, a[1].clone(), None, false);
    match prior {
        Some(b) => Reply::Bulk(b),
        None => Reply::Nil,
    }
}

fn cmd_getdel(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 1, 1, "getdel") {
        return e;
    }
    let key = as_str(&a[0]);
    match store.get_str(&key, clock.now) {
        Some(Ok(b)) => {
            store.delete(&key, clock.now);
            Reply::Bulk(b)
        }
        Some(Err(())) => wrongtype(),
        None => Reply::Nil,
    }
}

fn cmd_append(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 2, 2, "append") {
        return e;
    }
    match store.append(&as_str(&a[0]), &a[1], clock.now) {
        Ok(len) => Reply::Int(len as i64),
        Err(()) => wrongtype(),
    }
}

fn cmd_strlen(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 1, 1, "strlen") {
        return e;
    }
    match store.get_str(&as_str(&a[0]), clock.now) {
        Some(Ok(b)) => Reply::Int(b.len() as i64),
        Some(Err(())) => wrongtype(),
        None => Reply::Int(0),
    }
}

fn cmd_mget(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 1, usize::MAX, "mget") {
        return e;
    }
    let items = a
        .iter()
        .map(|k| match store.get_str(&as_str(k), clock.now) {
            Some(Ok(b)) => Reply::Bulk(b),
            _ => Reply::Nil,
        })
        .collect();
    Reply::Array(items)
}

fn cmd_mset(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if a.is_empty() || !a.len().is_multiple_of(2) {
        return Reply::Error("ERR wrong number of arguments for 'mset' command".into());
    }
    let _ = clock;
    for pair in a.chunks_exact(2) {
        store.set_str(as_str(&pair[0]), pair[1].clone(), None, false);
    }
    Reply::ok()
}

/// `INCR`/`DECR` route here with a synthetic `[key, "1"]` argv.
fn cmd_incr_by(store: &Store, clock: Clock, a: &[Bytes], sign: i64) -> Reply {
    if let Some(e) = arity(a, 2, 2, if sign > 0 { "incr" } else { "decr" }) {
        return e;
    }
    apply_incr(store, clock, &as_str(&a[0]), sign)
}

fn cmd_incrby(store: &Store, clock: Clock, a: &[Bytes], sign: i64) -> Reply {
    if let Some(e) = arity(a, 2, 2, if sign > 0 { "incrby" } else { "decrby" }) {
        return e;
    }
    let delta = match parse_i64(&a[1]) {
        Ok(n) => n,
        Err(e) => return e,
    };
    apply_incr_delta(store, clock, &as_str(&a[0]), delta.saturating_mul(sign))
}

fn apply_incr(store: &Store, clock: Clock, key: &str, delta: i64) -> Reply {
    apply_incr_delta(store, clock, key, delta)
}

fn apply_incr_delta(store: &Store, clock: Clock, key: &str, delta: i64) -> Reply {
    match store.incr_by(key, delta, clock.now) {
        Ok(n) => Reply::Int(n),
        Err(IncrError::NotAnInteger) => {
            Reply::Error("ERR value is not an integer or out of range".into())
        }
        Err(IncrError::Overflow) => {
            Reply::Error("ERR increment or decrement would overflow".into())
        }
        Err(IncrError::WrongType) => wrongtype(),
    }
}

// ---------------------------------------------------------------------------
// generic keys
// ---------------------------------------------------------------------------

fn cmd_del(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 1, usize::MAX, "del") {
        return e;
    }
    let n = a
        .iter()
        .filter(|k| store.delete(&as_str(k), clock.now))
        .count();
    Reply::Int(n as i64)
}

fn cmd_exists(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 1, usize::MAX, "exists") {
        return e;
    }
    // EXISTS counts each occurrence (EXISTS k k == 2 if k present).
    let n = a
        .iter()
        .filter(|k| store.exists(&as_str(k), clock.now))
        .count();
    Reply::Int(n as i64)
}

fn cmd_type(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 1, 1, "type") {
        return e;
    }
    match store.type_name(&as_str(&a[0]), clock.now) {
        Some(t) => Reply::Simple(t.into()),
        None => Reply::Simple("none".into()),
    }
}

fn cmd_keys(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 1, 1, "keys") {
        return e;
    }
    let pat = as_str(&a[0]);
    let items = store
        .live_keys(clock.now)
        .into_iter()
        .filter(|k| glob_match(pat.as_bytes(), k.as_bytes()))
        .map(Reply::bulk_str)
        .collect();
    Reply::Array(items)
}

fn cmd_randomkey(store: &Store, clock: Clock) -> Reply {
    match store.live_keys(clock.now).into_iter().next() {
        Some(k) => Reply::bulk_str(k),
        None => Reply::Nil,
    }
}

/// `SCAN cursor [MATCH pat] [COUNT n] [TYPE t]`. We hold the whole keyspace in
/// memory, so we implement a deterministic single-shot scan: cursor 0 returns
/// all matching keys and a next-cursor of 0 (iteration complete). This is a
/// valid SCAN implementation (the contract only requires that a full iteration
/// from cursor 0 to cursor 0 visits every key present for the whole scan).
fn cmd_scan(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 1, usize::MAX, "scan") {
        return e;
    }
    // a[0] is the cursor; ignore its value beyond detecting completion.
    let cursor = parse_i64(&a[0]).unwrap_or(0);
    let mut pattern: Option<String> = None;
    let mut type_filter: Option<String> = None;
    let mut i = 1;
    while i < a.len() {
        match as_str(&a[i]).to_ascii_uppercase().as_str() {
            "MATCH" if i + 1 < a.len() => {
                pattern = Some(as_str(&a[i + 1]));
                i += 2;
            }
            "COUNT" if i + 1 < a.len() => {
                i += 2; // COUNT is advisory; we return everything in one shot.
            }
            "TYPE" if i + 1 < a.len() => {
                type_filter = Some(as_str(&a[i + 1]));
                i += 2;
            }
            _ => return Reply::Error("ERR syntax error".into()),
        }
    }
    // A non-zero cursor means a prior single-shot scan already returned all
    // keys; report completion with no further keys.
    if cursor != 0 {
        return Reply::Array(vec![Reply::bulk_str("0"), Reply::Array(vec![])]);
    }
    let keys: Vec<Reply> = store
        .live_keys(clock.now)
        .into_iter()
        .filter(|k| pattern.as_ref().map_or(true, |p| glob_match(p.as_bytes(), k.as_bytes())))
        .filter(|k| {
            type_filter.as_ref().map_or(true, |t| {
                store.type_name(k, clock.now).map_or(false, |kt| kt == t)
            })
        })
        .map(Reply::bulk_str)
        .collect();
    Reply::Array(vec![Reply::bulk_str("0"), Reply::Array(keys)])
}

// ---------------------------------------------------------------------------
// ttl
// ---------------------------------------------------------------------------

enum ExpireUnit {
    Sec,
    Ms,
}

fn abs_deadline(clock: Clock, abs_ms: i64) -> Instant {
    // Convert an absolute epoch-ms target to a monotonic deadline.
    let delta_ms = abs_ms - clock.epoch_ms;
    if delta_ms <= 0 {
        clock.now // already in the past -> immediate expiry
    } else {
        Store::deadline_in(clock.now, Duration::from_millis(delta_ms as u64))
    }
}

fn cmd_expire(store: &Store, clock: Clock, a: &[Bytes], unit: ExpireUnit, at: bool) -> Reply {
    if let Some(e) = arity(a, 2, 2, "expire") {
        return e;
    }
    let key = as_str(&a[0]);
    let n = match parse_i64(&a[1]) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let deadline = if at {
        let abs_ms = match unit {
            ExpireUnit::Sec => n.saturating_mul(1000),
            ExpireUnit::Ms => n,
        };
        abs_deadline(clock, abs_ms)
    } else {
        let dur = match unit {
            ExpireUnit::Sec => Duration::from_secs(n.max(0) as u64),
            ExpireUnit::Ms => Duration::from_millis(n.max(0) as u64),
        };
        Store::deadline_in(clock.now, dur)
    };
    let ok = store.set_expiry(&key, Some(deadline), clock.now);
    Reply::Int(if ok { 1 } else { 0 })
}

fn cmd_ttl(store: &Store, clock: Clock, a: &[Bytes], ms: bool) -> Reply {
    if let Some(e) = arity(a, 1, 1, "ttl") {
        return e;
    }
    match store.ttl(&as_str(&a[0]), clock.now) {
        TtlState::Missing => Reply::Int(-2),
        TtlState::NoExpiry => Reply::Int(-1),
        TtlState::Expiring(d) => {
            if ms {
                Reply::Int(d.as_millis() as i64)
            } else {
                // Round to nearest second like Redis.
                Reply::Int(((d.as_millis() + 500) / 1000) as i64)
            }
        }
    }
}

fn cmd_persist(store: &Store, clock: Clock, a: &[Bytes]) -> Reply {
    if let Some(e) = arity(a, 1, 1, "persist") {
        return e;
    }
    let key = as_str(&a[0]);
    // PERSIST returns 1 only if the key existed AND had a TTL that was removed.
    let had_ttl = matches!(store.ttl(&key, clock.now), TtlState::Expiring(_));
    if had_ttl {
        store.set_expiry(&key, None, clock.now);
        Reply::Int(1)
    } else {
        Reply::Int(0)
    }
}

fn cmd_expiretime(store: &Store, clock: Clock, a: &[Bytes], ms: bool) -> Reply {
    if let Some(e) = arity(a, 1, 1, "expiretime") {
        return e;
    }
    match store.ttl(&as_str(&a[0]), clock.now) {
        TtlState::Missing => Reply::Int(-2),
        TtlState::NoExpiry => Reply::Int(-1),
        TtlState::Expiring(d) => {
            let abs_ms = clock.epoch_ms + d.as_millis() as i64;
            if ms {
                Reply::Int(abs_ms)
            } else {
                Reply::Int(abs_ms / 1000)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// pub/sub
// ---------------------------------------------------------------------------

fn cmd_subscribe(conn: &mut Conn, a: &[Bytes], pattern: bool) -> Reply {
    if a.is_empty() {
        let name = if pattern { "psubscribe" } else { "subscribe" };
        return Reply::Error(format!("ERR wrong number of arguments for '{name}' command"));
    }
    let kind = if pattern { "psubscribe" } else { "subscribe" };
    let mut replies = Vec::new();
    for ch in a {
        let name = as_str(ch);
        if pattern {
            conn.patterns.insert(name.clone());
        } else {
            conn.channels.insert(name.clone());
        }
        replies.push(Reply::Push(vec![
            Reply::bulk_str(kind),
            Reply::bulk_str(name),
            Reply::Int(conn.subscription_count()),
        ]));
    }
    // One confirmation per channel. The serving loop writes each push frame.
    Reply::Array(replies)
}

fn cmd_unsubscribe(conn: &mut Conn, a: &[Bytes], pattern: bool) -> Reply {
    let kind = if pattern { "punsubscribe" } else { "unsubscribe" };
    let targets: Vec<String> = if a.is_empty() {
        // Unsubscribe from all.
        if pattern {
            conn.patterns.drain().collect()
        } else {
            conn.channels.drain().collect()
        }
    } else {
        let names: Vec<String> = a.iter().map(as_str).collect();
        for n in &names {
            if pattern {
                conn.patterns.remove(n);
            } else {
                conn.channels.remove(n);
            }
        }
        names
    };
    if targets.is_empty() {
        // Redis still sends one confirmation with a nil channel.
        return Reply::Array(vec![Reply::Push(vec![
            Reply::bulk_str(kind),
            Reply::Nil,
            Reply::Int(conn.subscription_count()),
        ])]);
    }
    let replies = targets
        .into_iter()
        .map(|n| {
            Reply::Push(vec![
                Reply::bulk_str(kind),
                Reply::bulk_str(n),
                Reply::Int(conn.subscription_count()),
            ])
        })
        .collect();
    Reply::Array(replies)
}

fn cmd_publish(pubsub: &dyn PubSub, a: &[Bytes]) -> Reply {
    if a.len() != 2 {
        return Reply::Error("ERR wrong number of arguments for 'publish' command".into());
    }
    let n = pubsub.publish(&as_str(&a[0]), a[1].clone());
    Reply::Int(n)
}

fn cmd_pubsub(pubsub: &dyn PubSub, a: &[Bytes]) -> Reply {
    if a.is_empty() {
        return Reply::Error("ERR wrong number of arguments for 'pubsub' command".into());
    }
    match as_str(&a[0]).to_ascii_uppercase().as_str() {
        "CHANNELS" => {
            let pat = a.get(1).map(as_str);
            let chans = pubsub.active_channels(pat.as_deref());
            Reply::Array(chans.into_iter().map(Reply::bulk_str).collect())
        }
        "NUMSUB" => {
            let mut pairs = Vec::new();
            for ch in &a[1..] {
                let name = as_str(ch);
                let n = pubsub.channel_subscribers(&name);
                pairs.push(Reply::bulk_str(name));
                pairs.push(Reply::Int(n));
            }
            Reply::Array(pairs)
        }
        "NUMPAT" => Reply::Int(pubsub.pattern_count()),
        other => Reply::Error(format!("ERR Unknown PUBSUB subcommand '{other}'")),
    }
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

fn wrongtype() -> Reply {
    Reply::Error("WRONGTYPE Operation against a key holding the wrong kind of value".into())
}

/// Redis-style glob matching for `KEYS`/`SCAN MATCH`/pattern subscriptions.
/// Supports `*`, `?`, `[...]` character classes (with ranges and `^` negation),
/// and `\` escaping. Operates on bytes (keys are binary-safe).
pub fn glob_match(pattern: &[u8], string: &[u8]) -> bool {
    glob_rec(pattern, string)
}

fn glob_rec(mut p: &[u8], mut s: &[u8]) -> bool {
    while let Some(&pc) = p.first() {
        match pc {
            b'*' => {
                // Collapse consecutive '*'.
                while p.first() == Some(&b'*') {
                    p = &p[1..];
                }
                if p.is_empty() {
                    return true;
                }
                // Try to match the rest at every suffix.
                loop {
                    if glob_rec(p, s) {
                        return true;
                    }
                    if s.is_empty() {
                        return false;
                    }
                    s = &s[1..];
                }
            }
            b'?' => {
                if s.is_empty() {
                    return false;
                }
                p = &p[1..];
                s = &s[1..];
            }
            b'[' => {
                if s.is_empty() {
                    return false;
                }
                let (matched, rest) = match_class(&p[1..], s[0]);
                if !matched {
                    return false;
                }
                p = rest;
                s = &s[1..];
            }
            b'\\' if p.len() >= 2 => {
                if s.is_empty() || s[0] != p[1] {
                    return false;
                }
                p = &p[2..];
                s = &s[1..];
            }
            c => {
                if s.is_empty() || s[0] != c {
                    return false;
                }
                p = &p[1..];
                s = &s[1..];
            }
        }
    }
    s.is_empty()
}

/// Match a `[...]` class against byte `c`. Returns (matched, pattern-after-`]`).
fn match_class(p: &[u8], c: u8) -> (bool, &[u8]) {
    let mut i = 0;
    let negate = p.first() == Some(&b'^');
    if negate {
        i += 1;
    }
    let mut matched = false;
    while i < p.len() && p[i] != b']' {
        if p[i] == b'\\' && i + 1 < p.len() {
            if p[i + 1] == c {
                matched = true;
            }
            i += 2;
        } else if i + 2 < p.len() && p[i + 1] == b'-' && p[i + 2] != b']' {
            let (lo, hi) = (p[i], p[i + 2]);
            if (lo..=hi).contains(&c) || (hi..=lo).contains(&c) {
                matched = true;
            }
            i += 3;
        } else {
            if p[i] == c {
                matched = true;
            }
            i += 1;
        }
    }
    // Skip the closing ']' if present.
    let rest = if i < p.len() { &p[i + 1..] } else { &p[i..] };
    (matched ^ negate, rest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kv::core::pubsub::NoopPubSub;
    use std::time::Instant;

    fn clk() -> Clock {
        Clock {
            now: Instant::now(),
            epoch_ms: 1_700_000_000_000,
        }
    }

    fn argv(parts: &[&str]) -> Vec<Bytes> {
        parts.iter().map(|p| Bytes::from(p.to_string())).collect()
    }

    fn run(store: &Store, conn: &mut Conn, parts: &[&str]) -> Reply {
        dispatch(store, conn, &NoopPubSub, clk(), &argv(parts)).reply
    }

    #[test]
    fn unknown_command_errors() {
        let s = Store::new();
        let mut c = Conn::new();
        match run(&s, &mut c, &["FLOOByDoo", "x"]) {
            Reply::Error(e) => assert!(e.contains("unknown command")),
            r => panic!("expected error, got {r:?}"),
        }
    }

    #[test]
    fn arity_error() {
        let s = Store::new();
        let mut c = Conn::new();
        match run(&s, &mut c, &["GET"]) {
            Reply::Error(e) => assert!(e.contains("wrong number of arguments")),
            r => panic!("expected arity error, got {r:?}"),
        }
    }

    #[test]
    fn ping_and_echo() {
        let s = Store::new();
        let mut c = Conn::new();
        assert!(matches!(run(&s, &mut c, &["PING"]), Reply::Simple(ref x) if x == "PONG"));
        assert!(matches!(run(&s, &mut c, &["PING", "hi"]), Reply::Bulk(ref b) if b == "hi"));
        assert!(matches!(run(&s, &mut c, &["ECHO", "yo"]), Reply::Bulk(ref b) if b == "yo"));
    }

    #[test]
    fn set_get_del() {
        let s = Store::new();
        let mut c = Conn::new();
        assert!(matches!(run(&s, &mut c, &["SET", "k", "v"]), Reply::Simple(_)));
        assert!(matches!(run(&s, &mut c, &["GET", "k"]), Reply::Bulk(ref b) if b == "v"));
        assert!(matches!(run(&s, &mut c, &["DEL", "k"]), Reply::Int(1)));
        assert!(matches!(run(&s, &mut c, &["GET", "k"]), Reply::Nil));
    }

    #[test]
    fn set_nx_xx() {
        let s = Store::new();
        let mut c = Conn::new();
        // NX on absent: set.
        assert!(matches!(run(&s, &mut c, &["SET", "k", "1", "NX"]), Reply::Simple(_)));
        // NX on present: nil.
        assert!(matches!(run(&s, &mut c, &["SET", "k", "2", "NX"]), Reply::Nil));
        // XX on present: set.
        assert!(matches!(run(&s, &mut c, &["SET", "k", "3", "XX"]), Reply::Simple(_)));
        assert!(matches!(run(&s, &mut c, &["GET", "k"]), Reply::Bulk(ref b) if b == "3"));
        // XX on absent: nil.
        assert!(matches!(run(&s, &mut c, &["SET", "absent", "1", "XX"]), Reply::Nil));
    }

    #[test]
    fn set_get_option_returns_prior() {
        let s = Store::new();
        let mut c = Conn::new();
        run(&s, &mut c, &["SET", "k", "old"]);
        assert!(matches!(run(&s, &mut c, &["SET", "k", "new", "GET"]), Reply::Bulk(ref b) if b == "old"));
        assert!(matches!(run(&s, &mut c, &["GET", "k"]), Reply::Bulk(ref b) if b == "new"));
    }

    #[test]
    fn incr_decr() {
        let s = Store::new();
        let mut c = Conn::new();
        assert!(matches!(run(&s, &mut c, &["INCR", "n"]), Reply::Int(1)));
        assert!(matches!(run(&s, &mut c, &["INCRBY", "n", "9"]), Reply::Int(10)));
        assert!(matches!(run(&s, &mut c, &["DECR", "n"]), Reply::Int(9)));
        assert!(matches!(run(&s, &mut c, &["DECRBY", "n", "4"]), Reply::Int(5)));
    }

    #[test]
    fn ttl_lifecycle() {
        let s = Store::new();
        let mut c = Conn::new();
        run(&s, &mut c, &["SET", "k", "v"]);
        assert!(matches!(run(&s, &mut c, &["TTL", "k"]), Reply::Int(-1)));
        assert!(matches!(run(&s, &mut c, &["EXPIRE", "k", "100"]), Reply::Int(1)));
        match run(&s, &mut c, &["TTL", "k"]) {
            Reply::Int(n) => assert!((99..=100).contains(&n)),
            r => panic!("{r:?}"),
        }
        assert!(matches!(run(&s, &mut c, &["PERSIST", "k"]), Reply::Int(1)));
        assert!(matches!(run(&s, &mut c, &["TTL", "k"]), Reply::Int(-1)));
        assert!(matches!(run(&s, &mut c, &["TTL", "missing"]), Reply::Int(-2)));
    }

    #[test]
    fn set_ex_sets_ttl() {
        let s = Store::new();
        let mut c = Conn::new();
        run(&s, &mut c, &["SET", "k", "v", "EX", "50"]);
        match run(&s, &mut c, &["TTL", "k"]) {
            Reply::Int(n) => assert!((49..=50).contains(&n)),
            r => panic!("{r:?}"),
        }
    }

    #[test]
    fn keys_and_type() {
        let s = Store::new();
        let mut c = Conn::new();
        run(&s, &mut c, &["SET", "foo", "1"]);
        run(&s, &mut c, &["SET", "bar", "1"]);
        run(&s, &mut c, &["SET", "baz", "1"]);
        if let Reply::Array(items) = run(&s, &mut c, &["KEYS", "ba*"]) {
            assert_eq!(items.len(), 2);
        } else {
            panic!("expected array");
        }
        assert!(matches!(run(&s, &mut c, &["TYPE", "foo"]), Reply::Simple(ref t) if t == "string"));
        assert!(matches!(run(&s, &mut c, &["TYPE", "nope"]), Reply::Simple(ref t) if t == "none"));
    }

    #[test]
    fn scan_single_shot() {
        let s = Store::new();
        let mut c = Conn::new();
        run(&s, &mut c, &["SET", "a", "1"]);
        run(&s, &mut c, &["SET", "b", "1"]);
        if let Reply::Array(parts) = run(&s, &mut c, &["SCAN", "0"]) {
            assert!(matches!(&parts[0], Reply::Bulk(b) if b == "0"));
            if let Reply::Array(keys) = &parts[1] {
                assert_eq!(keys.len(), 2);
            } else {
                panic!("expected keys array");
            }
        } else {
            panic!("expected scan array");
        }
    }

    #[test]
    fn hello_switches_proto() {
        let s = Store::new();
        let mut c = Conn::new();
        run(&s, &mut c, &["HELLO", "3"]);
        assert_eq!(c.proto, Proto::Resp3);
        run(&s, &mut c, &["HELLO", "2"]);
        assert_eq!(c.proto, Proto::Resp2);
    }

    #[test]
    fn client_setinfo_ok() {
        let s = Store::new();
        let mut c = Conn::new();
        assert!(matches!(run(&s, &mut c, &["CLIENT", "SETINFO", "lib-name", "ioredis"]), Reply::Simple(_)));
        assert!(matches!(run(&s, &mut c, &["CLIENT", "SETNAME", "app"]), Reply::Simple(_)));
        assert!(matches!(run(&s, &mut c, &["CLIENT", "GETNAME"]), Reply::Bulk(ref b) if b == "app"));
    }

    #[test]
    fn config_get_never_errors() {
        let s = Store::new();
        let mut c = Conn::new();
        assert!(matches!(run(&s, &mut c, &["CONFIG", "GET", "maxmemory"]), Reply::Map(_)));
        assert!(matches!(run(&s, &mut c, &["CONFIG", "GET", "nonexistent-param"]), Reply::Map(_)));
    }

    #[test]
    fn subscribe_tracks_interest() {
        let mut c = Conn::new();
        let s = Store::new();
        run(&s, &mut c, &["SUBSCRIBE", "ch1", "ch2"]);
        assert_eq!(c.subscription_count(), 2);
        run(&s, &mut c, &["UNSUBSCRIBE", "ch1"]);
        assert_eq!(c.subscription_count(), 1);
        run(&s, &mut c, &["UNSUBSCRIBE"]);
        assert_eq!(c.subscription_count(), 0);
    }

    #[test]
    fn glob_matching() {
        assert!(glob_match(b"*", b"anything"));
        assert!(glob_match(b"foo*", b"foobar"));
        assert!(glob_match(b"*bar", b"foobar"));
        assert!(glob_match(b"f?o", b"foo"));
        assert!(!glob_match(b"f?o", b"fooo"));
        assert!(glob_match(b"h[ae]llo", b"hello"));
        assert!(glob_match(b"h[ae]llo", b"hallo"));
        assert!(!glob_match(b"h[ae]llo", b"hillo"));
        assert!(glob_match(b"h[^x]llo", b"hello"));
        assert!(glob_match(b"key:[0-9]", b"key:5"));
        assert!(!glob_match(b"key:[0-9]", b"key:a"));
    }

    #[test]
    fn quit_closes() {
        let s = Store::new();
        let mut c = Conn::new();
        let d = dispatch(&s, &mut c, &NoopPubSub, clk(), &argv(&["QUIT"]));
        assert!(d.close);
    }

    #[test]
    fn wrongtype_not_triggered_for_strings() {
        // All Phase 1 values are strings, so WRONGTYPE never fires yet; this
        // guards that string ops on string keys succeed.
        let s = Store::new();
        let mut c = Conn::new();
        run(&s, &mut c, &["SET", "k", "v"]);
        assert!(matches!(run(&s, &mut c, &["APPEND", "k", "x"]), Reply::Int(2)));
        assert!(matches!(run(&s, &mut c, &["STRLEN", "k"]), Reply::Int(2)));
    }
}
