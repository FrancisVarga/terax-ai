//! On-disk AI coding-agent analytics — the real-data analog of agentlytics
//! (github.com/f/agentlytics). Rather than reading this app's own chat store,
//! these scanners walk the session files that external coding agents leave on
//! disk (Claude Code JSONL, Gemini CLI checkpoints, Cursor's SQLite store) and
//! aggregate them into one dashboard payload. Everything stays local; nothing
//! is uploaded.
//!
//! Each source parser is responsible only for turning its on-disk format into a
//! stream of normalized [`Msg`] records. All bucketing, pricing, streak, and
//! top-N logic lives here in [`aggregate`] so adding a new source is one more
//! parser, not another copy of the math.

mod claude;
mod cursor;
mod gemini;

use serde::Serialize;
use std::collections::HashMap;

/// A single normalized message from any source. Parsers fill what they can;
/// missing token counts are signalled by `tokens_known = false` so the
/// aggregator can fall back to a chars→tokens estimate without double-counting
/// real usage.
#[derive(Clone, Debug)]
pub struct Msg {
    pub source: Source,
    pub session_id: String,
    /// Unix epoch milliseconds. Parsers that lack per-message timestamps
    /// attribute the message to its session/file time.
    pub ts_ms: i64,
    pub role: Role,
    pub model: Option<String>,
    /// Fresh (non-cached) input tokens.
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Cached input read back this turn. Billed cheaply (~0.1× input) and kept
    /// separate so it doesn't inflate the headline token count — across a long
    /// session the same cached context is re-read every turn.
    pub cache_read_tokens: u64,
    /// Tokens written into the prompt cache (billed ~1.25× input).
    pub cache_creation_tokens: u64,
    /// True when token fields came from real usage data, false when estimated
    /// from text length.
    pub tokens_known: bool,
    /// Tool names invoked in this message (assistant tool calls).
    pub tools: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Claude,
    Gemini,
    Cursor,
}

impl Source {
    fn key(self) -> &'static str {
        match self {
            Source::Claude => "claude",
            Source::Gemini => "gemini",
            Source::Cursor => "cursor",
        }
    }
}

/// ~4 chars per token, the same rough proxy agentlytics uses when a source
/// doesn't persist real counts.
const CHARS_PER_TOKEN: u64 = 4;

pub fn est_tokens_from_chars(chars: usize) -> u64 {
    (chars as u64) / CHARS_PER_TOKEN
}

const DAILY_WINDOW: i64 = 90;
const MS_PER_DAY: i64 = 86_400_000;

/// Per-model pricing in USD per 1M tokens, `(input, output)`. Matched by
/// case-insensitive substring so versioned ids (`claude-opus-4-7`,
/// `gpt-5.2-codex`) hit the right family. Unknown models fall back to
/// [`BLENDED_PER_1M`].
const PRICING: &[(&str, f64, f64)] = &[
    ("claude-opus", 15.0, 75.0),
    ("claude-sonnet", 3.0, 15.0),
    ("claude-haiku", 0.80, 4.0),
    ("opus", 15.0, 75.0),
    ("sonnet", 3.0, 15.0),
    ("haiku", 0.80, 4.0),
    ("gpt-5", 1.25, 10.0),
    ("gpt-4o", 2.50, 10.0),
    ("o3", 2.0, 8.0),
    ("gemini-2.5-pro", 1.25, 10.0),
    ("gemini-2.5-flash", 0.30, 2.50),
    ("gemini-1.5-pro", 1.25, 5.0),
    ("gemini", 0.30, 2.50),
];

/// Blended USD per 1M tokens for unknown models (one rate for in+out).
const BLENDED_PER_1M: f64 = 5.0;

/// Cache read/creation pricing as a multiple of the model's input rate, the
/// ratios Anthropic and others bill at: a cache read is ~10% of base input, a
/// cache write ~125%.
const CACHE_READ_MULT: f64 = 0.10;
const CACHE_CREATE_MULT: f64 = 1.25;

