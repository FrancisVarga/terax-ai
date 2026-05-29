//! Cursor parser. Cursor stores chat in a SQLite DB at
//! `%APPDATA%/Cursor/User/globalStorage/state.vscdb` (or the platform
//! equivalent), table `cursorDiskKV`:
//!   - `composerData:<id>`            → one conversation (session) + createdAt
//!   - `bubbleId:<composerId>:<id>`   → one message bubble: `type` (1=user,
//!                                       2=assistant), `text`, `tokenCount`,
//!                                       `modelInfo`, `createdAt` (ISO)
//!
//! The DB is opened read-only with immutable=1 so a running Cursor holding a
//! write lock can't block the scan. Token counts are used when non-zero and
//! estimated from text otherwise. The schema is undocumented and version-
//! churning, so every field is treated as optional and unknown shapes are
//! skipped rather than failing the scan.

use super::{est_tokens_from_chars, Msg, Role, Source, SourceResult};
use rusqlite::OpenFlags;
use serde_json::Value;
use std::path::PathBuf;

/// Candidate global-storage DB locations across OSes and Cursor variants.
fn db_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let home = dirs::home_dir();

    // Windows: %APPDATA%\Cursor\User\globalStorage\state.vscdb
    if let Some(data) = dirs::config_dir() {
        out.push(
            data.join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        );
    }
    // macOS: ~/Library/Application Support/Cursor/...
    if let Some(h) = &home {
        out.push(
            h.join("Library")
                .join("Application Support")
                .join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        );
        // Linux: ~/.config/Cursor/...
        out.push(
            h.join(".config")
                .join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        );
    }
    out
}

pub fn scan() -> SourceResult {
    let Some(db) = db_candidates().into_iter().find(|p| p.is_file()) else {
        return result(Vec::new(), Vec::new(), Some("no Cursor state.vscdb found".into()));
    };

    match read_db(&db) {
        Ok((messages, sessions)) => {
            let error = if messages.is_empty() {
                Some("no Cursor conversations found".into())
            } else {
                None
            };
            result(messages, sessions, error)
        }
        Err(e) => result(Vec::new(), Vec::new(), Some(format!("Cursor db read failed: {e}"))),
    }
}

fn result(messages: Vec<Msg>, session_ids: Vec<String>, error: Option<String>) -> SourceResult {
    SourceResult { source: Source::Cursor, messages, session_ids, error }
}

fn read_db(path: &std::path::Path) -> rusqlite::Result<(Vec<Msg>, Vec<String>)> {
    // Read-only + immutable: never take a lock, tolerate a live Cursor.
    let uri = format!(
        "file:{}?mode=ro&immutable=1",
        path.to_string_lossy().replace('?', "%3f")
    );
    let conn = rusqlite::Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )?;

    let mut messages = Vec::new();
    let mut session_ids = std::collections::HashSet::new();

    // Sessions: one per composerData row.
    {
        let mut stmt =
            conn.prepare("SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%'")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for key in rows.flatten() {
            if let Some(id) = key.strip_prefix("composerData:") {
                session_ids.insert(id.to_string());
            }
        }
    }

    // Messages: one per bubbleId row.
    {
        let mut stmt =
            conn.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'")?;
        // `value` may be stored as TEXT or BLOB depending on Cursor version;
        // read it as a ValueRef and accept either, so a type mismatch can't
        // silently drop every row.
        let rows = stmt.query_map([], |r| {
            let key: String = r.get(0)?;
            let raw = r.get_ref(1)?;
            let text = match raw {
                rusqlite::types::ValueRef::Text(b) | rusqlite::types::ValueRef::Blob(b) => {
                    String::from_utf8_lossy(b).into_owned()
                }
                _ => String::new(),
            };
            Ok((key, text))
        })?;
        for row in rows.flatten() {
            let (key, text) = row;
            if text.is_empty() {
                continue;
            }
            let composer_id = key
                .strip_prefix("bubbleId:")
                .and_then(|rest| rest.split(':').next())
                .unwrap_or("cursor")
                .to_string();
            let Ok(v) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if let Some(m) = parse_bubble(&v, &composer_id) {
                session_ids.insert(composer_id);
                messages.push(m);
            }
        }
    }

    Ok((messages, session_ids.into_iter().collect()))
}

fn parse_bubble(v: &Value, composer_id: &str) -> Option<Msg> {
    // type: 1 = user, 2 = assistant. Anything else (e.g. tool/system) skipped.
    let role = match v.get("type").and_then(Value::as_u64) {
        Some(1) => Role::User,
        Some(2) => Role::Assistant,
        _ => return None,
    };

    let text = v.get("text").and_then(Value::as_str).unwrap_or("");

    // model from modelInfo.modelName / modelInfo.model when present.
    let model = v
        .get("modelInfo")
        .and_then(|mi| {
            mi.get("modelName")
                .or_else(|| mi.get("model"))
                .and_then(Value::as_str)
        })
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or(Some("cursor".to_string()));

    // Real token counts when non-zero; estimate from text otherwise.
    let tc = v.get("tokenCount");
    let real_in = tc.and_then(|t| t.get("inputTokens")).and_then(Value::as_u64).unwrap_or(0);
    let real_out = tc.and_then(|t| t.get("outputTokens")).and_then(Value::as_u64).unwrap_or(0);

    let (input_tokens, output_tokens, tokens_known) = if real_in > 0 || real_out > 0 {
        (real_in, real_out, true)
    } else {
        let est = est_tokens_from_chars(text.len());
        match role {
            Role::User => (est, 0, false),
            Role::Assistant => (0, est, false),
        }
    };

    let ts_ms = v
        .get("createdAt")
        .and_then(|c| c.as_i64().or_else(|| c.as_str().and_then(super::parse_iso8601_ms)))
        .unwrap_or(0);

    Some(Msg {
        source: Source::Cursor,
        session_id: composer_id.to_string(),
        ts_ms,
        role,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        tokens_known,
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
    fn parses_user_bubble_with_estimate() {
        let v = serde_json::json!({
            "type": 1,
            "text": "12345678",                  // 8 chars -> 2 tokens
            "tokenCount": {"inputTokens": 0, "outputTokens": 0},
            "createdAt": "2025-10-29T21:16:11.330Z"
        });
        let m = parse_bubble(&v, "comp1").unwrap();
        assert_eq!(m.role, Role::User);
        assert!(!m.tokens_known);
        assert_eq!(m.input_tokens, 2);
        assert_eq!(m.session_id, "comp1");
        assert!(m.ts_ms > 0);
    }

    #[test]
    fn parses_assistant_bubble_with_real_tokens_and_model() {
        let v = serde_json::json!({
            "type": 2,
            "text": "hi",
            "tokenCount": {"inputTokens": 1200, "outputTokens": 800},
            "modelInfo": {"modelName": "claude-sonnet-4-6"},
            "createdAt": 1761768721333i64
        });
        let m = parse_bubble(&v, "comp2").unwrap();
        assert_eq!(m.role, Role::Assistant);
        assert!(m.tokens_known);
        assert_eq!(m.input_tokens, 1200);
        assert_eq!(m.output_tokens, 800);
        assert_eq!(m.model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(m.ts_ms, 1761768721333);
    }

    #[test]
    fn skips_non_chat_bubble_types() {
        let v = serde_json::json!({"type": 3, "text": "tool"});
        assert!(parse_bubble(&v, "c").is_none());
    }
}
