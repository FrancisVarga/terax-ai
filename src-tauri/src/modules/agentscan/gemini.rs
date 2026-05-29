//! Gemini CLI session parser. The CLI persists conversation checkpoints under
//! `~/.gemini/tmp/<project-hash>/chats/*.json` as a JSON array of turns shaped
//! like `{ "role": "user" | "model", "parts": [{ "text": "..." }] }`. Token
//! usage is not persisted, so counts are estimated from text length.
//!
//! Layout varies across CLI versions and the Antigravity variant stores state
//! elsewhere; this parser reads what matches the documented shape and returns a
//! non-fatal note when nothing usable is found rather than failing the scan.

use super::{est_tokens_from_chars, Msg, Role, Source, SourceResult};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn tmp_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".gemini").join("tmp"))
}

pub fn scan() -> SourceResult {
    let mut messages = Vec::new();
    let mut session_ids = std::collections::HashSet::new();

    let Some(root) = tmp_dir() else {
        return result(messages, Vec::new(), Some("could not resolve home dir".into()));
    };
    if !root.is_dir() {
        return result(messages, Vec::new(), Some("no ~/.gemini/tmp directory".into()));
    }

    // Each immediate subdir is a project hash; chats live under `<hash>/chats`.
    let Ok(projects) = fs::read_dir(&root) else {
        return result(messages, Vec::new(), Some("could not read ~/.gemini/tmp".into()));
    };

    for proj in projects.flatten() {
        let proj_path = proj.path();
        if !proj_path.is_dir() {
            continue;
        }
        let chats = proj_path.join("chats");
        let mut json_files = Vec::new();
        if chats.is_dir() {
            collect_json(&chats, &mut json_files);
        }
        // Also consider a top-level logs.json some versions write.
        let logs = proj_path.join("logs.json");
        if logs.is_file() {
            json_files.push(logs);
        }

        // The project-hash dir is Gemini's per-workspace identity (one hash per
        // project root the CLI was launched from). Distinct hashes = distinct
        // workspaces, so usage is never merged across them.
        let workspace = dir_name(&proj_path);

        for file in json_files {
            let session_id = file
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| format!("{}/{}", workspace, s))
                .unwrap_or_else(|| workspace.clone());

            let Ok(content) = fs::read_to_string(&file) else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(&content) else {
                continue;
            };

            let turns = extract_turns(&v);
            let mut any = false;
            for turn in turns {
                if let Some(m) = parse_turn(turn, &session_id, &workspace) {
                    any = true;
                    messages.push(m);
                }
            }
            if any {
                session_ids.insert(session_id);
            }
        }
    }

    let error = if messages.is_empty() {
        Some("no Gemini CLI conversations found".into())
    } else {
        None
    };
    result(messages, session_ids.into_iter().collect(), error)
}

fn result(messages: Vec<Msg>, session_ids: Vec<String>, error: Option<String>) -> SourceResult {
    SourceResult { source: Source::Gemini, messages, session_ids, error }
}

fn dir_name(p: &std::path::Path) -> String {
    p.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("gemini")
        .to_string()
}

fn collect_json(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_json(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
            out.push(path);
        }
    }
}

/// A checkpoint file is usually a bare array of turns, but some versions wrap
/// it as `{ "messages": [...] }` or `{ "history": [...] }`. Normalize to a
/// slice of turn values.
fn extract_turns(v: &Value) -> Vec<&Value> {
    if let Some(arr) = v.as_array() {
        return arr.iter().collect();
    }
    for key in ["messages", "history", "turns"] {
        if let Some(arr) = v.get(key).and_then(Value::as_array) {
            return arr.iter().collect();
        }
    }
    Vec::new()
}

fn parse_turn(turn: &Value, session_id: &str, workspace: &str) -> Option<Msg> {
    let role_str = turn.get("role").and_then(Value::as_str)?;
    let role = match role_str {
        "user" => Role::User,
        // Gemini labels the assistant "model".
        "model" | "assistant" => Role::Assistant,
        _ => return None,
    };

    // Collect text from parts[].text, or a bare `text`/`content` string.
    let mut text_chars = 0usize;
    if let Some(parts) = turn.get("parts").and_then(Value::as_array) {
        for p in parts {
            if let Some(t) = p.get("text").and_then(Value::as_str) {
                text_chars += t.len();
            } else if let Some(t) = p.as_str() {
                text_chars += t.len();
            }
        }
    } else if let Some(t) = turn.get("text").and_then(Value::as_str) {
        text_chars += t.len();
    } else if let Some(t) = turn.get("content").and_then(Value::as_str) {
        text_chars += t.len();
    }

    let est = est_tokens_from_chars(text_chars);
    let (input_tokens, output_tokens) = match role {
        Role::User => (est, 0),
        Role::Assistant => (0, est),
    };

    // Timestamp if present (epoch-ms or ISO); default 0 (lands in oldest bucket
    // / excluded from streak rather than mis-dated to today).
    let ts_ms = turn
        .get("timestamp")
        .and_then(|t| t.as_i64().or_else(|| t.as_str().and_then(super::parse_iso8601_ms)))
        .unwrap_or(0);

    Some(Msg {
        source: Source::Gemini,
        workspace: workspace.to_string(),
        session_id: session_id.to_string(),
        ts_ms,
        role,
        model: Some("gemini".to_string()),
        input_tokens,
        output_tokens,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        tokens_known: false,
        tools: Vec::new(),
        message_id: None,
        request_id: None,
        cost_usd: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_array_turns() {
        let v = serde_json::json!([
            {"role": "user", "parts": [{"text": "12345678"}]},          // 8 -> 2 tok
            {"role": "model", "parts": [{"text": "abcdefghijkl"}]}       // 12 -> 3 tok
        ]);
        let turns = extract_turns(&v);
        assert_eq!(turns.len(), 2);
        let u = parse_turn(turns[0], "s", "proj-hash").unwrap();
        assert_eq!(u.role, Role::User);
        assert_eq!(u.input_tokens, 2);
        assert_eq!(u.workspace, "proj-hash");
        let a = parse_turn(turns[1], "s", "proj-hash").unwrap();
        assert_eq!(a.role, Role::Assistant);
        assert_eq!(a.output_tokens, 3);
        assert_eq!(a.model.as_deref(), Some("gemini"));
        assert!(!a.tokens_known);
    }

    #[test]
    fn unwraps_history_object() {
        let v = serde_json::json!({"history": [{"role": "user", "parts": [{"text": "x"}]}]});
        assert_eq!(extract_turns(&v).len(), 1);
    }

    #[test]
    fn ignores_unknown_role() {
        let t = serde_json::json!({"role": "system", "parts": [{"text": "x"}]});
        assert!(parse_turn(&t, "s", "ws").is_none());
    }
}
