//! In-pane `rmux msg` CLI (#139).
//!
//! This is the SECOND role of the `rmux-daemon` binary. A Claude Code / Codex
//! agent runs it INSIDE a pane's shell (`rmux-daemon msg ...`, surfaced as
//! `rmux msg ...`) to use the message bus WITHOUT the Terax UI — which is what
//! makes agent-to-agent messaging real. It is a thin client over the daemon's
//! existing loopback HTTP API (`/bus/publish`, `/pane/<id>/inbox`,
//! `/pane/<id>/inbox/ack`); it adds no server state.
//!
//! Self-identification: the daemon injects `RMUX_PANE_ID` and `RMUX_DAEMON_URL`
//! into every pane's environment at spawn (see `spawn_pane`). The CLI reads them
//! to know who it is and where the bus is. Outside an rmux pane those vars are
//! unset and every verb errors clearly.
//!
//! Transport: a tiny blocking `std::net::TcpStream` HTTP/1.1 client. The daemon
//! is always loopback (`http://127.0.0.1:<port>`, no TLS), and the CLI is a
//! short-lived one-shot process, so a hand-rolled request beats pulling
//! `reqwest` + a second tokio runtime into the daemon crate (it has neither
//! today, and keeping it dependency-light is a stated constraint).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::Value;

/// Poll interval for `rmux msg watch`. Short enough to feel live for an agent
/// loop, long enough that idle polling is cheap on the loopback daemon.
const WATCH_INTERVAL: Duration = Duration::from_millis(500);

/// Entry point for the `msg` subcommand. `args` is argv with the program name
/// AND the `msg` token already stripped (i.e. the verb is `args[0]`). Returns the
/// process exit code (0 ok, non-zero on error) so `main` can `exit` with it.
pub fn run_cli(args: &[String]) -> i32 {
    let verb = match args.first() {
        Some(v) => v.as_str(),
        None => {
            eprintln!("rmux msg: missing subcommand (send|recv|watch)");
            return 2;
        }
    };
    let rest = &args[1..];
    let result = match verb {
        "send" => cmd_send(rest),
        "recv" => cmd_recv(rest),
        "watch" => cmd_watch(rest),
        other => Err(format!("unknown subcommand '{other}' (expected send|recv|watch)")),
    };
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("rmux msg: {e}");
            1
        }
    }
}

/// Read `RMUX_DAEMON_URL` or fail with the "not inside an rmux pane" guidance.
/// Every verb needs the bus URL, so this is the shared gate.
fn daemon_url() -> Result<String, String> {
    std::env::var("RMUX_DAEMON_URL")
        .map_err(|_| "RMUX_DAEMON_URL unset — not inside an rmux pane".to_string())
}

/// Read `RMUX_PANE_ID` as the caller's own pane id. Used as the default `from`
/// (send) and as the inbox target (recv/watch). Fails with the same guidance.
fn pane_id() -> Result<u32, String> {
    let raw = std::env::var("RMUX_PANE_ID")
        .map_err(|_| "RMUX_PANE_ID unset — not inside an rmux pane".to_string())?;
    raw.parse::<u32>()
        .map_err(|_| format!("RMUX_PANE_ID is not a number: {raw}"))
}

/// Parse the `--to` value into the JSON shape the daemon's `resolve_targets`
/// expects. This is the routing grammar of the bus, mirrored client-side:
///   - a bare number `7`      -> `7`              (a pane id),
///   - `@session/<name>`      -> `{"session": name}`,
///   - `@window/<name>`       -> `{"window": name}`,
///   - `*`                    -> `"*"`             (broadcast to all panes).
///
/// Kept pure (string in, `Value` out, no I/O) so it is unit-testable without a
/// running daemon. An unrecognized form is an error rather than a silent pass so
/// a typo'd target surfaces at the CLI instead of resolving to nobody on the
/// daemon and looking like a delivery of 0.
fn parse_to(to: &str) -> Result<Value, String> {
    if to == "*" {
        return Ok(Value::from("*"));
    }
    if let Some(name) = to.strip_prefix("@session/") {
        if name.is_empty() {
            return Err("--to @session/<name> requires a name".to_string());
        }
        return Ok(serde_json::json!({ "session": name }));
    }
    if let Some(name) = to.strip_prefix("@window/") {
        if name.is_empty() {
            return Err("--to @window/<name> requires a name".to_string());
        }
        return Ok(serde_json::json!({ "window": name }));
    }
    if let Ok(n) = to.parse::<u32>() {
        return Ok(Value::from(n));
    }
    Err(format!(
        "unrecognized --to '{to}' (expected a pane id, @session/<name>, @window/<name>, or *)"
    ))
}

