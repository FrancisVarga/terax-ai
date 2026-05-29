//! Claude Code session parser. Reads `~/.claude/projects/<slug>/<uuid>.jsonl`
//! transcripts — one JSON object per line. Lines are a mix of message records
//! and metadata (`last-prompt`, `permission-mode`, hook attachments); we parse
//! each line independently and keep only assistant/user message records, so a
//! malformed or unknown line never aborts the scan.

use super::{est_tokens_from_chars, Msg, Role, Source, SourceResult};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

/// Every `projects` dir Claude Code may write transcripts to, matching
/// ccusage's discovery: `$CLAUDE_CONFIG_DIR` (a `,`-separated list of config
/// roots) plus the default `~/.claude` and `~/.config/claude`. Returns only
/// dirs that exist, de-duplicated so an overlapping env var doesn't double-count.
fn projects_dirs() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        let dir = p.join("projects");
        if !roots.contains(&dir) {
            roots.push(dir);
        }
    };

    if let Ok(cfg) = std::env::var("CLAUDE_CONFIG_DIR") {
        for part in cfg.split(',') {
            let part = part.trim();
            if !part.is_empty() {
                push(PathBuf::from(part));
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        push(home.join(".claude"));
        push(home.join(".config").join("claude"));
    }

    roots.into_iter().filter(|d| d.is_dir()).collect()
}

pub fn scan() -> SourceResult {
    let mut messages = Vec::new();
    let mut session_ids = std::collections::HashSet::new();

    let dirs = projects_dirs();
    if dirs.is_empty() {
        return SourceResult {
            source: Source::Claude,
            messages,
            session_ids: Vec::new(),
            error: Some("no Claude config dir (~/.claude, ~/.config/claude, $CLAUDE_CONFIG_DIR)".into()),
        };
    }

    let mut files = Vec::new();
    for root in &dirs {
        collect_jsonl(root, &mut files);
    }

    for path in files {
        // The file stem is the session UUID; use it as a fallback session id.
        let file_session = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if let Some(msg) = parse_line(&v, &file_session) {
                session_ids.insert(msg.session_id.clone());
                messages.push(msg);
            }
        }
    }

    let error = if messages.is_empty() {
        Some("no Claude Code messages found".into())
    } else {
        None
    };

    SourceResult {
        source: Source::Claude,
        messages,
        session_ids: session_ids.into_iter().collect(),
        error,
    }
}

fn collect_jsonl(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn parse_line(v: &Value, file_session: &str) -> Option<Msg> {
    let message = v.get("message")?;
    let role_str = message.get("role").and_then(Value::as_str)?;
    let role = match role_str {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        _ => return None,
    };

    let session_id = v
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or(file_session)
        .to_string();

    let ts_ms = v
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(super::parse_iso8601_ms)
        .unwrap_or(0);

    let model = message
        .get("model")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty() && *m != "<synthetic>")
        .map(|s| s.to_string());

    // ccusage dedup keys: `message.id` + top-level `requestId`. costUSD is
    // sometimes baked into the line (sibling of `message`, occasionally nested);
    // captured for the ccusage `display`/`auto` cost modes.
    let message_id = message
        .get("id")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let request_id = v
        .get("requestId")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let cost_usd = v
        .get("costUSD")
        .or_else(|| message.get("costUSD"))
        .and_then(Value::as_f64);

    // Token usage. Cache reads/creations are real billed input, so fold them
    // into the input total. Assistant turns carry usage; user turns usually
    // don't (estimate from text instead).
    let usage = message.get("usage");
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut cache_read_tokens = 0u64;
    let mut cache_creation_tokens = 0u64;
    let mut tokens_known = false;
    if let Some(u) = usage {
        let get = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        // Keep cache tokens separate from fresh input: cache reads recur every
        // turn and would otherwise dominate the token count. Cost prices them
        // at their real (reduced) rates in the aggregator.
        input_tokens = get("input_tokens");
        cache_read_tokens = get("cache_read_input_tokens");
        cache_creation_tokens = get("cache_creation_input_tokens");
        output_tokens = get("output_tokens");
        tokens_known = input_tokens > 0
            || output_tokens > 0
            || cache_read_tokens > 0
            || cache_creation_tokens > 0;
    }

    // Walk content parts: collect text length (for estimation) and tool_use
    // names.
    let mut text_chars = 0usize;
    let mut tools = Vec::new();
    if let Some(parts) = message.get("content").and_then(Value::as_array) {
        for part in parts {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(t) = part.get("text").and_then(Value::as_str) {
                        text_chars += t.len();
                    }
                }
                Some("thinking") => {
                    if let Some(t) = part.get("thinking").and_then(Value::as_str) {
                        text_chars += t.len();
                    }
                }
                Some("tool_use") => {
                    if let Some(name) = part.get("name").and_then(Value::as_str) {
                        tools.push(name.to_string());
                    }
                }
                _ => {}
            }
        }
    } else if let Some(t) = message.get("content").and_then(Value::as_str) {
        // Some user lines store content as a bare string.
        text_chars += t.len();
    }

    if !tokens_known {
        // No real usage — estimate from text. Attribute to input for user
        // turns and output for assistant turns so the in/out split stays sane.
        let est = est_tokens_from_chars(text_chars);
        match role {
            Role::User => input_tokens = est,
            Role::Assistant => output_tokens = est,
        }
    }

    Some(Msg {
        source: Source::Claude,
        session_id,
        ts_ms,
        role,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        tokens_known,
        tools,
        message_id,
        request_id,
        cost_usd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_assistant_line_with_real_usage() {
        let line = serde_json::json!({
            "sessionId": "abc",
            "timestamp": "2026-05-06T11:05:57.330Z",
            "message": {
                "role": "assistant",
                "model": "claude-opus-4-7",
                "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "tool_use", "name": "Read"}
                ],
                "usage": {
                    "input_tokens": 6,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 65003,
                    "output_tokens": 553
                }
            }
        });
        let m = parse_line(&line, "file").unwrap();
        assert_eq!(m.role, Role::Assistant);
        assert_eq!(m.model.as_deref(), Some("claude-opus-4-7"));
        assert!(m.tokens_known);
        assert_eq!(m.input_tokens, 6); // fresh input only
        assert_eq!(m.cache_creation_tokens, 65003);
        assert_eq!(m.cache_read_tokens, 0);
        assert_eq!(m.output_tokens, 553);
        assert_eq!(m.tools, vec!["Read".to_string()]);
        assert_eq!(m.session_id, "abc");
    }

    #[test]
    fn estimates_user_line_without_usage() {
        let line = serde_json::json!({
            "timestamp": "2026-05-06T11:05:57Z",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "12345678"}]  // 8 chars -> 2 tokens
            }
        });
        let m = parse_line(&line, "filestem").unwrap();
        assert_eq!(m.role, Role::User);
        assert!(!m.tokens_known);
        assert_eq!(m.input_tokens, 2);
        assert_eq!(m.output_tokens, 0);
        assert_eq!(m.session_id, "filestem"); // fell back to file stem
    }

    #[test]
    fn skips_non_message_lines() {
        let meta = serde_json::json!({"type": "permission-mode", "permissionMode": "x"});
        assert!(parse_line(&meta, "f").is_none());
    }
}