fn cost_usd(model: Option<&str>, m: &Msg) -> f64 {
    let (pin, pout) = price_for(model);
    (m.input_tokens as f64 / 1_000_000.0) * pin
        + (m.output_tokens as f64 / 1_000_000.0) * pout
        + (m.cache_read_tokens as f64 / 1_000_000.0) * pin * CACHE_READ_MULT
        + (m.cache_creation_tokens as f64 / 1_000_000.0) * pin * CACHE_CREATE_MULT
}

/// `(input, output)` USD per 1M tokens for a model id, blended fallback.
fn price_for(model: Option<&str>) -> (f64, f64) {
    if let Some(m) = model {
        let lower = m.to_ascii_lowercase();
        for (needle, pin, pout) in PRICING {
            if lower.contains(needle) {
                return (*pin, *pout);
            }
        }
    }
    (BLENDED_PER_1M, BLENDED_PER_1M)
}

#[derive(Serialize, Default)]
pub struct ModelUsage {
    pub model: String,
    pub messages: u64,
    #[serde(rename = "estTokens")]
    pub est_tokens: u64,
}

#[derive(Serialize)]
pub struct ToolUsage {
    pub tool: String,
    pub calls: u64,
}

#[derive(Serialize)]
pub struct DayActivity {
    pub day: String,
    pub sessions: u64,
    pub messages: u64,
    #[serde(rename = "estTokens")]
    pub est_tokens: u64,
}