/// `rmux msg send --to <target> --type <t> [--inject] [--from <id>] [payload | -]`.
/// Builds a `/bus/publish` body and prints the delivered count. The payload is
/// the last positional arg: a JSON string, or `-` to read JSON from stdin; absent
/// means an empty-object payload.
fn cmd_send(args: &[String]) -> Result<(), String> {
    let mut to: Option<String> = None;
    let mut msg_type: Option<String> = None;
    let mut from: Option<u32> = None;
    let mut inject = false;
    let mut positional: Option<String> = None;

    // Hand-rolled flag parse (the crate intentionally avoids clap to stay
    // dependency-light, matching the daemon's no-arg-parsing posture).
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--to" => {
                to = Some(take_value(args, &mut i, "--to")?);
            }
            "--type" => {
                msg_type = Some(take_value(args, &mut i, "--type")?);
            }
            "--from" => {
                let v = take_value(args, &mut i, "--from")?;
                from = Some(v.parse::<u32>().map_err(|_| format!("--from not a number: {v}"))?);
            }
            "--inject" => inject = true,
            other => {
                if positional.is_some() {
                    return Err(format!("unexpected extra argument: {other}"));
                }
                positional = Some(other.to_string());
            }
        }
        i += 1;
    }

    let to = to.ok_or("send requires --to <target>")?;
    let msg_type = msg_type.ok_or("send requires --type <type>")?;
    let to_value = parse_to(&to)?;

    // `from` defaults to this pane's own id so an agent never has to know it.
    let from = match from {
        Some(f) => f,
        None => pane_id()?,
    };

    let payload = read_payload(positional.as_deref())?;

    let body = serde_json::json!({
        "from": from,
        "to": to_value,
        "type": msg_type,
        "payload": payload,
        "inject": inject,
    });

    let url = daemon_url()?;
    let resp = http_post_json(&url, "/bus/publish", &body)?;
    // The daemon answers `{ delivered, message_id }`; surface the count an agent
    // cares about, falling back to the raw body if the shape ever changes.
    let delivered = resp.get("delivered").and_then(Value::as_u64);
    match delivered {
        Some(n) => println!("delivered {n}"),
        None => println!("{resp}"),
    }
    Ok(())
}

/// `rmux msg recv [--ack]`. GETs this pane's inbox and prints each message as one
/// JSON line (JSONL). With `--ack`, drains the inbox after printing so the same
/// messages are not re-read next time.
fn cmd_recv(args: &[String]) -> Result<(), String> {
    let mut ack = false;
    for a in args {
        match a.as_str() {
            "--ack" => ack = true,
            other => return Err(format!("unexpected argument: {other}")),
        }
    }
    let url = daemon_url()?;
    let id = pane_id()?;
    let messages = fetch_inbox(&url, id)?;
    print_messages(&messages);
    if ack {
        // Ack-all: an empty object leaves `ids` unset (the daemon's InboxAckReq
        // has `#[serde(default)] ids`), which clears the whole inbox. We send `{}`
        // rather than a literal `null` body — the daemon only special-cases an
        // EMPTY body, and rejects a JSON `null` as a malformed InboxAckReq.
        http_post_json(&url, &format!("/pane/{id}/inbox/ack"), &serde_json::json!({}))?;
    }
    Ok(())
}

/// `rmux msg watch`. Long-polls this pane's inbox on `WATCH_INTERVAL`, printing
/// and acking new messages as they arrive — the loop an agent leaves running to
/// react to inbound bus traffic. Simple poll-then-ack: a message printed here is
/// acked immediately, so each is emitted exactly once across the run.
fn cmd_watch(args: &[String]) -> Result<(), String> {
    if let Some(a) = args.first() {
        return Err(format!("watch takes no arguments, got: {a}"));
    }
    let url = daemon_url()?;
    let id = pane_id()?;
    loop {
        let messages = fetch_inbox(&url, id)?;
        if !messages.is_empty() {
            print_messages(&messages);
            // Ack only the ids we just printed so a message that arrived between
            // the GET and the ack is not dropped unseen.
            let ids: Vec<u64> = messages
                .iter()
                .filter_map(|m| m.get("id").and_then(Value::as_u64))
                .collect();
            let body = serde_json::json!({ "ids": ids });
            http_post_json(&url, &format!("/pane/{id}/inbox/ack"), &body)?;
        }
        std::thread::sleep(WATCH_INTERVAL);
    }
}

/// GET `/pane/<id>/inbox` and return its `messages` array. A 404 means the pane
/// is gone; surface it rather than printing nothing and looking idle.
fn fetch_inbox(url: &str, id: u32) -> Result<Vec<Value>, String> {
    let resp = http_get_json(url, &format!("/pane/{id}/inbox"))?;
    let messages = resp
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(messages)
}

/// Print each message as one compact JSON line (JSONL) so a downstream agent can
/// read them line-by-line.
fn print_messages(messages: &[Value]) {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    for m in messages {
        let line = serde_json::to_string(m).unwrap_or_else(|_| "null".to_string());
        let _ = writeln!(lock, "{line}");
    }
    let _ = lock.flush();
}

/// Resolve the send payload: `None` -> empty object; `Some("-")` -> JSON from
/// stdin; `Some(s)` -> `s` parsed as JSON. Invalid JSON is an error so a malformed
/// payload fails loudly instead of shipping a string the recipient can't parse.
fn read_payload(positional: Option<&str>) -> Result<Value, String> {
    match positional {
        None => Ok(serde_json::json!({})),
        Some("-") => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|e| format!("read stdin: {e}"))?;
            serde_json::from_str(&buf).map_err(|e| format!("stdin is not valid JSON: {e}"))
        }
        Some(s) => serde_json::from_str(s).map_err(|e| format!("payload is not valid JSON: {e}")),
    }
}

/// Consume the value following a flag at `args[i]`, advancing `i` past it. Errors
/// if the flag is the last token (no value).
fn take_value(args: &[String], i: &mut usize, flag: &str) -> Result<String, String> {
    *i += 1;
    args.get(*i)
        .cloned()
        .ok_or_else(|| format!("{flag} requires a value"))
}

// ---------------------------------------------------------------------------
// Tiny blocking HTTP/1.1 client (loopback only, no TLS)
// ---------------------------------------------------------------------------

/// Split `http://host:port` into `(host, port)`. The daemon only ever emits this
/// exact shape, so the parser is deliberately strict: an `https`/path/garbage URL
/// is a real misconfiguration worth rejecting, not silently coercing.
fn parse_host_port(url: &str) -> Result<(String, u16), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("RMUX_DAEMON_URL must start with http:// — got {url}"))?;
    // Drop any trailing path; the daemon URL is host:port only, but be lenient.
    let authority = rest.split('/').next().unwrap_or(rest);
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| format!("RMUX_DAEMON_URL missing port: {url}"))?;
    let port = port
        .parse::<u16>()
        .map_err(|_| format!("RMUX_DAEMON_URL bad port: {url}"))?;
    Ok((host.to_string(), port))
}

fn http_get_json(url: &str, path: &str) -> Result<Value, String> {
    let raw = http_request(url, "GET", path, None)?;
    parse_json_body(&raw)
}

fn http_post_json(url: &str, path: &str, body: &Value) -> Result<Value, String> {
    let serialized = serde_json::to_vec(body).map_err(|e| format!("encode body: {e}"))?;
    let raw = http_request(url, "POST", path, Some(&serialized))?;
    parse_json_body(&raw)
}

/// One blocking HTTP/1.1 round-trip over a fresh loopback `TcpStream`. Sends the
/// request, reads the full response (the daemon closes or we read to EOF), and
/// returns the raw response bytes. Connection-per-request keeps this trivial — the
/// CLI makes at most a handful of calls per invocation.
fn http_request(
    url: &str,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let (host, port) = parse_host_port(url)?;
    let mut stream = TcpStream::connect((host.as_str(), port))
        .map_err(|e| format!("connect {host}:{port}: {e}"))?;
    // Bound the wait so a wedged daemon can't hang an agent's `watch` poll forever.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));

    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n"
    );
    if let Some(b) = body {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");

    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("write request: {e}"))?;
    if let Some(b) = body {
        stream.write_all(b).map_err(|e| format!("write body: {e}"))?;
    }
    stream.flush().ok();

    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|e| format!("read response: {e}"))?;
    Ok(buf)
}