#[derive(Serialize, Default)]
pub struct SourceBreakdown {
    pub source: String,
    pub sessions: u64,
    pub messages: u64,
    #[serde(rename = "estTokens")]
    pub est_tokens: u64,
    /// Non-fatal note when a source couldn't be read (missing dir, locked db).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Matches the frontend `Analytics` type field-for-field (camelCase via serde
/// rename) so the existing dashboard renders unchanged.
#[derive(Serialize)]
pub struct Analytics {
    #[serde(rename = "totalSessions")]
    pub total_sessions: u64,
    #[serde(rename = "totalMessages")]
    pub total_messages: u64,
    #[serde(rename = "userMessages")]
    pub user_messages: u64,
    #[serde(rename = "assistantMessages")]
    pub assistant_messages: u64,
    #[serde(rename = "estTokens")]
    pub est_tokens: u64,
    #[serde(rename = "estInputTokens")]
    pub est_input_tokens: u64,
    #[serde(rename = "estOutputTokens")]
    pub est_output_tokens: u64,
    #[serde(rename = "estCostUsd")]
    pub est_cost_usd: f64,
    #[serde(rename = "toolCalls")]
    pub tool_calls: u64,
    #[serde(rename = "streakDays")]
    pub streak_days: u64,
    #[serde(rename = "topModels")]
    pub top_models: Vec<ModelUsage>,
    #[serde(rename = "topTools")]
    pub top_tools: Vec<ToolUsage>,
    pub daily: Vec<DayActivity>,
    #[serde(rename = "peakHour")]
    pub peak_hour: Option<u8>,
    pub hourly: Vec<u64>,
    /// Per-source rollup so the UI can show what each agent contributed.
    pub sources: Vec<SourceBreakdown>,
}

fn empty_analytics(now_ms: i64, tz_offset_ms: i64) -> Analytics {
    Analytics {
        total_sessions: 0,
        total_messages: 0,
        user_messages: 0,
        assistant_messages: 0,
        est_tokens: 0,
        est_input_tokens: 0,
        est_output_tokens: 0,
        est_cost_usd: 0.0,
        tool_calls: 0,
        streak_days: 0,
        top_models: Vec::new(),
        top_tools: Vec::new(),
        daily: fill_daily(&HashMap::new(), now_ms, tz_offset_ms),
        peak_hour: None,
        hourly: vec![0; 24],
        sources: Vec::new(),
    }
}

/// Local `YYYY-MM-DD` for an epoch-ms instant. Uses a fixed-offset day bucket
/// derived from the host's current UTC offset so chart days line up with the
/// user's wall clock without pulling in chrono.
fn day_key(ts_ms: i64, tz_offset_ms: i64) -> String {
    let local = ts_ms + tz_offset_ms;
    let days = local.div_euclid(MS_PER_DAY);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn hour_of(ts_ms: i64, tz_offset_ms: i64) -> usize {
    let local = ts_ms + tz_offset_ms;
    let ms_in_day = local.rem_euclid(MS_PER_DAY);
    (ms_in_day / 3_600_000) as usize
}

/// Howard Hinnant's days-from-civil inverse (public-domain algorithm). Avoids a
/// date crate for the only calendar math we need.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn fill_daily(
    day_map: &HashMap<String, DayActivity>,
    now_ms: i64,
    tz_offset_ms: i64,
) -> Vec<DayActivity> {
    let today_local_days = (now_ms + tz_offset_ms).div_euclid(MS_PER_DAY);
    let mut out = Vec::with_capacity(DAILY_WINDOW as usize);
    for i in (0..DAILY_WINDOW).rev() {
        let day_idx = today_local_days - i;
        let (y, m, d) = civil_from_days(day_idx);
        let key = format!("{y:04}-{m:02}-{d:02}");
        if let Some(b) = day_map.get(&key) {
            out.push(DayActivity {
                day: key,
                sessions: b.sessions,
                messages: b.messages,
                est_tokens: b.est_tokens,
            });
        } else {
            out.push(DayActivity { day: key, sessions: 0, messages: 0, est_tokens: 0 });
        }
    }
    out
}

/// Minimal ISO-8601 → epoch-ms parser for the `YYYY-MM-DDTHH:MM:SS(.fff)?Z`
/// shape agent transcripts write. Returns None on anything unrecognized rather
/// than guessing. Treats the instant as UTC.
pub(super) fn parse_iso8601_ms(s: &str) -> Option<i64> {
    if s.len() < 19 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;

    let mut millis: i64 = 0;
    if let Some(dot) = s.find('.') {
        let frac: String = s[dot + 1..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .take(3)
            .collect();
        if !frac.is_empty() {
            millis = format!("{frac:0<3}").parse().unwrap_or(0);
        }
    }

    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + min * 60 + sec;
    Some(secs * 1000 + millis)
}

/// Howard Hinnant's days-from-civil (epoch 1970-01-01 = 0).
pub(super) fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Result of parsing one source: its messages plus an optional non-fatal error
/// to surface in the breakdown (e.g. "no Claude sessions found").
pub struct SourceResult {
    pub source: Source,
    pub messages: Vec<Msg>,
    pub session_ids: Vec<String>,
    pub error: Option<String>,
}

fn aggregate(results: Vec<SourceResult>, now_ms: i64, tz_offset_ms: i64) -> Analytics {
    let mut out = empty_analytics(now_ms, tz_offset_ms);

    let mut model_map: HashMap<String, ModelUsage> = HashMap::new();
    let mut tool_map: HashMap<String, u64> = HashMap::new();
    let mut day_map: HashMap<String, DayActivity> = HashMap::new();
    let mut session_days: HashMap<String, ()> = HashMap::new();
    let mut active_days: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut hourly = vec![0u64; 24];

    let mut total_sessions = 0u64;

    for res in &results {
        let mut sb = SourceBreakdown {
            source: res.source.key().to_string(),
            error: res.error.clone(),
            ..Default::default()
        };

        // Count sessions (dedup ids defensively).
        let mut seen_sessions = std::collections::HashSet::new();
        for sid in &res.session_ids {
            if seen_sessions.insert(sid.clone()) {
                sb.sessions += 1;
            }
        }
        total_sessions += sb.sessions;

        for m in &res.messages {
            out.total_messages += 1;
            sb.messages += 1;

            let in_tok = m.input_tokens;
            let out_tok = m.output_tokens;
            // Headline token count is fresh input + output only; cache reads are
            // deliberately excluded so a long session's repeated cache reads
            // don't balloon the total. Cost still bills cache at its real rate.
            let tokens = in_tok + out_tok;
            out.est_tokens += tokens;
            sb.est_tokens += tokens;
            out.est_input_tokens += in_tok;
            out.est_output_tokens += out_tok;
            out.est_cost_usd += cost_usd(m.model.as_deref(), m);

            let key = day_key(m.ts_ms, tz_offset_ms);
            active_days.insert(key.clone());
            // Attribute one session-open per (session, day) the first time we
            // see that pair, so the daily chart's session count is meaningful.
            let sd_key = format!("{}|{}", m.session_id, key);
            let day = day_map.entry(key.clone()).or_insert_with(|| DayActivity {
                day: key.clone(),
                sessions: 0,
                messages: 0,
                est_tokens: 0,
            });
            if session_days.insert(sd_key, ()).is_none() {
                day.sessions += 1;
            }
            day.messages += 1;
            day.est_tokens += tokens;

            hourly[hour_of(m.ts_ms, tz_offset_ms)] += 1;

            match m.role {
                Role::User => out.user_messages += 1,
                Role::Assistant => {
                    out.assistant_messages += 1;
                    let model = m.model.clone().unwrap_or_else(|| "unknown".to_string());
                    let mu = model_map.entry(model.clone()).or_insert_with(|| ModelUsage {
                        model,
                        messages: 0,
                        est_tokens: 0,
                    });
                    mu.messages += 1;
                    mu.est_tokens += tokens;
                }
            }

            for t in &m.tools {
                out.tool_calls += 1;
                *tool_map.entry(t.clone()).or_insert(0) += 1;
            }
        }

        out.sources.push(sb);
    }

    out.total_sessions = total_sessions;
    out.hourly = hourly.clone();

    // Peak hour: highest count, None when no activity.
    let mut peak_hour: Option<u8> = None;
    let mut peak_count = 0u64;
    for (h, &c) in hourly.iter().enumerate() {
        if c > peak_count {
            peak_count = c;
            peak_hour = Some(h as u8);
        }
    }
    out.peak_hour = peak_hour;

    // Streak: consecutive active days ending today (local).
    let today_local_days = (now_ms + tz_offset_ms).div_euclid(MS_PER_DAY);
    let mut streak = 0u64;
    let mut cursor = today_local_days;
    loop {
        let (y, m, d) = civil_from_days(cursor);
        let key = format!("{y:04}-{m:02}-{d:02}");
        if active_days.contains(&key) {
            streak += 1;
            cursor -= 1;
        } else {
            break;
        }
    }
    out.streak_days = streak;

    let mut models: Vec<ModelUsage> = model_map.into_values().collect();
    models.sort_by(|a, b| b.est_tokens.cmp(&a.est_tokens));
    models.truncate(6);
    out.top_models = models;

    let mut tools: Vec<ToolUsage> = tool_map
        .into_iter()
        .map(|(tool, calls)| ToolUsage { tool, calls })
        .collect();
    tools.sort_by(|a, b| b.calls.cmp(&a.calls));
    tools.truncate(8);
    out.top_tools = tools;

    out.daily = fill_daily(&day_map, now_ms, tz_offset_ms);

    out
}

/// Scan all supported agent session sources and return aggregated analytics.
///
/// `now_ms` and `tz_offset_ms` are supplied by the frontend (the webview owns
/// the user's clock and timezone) so day/hour bucketing matches the dashboard's
/// calendar without a date crate or platform TZ probing in Rust.
#[tauri::command]
pub fn agentscan_collect(now_ms: i64, tz_offset_ms: i64) -> Analytics {
    let results = vec![
        claude::scan(),
        gemini::scan(),
        cursor::scan(),
    ];
    aggregate(results, now_ms, tz_offset_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(source: Source, sid: &str, ts: i64, role: Role, model: &str, i: u64, o: u64) -> Msg {
        Msg {
            source,
            session_id: sid.to_string(),
            ts_ms: ts,
            role,
            model: Some(model.to_string()),
            input_tokens: i,
            output_tokens: o,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            tokens_known: true,
            tools: Vec::new(),
        }
    }

    // Live smoke test against this machine's real agent session data. Ignored
    // by default (machine-dependent); run with `cargo test live_scan -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_scan() {
        let a = agentscan_collect(1_900_000_000_000, 0);
        eprintln!(
            "sessions={} messages={} estTokens={} cost=${:.4} tools={}",
            a.total_sessions, a.total_messages, a.est_tokens, a.est_cost_usd, a.tool_calls
        );
        for s in &a.sources {
            eprintln!(
                "  [{}] sessions={} messages={} tokens={} err={:?}",
                s.source, s.sessions, s.messages, s.est_tokens, s.error
            );
        }
        for m in a.top_models.iter().take(5) {
            eprintln!("  model {} -> {} tok / {} msg", m.model, m.est_tokens, m.messages);
        }
    }

    #[test]
    fn civil_from_days_epoch() {
        // 1970-01-01 is day 0.
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(31), (1970, 2, 1));
    }

    #[test]
    fn pricing_matches_family_and_falls_back() {
        assert_eq!(price_for(Some("claude-opus-4-7")), (15.0, 75.0));
        assert_eq!(price_for(Some("some-random-model")), (BLENDED_PER_1M, BLENDED_PER_1M));
        assert_eq!(price_for(None), (BLENDED_PER_1M, BLENDED_PER_1M));
    }

    #[test]
    fn cost_includes_cache_at_reduced_rates() {
        // Opus input $15/1M: 1M fresh in + 1M out + 1M cache-read + 1M cache-create.
        let mut m = msg(Source::Claude, "s", 0, Role::Assistant, "claude-opus-4-7", 1_000_000, 1_000_000);
        m.cache_read_tokens = 1_000_000;
        m.cache_creation_tokens = 1_000_000;
        // 15 (in) + 75 (out) + 15*0.10 (read) + 15*1.25 (create) = 15+75+1.5+18.75
        let c = cost_usd(m.model.as_deref(), &m);
        assert!((c - 110.25).abs() < 1e-6, "got {c}");
    }

    #[test]
    fn aggregate_rolls_up_sources_models_and_tools() {
        let mut a = msg(Source::Claude, "s1", 1_700_000_000_000, Role::Assistant, "claude-opus-4-7", 100, 200);
        a.tools = vec!["Read".into(), "Edit".into()];
        let u = msg(Source::Claude, "s1", 1_700_000_000_000, Role::User, "claude-opus-4-7", 50, 0);
        let g = msg(Source::Gemini, "g1", 1_700_000_000_000, Role::Assistant, "gemini-2.5-pro", 10, 20);

        let results = vec![
            SourceResult {
                source: Source::Claude,
                messages: vec![a, u],
                session_ids: vec!["s1".into()],
                error: None,
            },
            SourceResult {
                source: Source::Gemini,
                messages: vec![g],
                session_ids: vec!["g1".into()],
                error: Some("partial".into()),
            },
            SourceResult {
                source: Source::Cursor,
                messages: vec![],
                session_ids: vec![],
                error: Some("no db".into()),
            },
        ];
        let out = aggregate(results, 1_700_100_000_000, 0);

        assert_eq!(out.total_sessions, 2);
        assert_eq!(out.total_messages, 3);
        assert_eq!(out.user_messages, 1);
        assert_eq!(out.assistant_messages, 2);
        assert_eq!(out.est_tokens, 100 + 200 + 50 + 10 + 20);
        assert_eq!(out.tool_calls, 2);
        assert_eq!(out.top_models.len(), 2);
        // Opus assistant had more tokens, so it ranks first.
        assert_eq!(out.top_models[0].model, "claude-opus-4-7");
        assert_eq!(out.top_tools.len(), 2);
        assert_eq!(out.sources.len(), 3);
        let cursor_sb = out.sources.iter().find(|s| s.source == "cursor").unwrap();
        assert_eq!(cursor_sb.error.as_deref(), Some("no db"));
        assert_eq!(out.daily.len(), DAILY_WINDOW as usize);
    }
}