/// Split an HTTP response into (status line, body), check the status, and parse
/// the body as JSON. We sent `Connection: close`, so the daemon's `Content-Length`
/// terminates the body and the socket EOFs — no chunked decoding needed.
fn parse_json_body(raw: &[u8]) -> Result<Value, String> {
    // Find the header/body split (CRLFCRLF).
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("malformed HTTP response (no header terminator)")?;
    let head = &raw[..split];
    let body = &raw[split + 4..];

    let head_str = String::from_utf8_lossy(head);
    let status_line = head_str.lines().next().unwrap_or("");
    // "HTTP/1.1 200 OK" -> the middle token is the status code.
    let code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| format!("malformed status line: {status_line}"))?;
    if !(200..300).contains(&code) {
        let msg = String::from_utf8_lossy(body);
        return Err(format!("daemon returned {code}: {}", msg.trim()));
    }
    if body.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(body).map_err(|e| {
        format!(
            "daemon response is not JSON: {e} (body: {})",
            String::from_utf8_lossy(body)
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_to_bare_number_is_pane_id() {
        assert_eq!(parse_to("7").unwrap(), Value::from(7u32));
    }

    #[test]
    fn parse_to_star_is_broadcast() {
        assert_eq!(parse_to("*").unwrap(), Value::from("*"));
    }

    #[test]
    fn parse_to_session_prefix_maps_to_object() {
        assert_eq!(
            parse_to("@session/work").unwrap(),
            serde_json::json!({ "session": "work" })
        );
    }

    #[test]
    fn parse_to_window_prefix_maps_to_object() {
        assert_eq!(
            parse_to("@window/left").unwrap(),
            serde_json::json!({ "window": "left" })
        );
    }

    #[test]
    fn parse_to_session_name_can_contain_slashes() {
        // strip_prefix only removes the FIRST "@session/", so the remainder
        // (including any further slashes) is the literal session name.
        assert_eq!(
            parse_to("@session/a/b").unwrap(),
            serde_json::json!({ "session": "a/b" })
        );
    }

    #[test]
    fn parse_to_empty_session_name_is_error() {
        assert!(parse_to("@session/").is_err());
        assert!(parse_to("@window/").is_err());
    }

    #[test]
    fn parse_to_garbage_is_error() {
        assert!(parse_to("not-a-target").is_err());
        assert!(parse_to("@group/x").is_err());
        assert!(parse_to("").is_err());
    }

    #[test]
    fn parse_host_port_splits_loopback_url() {
        assert_eq!(
            parse_host_port("http://127.0.0.1:54321").unwrap(),
            ("127.0.0.1".to_string(), 54321)
        );
    }

    #[test]
    fn parse_host_port_tolerates_trailing_path() {
        assert_eq!(
            parse_host_port("http://127.0.0.1:8080/").unwrap(),
            ("127.0.0.1".to_string(), 8080)
        );
    }

    #[test]
    fn parse_host_port_rejects_non_http() {
        assert!(parse_host_port("https://127.0.0.1:443").is_err());
        assert!(parse_host_port("127.0.0.1:80").is_err());
        assert!(parse_host_port("http://127.0.0.1").is_err());
    }

    #[test]
    fn read_payload_defaults_to_empty_object() {
        assert_eq!(read_payload(None).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn read_payload_parses_json_string() {
        assert_eq!(
            read_payload(Some(r#"{"k":1}"#)).unwrap(),
            serde_json::json!({ "k": 1 })
        );
    }

    #[test]
    fn read_payload_rejects_bad_json() {
        assert!(read_payload(Some("{not json")).is_err());
    }

    #[test]
    fn run_cli_unknown_verb_is_error_code() {
        assert_eq!(run_cli(&["bogus".to_string()]), 1);
    }

    #[test]
    fn run_cli_missing_verb_is_usage_error() {
        assert_eq!(run_cli(&[]), 2);
    }
}
