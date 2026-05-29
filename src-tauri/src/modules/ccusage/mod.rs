//! ccusage-faithful token/cost reports over on-disk coding-agent transcripts.
//!
//! This is the desktop analog of the `ccusage` CLI (github.com/ryoppippi/ccusage):
//! it reuses agentscan's on-disk parsers (so file I/O lives in exactly one place)
//! and re-aggregates the normalized [`Msg`](crate::modules::agentscan::Msg) stream
//! into ccusage's report shapes — deduped daily / weekly / monthly / session
//! tables plus Claude's rolling **5-hour billing blocks** with a live burn rate.
//!
//! What makes it "ccusage-faithful" rather than the agentlytics headline numbers:
//!   * **Message-level dedup** by `message.id` + `requestId` — a resumed/forked
//!     transcript writes the same assistant turn twice; ccusage collapses them.
//!   * **Cost modes** — `display` trusts the `costUSD` baked into the line,
//!     `calculate` derives from tokens + pricing, `auto` prefers `costUSD` and
//!     falls back to calculation.
//!   * **5-hour blocks** — Claude bills in rolling 5h windows; the block view
//!     surfaces the active window and projects its end-of-window cost.

use crate::modules::agentscan::{
    civil_from_days, claude, cost_for_msg, cursor, day_key, gemini, Msg, Source, SourceBreakdown,
    MS_PER_DAY,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Claude's rolling billing window length.
const BLOCK_MS: i64 = 5 * 60 * 60 * 1000;

/// How cost is derived per message. Mirrors ccusage's `--mode` flag.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CostMode {
    /// Prefer the transcript's `costUSD`, fall back to calculation. (default)
    Auto,
    /// Always derive cost from token counts + pricing table.
    Calculate,
    /// Only count the transcript's `costUSD` (0 when absent).
    Display,
}

impl CostMode {
    fn parse(s: &str) -> CostMode {
        match s {
            "calculate" => CostMode::Calculate,
            "display" => CostMode::Display,
            _ => CostMode::Auto,
        }
    }

    /// Cost in USD for one message under this mode.
    fn cost(self, m: &Msg) -> f64 {
        match self {
            CostMode::Display => m.cost_usd.unwrap_or(0.0),
            CostMode::Calculate => cost_for_msg(m.model.as_deref(), m),
            CostMode::Auto => m
                .cost_usd
                .unwrap_or_else(|| cost_for_msg(m.model.as_deref(), m)),
        }
    }
}

/// Token + cost rollup for one period (a day, ISO week, month, or session).
#[derive(Serialize, Default, Clone)]
pub struct PeriodBucket {
    /// `YYYY-MM-DD`, ISO-week `YYYY-Www`, `YYYY-MM`, or a session id.
    pub key: String,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "cacheReadTokens")]
    pub cache_read_tokens: u64,
    #[serde(rename = "cacheCreationTokens")]
    pub cache_creation_tokens: u64,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
    /// Distinct models seen in this period, sorted for stable output.
    pub models: Vec<String>,
}

impl PeriodBucket {
    fn new(key: String) -> Self {
        PeriodBucket { key, ..Default::default() }
    }

    /// Fold a message in. `models` is accumulated via the caller's set.
    fn add(&mut self, m: &Msg, cost: f64) {
        self.input_tokens += m.input_tokens;
        self.output_tokens += m.output_tokens;
        self.cache_read_tokens += m.cache_read_tokens;
        self.cache_creation_tokens += m.cache_creation_tokens;
        // Headline tokens = fresh input + output (cache excluded, same rule as
        // agentscan — repeated cache reads would otherwise dominate).
        self.total_tokens += m.input_tokens + m.output_tokens;
        self.cost_usd += cost;
    }
}

/// A conversation session rollup (extends a period bucket with a time span).
#[derive(Serialize, Clone)]
pub struct SessionBucket {
    #[serde(flatten)]
    pub bucket: PeriodBucket,
    pub source: String,
    pub messages: u64,
    #[serde(rename = "startMs")]
    pub start_ms: i64,
    #[serde(rename = "endMs")]
    pub end_ms: i64,
}

/// One 5-hour billing block.
#[derive(Serialize, Clone)]
pub struct BlockBucket {
    #[serde(rename = "startMs")]
    pub start_ms: i64,
    #[serde(rename = "endMs")]
    pub end_ms: i64,
    #[serde(rename = "isActive")]
    pub is_active: bool,
    pub messages: u64,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
    pub models: Vec<String>,
    /// Tokens per minute over the block's elapsed span (active block only,
    /// else over the full block); `null` when the span is zero.
    #[serde(rename = "burnRateTpm", skip_serializing_if = "Option::is_none")]
    pub burn_rate_tpm: Option<f64>,
    /// Projected total cost if the active block keeps its current burn rate to
    /// the end of the 5-hour window. `null` for completed blocks.
    #[serde(rename = "projectedCostUsd", skip_serializing_if = "Option::is_none")]
    pub projected_cost_usd: Option<f64>,
}

#[derive(Serialize, Default)]
pub struct Totals {
    pub sessions: u64,
    pub messages: u64,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "cacheReadTokens")]
    pub cache_read_tokens: u64,
    #[serde(rename = "cacheCreationTokens")]
    pub cache_creation_tokens: u64,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
}

/// Everything the ccusage dashboard renders, in one round-trip.
#[derive(Serialize)]
pub struct CcusageReport {
    #[serde(rename = "costMode")]
    pub cost_mode: String,
    pub totals: Totals,
    pub daily: Vec<PeriodBucket>,
    pub weekly: Vec<PeriodBucket>,
    pub monthly: Vec<PeriodBucket>,
    pub sessions: Vec<SessionBucket>,
    pub blocks: Vec<BlockBucket>,
    pub sources: Vec<SourceBreakdown>,
}

/// ISO-8601 week key (`YYYY-Www`) for a local day index, Monday-anchored.
/// ISO weeks belong to the year of their Thursday, so we shift to the Thursday
/// of the same week before reading the year, and number weeks from that year's
/// first Thursday.
fn week_key(day_idx: i64) -> String {
    // day_idx for 1970-01-01 is 0, a Thursday → weekday (Mon=0): (idx + 3) % 7.
    let weekday = (day_idx + 3).rem_euclid(7); // 0 = Monday
    let thursday = day_idx - weekday + 3; // Thursday of this ISO week
    let (iso_year, _, _) = civil_from_days(thursday);
    // Week 1 is the week containing the year's first Thursday. Jan 4 is always
    // in ISO week 1 (regardless of its weekday), so anchor on the Thursday of
    // Jan 4's week — anchoring on Jan 1 misnumbers years whose Jan 1 falls on
    // Fri/Sat/Sun (its Thursday belongs to the previous ISO year).
    let jan4 = days_from_civil_local(iso_year, 1, 4);
    let jan4_weekday = (jan4 + 3).rem_euclid(7);
    let first_thursday = jan4 - jan4_weekday + 3;
    let week_no = ((thursday - first_thursday) / 7) + 1;
    format!("{iso_year:04}-W{week_no:02}")
}

/// Local-calendar days-from-civil, re-derived here so week math stays in this
/// module (agentscan's `days_from_civil` is private to its file). Same public
/// Howard Hinnant algorithm.
fn days_from_civil_local(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYY-MM` from a `YYYY-MM-DD` day key.
fn month_key(day: &str) -> String {
    day.get(0..7).unwrap_or(day).to_string()
}

/// Drop duplicate messages sharing a `message.id`+`requestId` pair. Only dedups
/// when BOTH ids are present — a message missing either id has no stable hash,
/// so it is always kept (collapsing id-less messages would erase real turns).
fn dedup(messages: Vec<Msg>) -> Vec<Msg> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(messages.len());
    for m in messages {
        match (m.message_id.as_deref(), m.request_id.as_deref()) {
            (Some(mid), Some(rid)) => {
                if seen.insert(format!("{mid}\u{0}{rid}")) {
                    out.push(m);
                }
            }
            _ => out.push(m),
        }
    }
    out
}

/// Push a model into a period's set (dedup, kept sorted on finalize).
fn note_model(models: &mut Vec<String>, m: &Msg) {
    if let Some(model) = &m.model {
        if !models.contains(model) {
            models.push(model.clone());
        }
    }
}

/// Sort buckets by key and tidy their model lists; returns a Vec.
fn finalize(mut map: HashMap<String, PeriodBucket>) -> Vec<PeriodBucket> {
    let mut v: Vec<PeriodBucket> = map.drain().map(|(_, b)| b).collect();
    for b in &mut v {
        b.models.sort();
    }
    v.sort_by(|a, b| a.key.cmp(&b.key));
    v
}

/// Compute the full report. Pulled out of the command for unit testing.
fn build(messages: Vec<Msg>, now_ms: i64, tz_offset_ms: i64, mode: CostMode) -> CcusageReport {
    let messages = dedup(messages);

    let mut totals = Totals::default();
    let mut daily: HashMap<String, PeriodBucket> = HashMap::new();
    let mut weekly: HashMap<String, PeriodBucket> = HashMap::new();
    let mut monthly: HashMap<String, PeriodBucket> = HashMap::new();
    let mut sessions: HashMap<String, SessionBucket> = HashMap::new();
    let mut session_seen: HashSet<String> = HashSet::new();

    for m in &messages {
        let cost = mode.cost(m);
        totals.messages += 1;
        totals.input_tokens += m.input_tokens;
        totals.output_tokens += m.output_tokens;
        totals.cache_read_tokens += m.cache_read_tokens;
        totals.cache_creation_tokens += m.cache_creation_tokens;
        totals.total_tokens += m.input_tokens + m.output_tokens;
        totals.cost_usd += cost;

        let dk = day_key(m.ts_ms, tz_offset_ms);
        let local_day = (m.ts_ms + tz_offset_ms).div_euclid(MS_PER_DAY);
        let wk = week_key(local_day);
        let mk = month_key(&dk);

        for (map, key) in [
            (&mut daily, dk),
            (&mut weekly, wk),
            (&mut monthly, mk),
        ] {
            let b = map.entry(key.clone()).or_insert_with(|| PeriodBucket::new(key));
            b.add(m, cost);
            note_model(&mut b.models, m);
        }

        // Per-session rollup (keyed by source+session so two agents' ids can't
        // collide).
        let skey = format!("{}\u{0}{}", source_key(m.source), m.session_id);
        if session_seen.insert(skey.clone()) {
            totals.sessions += 1;
        }
        let s = sessions.entry(skey.clone()).or_insert_with(|| SessionBucket {
            bucket: PeriodBucket::new(m.session_id.clone()),
            source: source_key(m.source).to_string(),
            messages: 0,
            start_ms: m.ts_ms,
            end_ms: m.ts_ms,
        });
        s.bucket.add(m, cost);
        note_model(&mut s.bucket.models, m);
        s.messages += 1;
        if m.ts_ms > 0 {
            if s.start_ms == 0 || m.ts_ms < s.start_ms {
                s.start_ms = m.ts_ms;
            }
            if m.ts_ms > s.end_ms {
                s.end_ms = m.ts_ms;
            }
        }
    }

    let blocks = compute_blocks(&messages, now_ms, mode);

    let mut session_vec: Vec<SessionBucket> = sessions.into_values().collect();
    for s in &mut session_vec {
        s.bucket.models.sort();
    }
    // Most recent sessions first.
    session_vec.sort_by(|a, b| b.end_ms.cmp(&a.end_ms));

    CcusageReport {
        cost_mode: mode_str(mode).to_string(),
        totals,
        daily: finalize(daily),
        weekly: finalize(weekly),
        monthly: finalize(monthly),
        sessions: session_vec,
        blocks,
        sources: source_breakdowns(&messages, mode),
    }
}

fn source_key(s: Source) -> &'static str {
    match s {
        Source::Claude => "claude",
        Source::Gemini => "gemini",
        Source::Cursor => "cursor",
    }
}

fn mode_str(m: CostMode) -> &'static str {
    match m {
        CostMode::Auto => "auto",
        CostMode::Calculate => "calculate",
        CostMode::Display => "display",
    }
}

/// Per-source token/session rollup (reuses agentscan's breakdown struct so the
/// frontend shares one type).
fn source_breakdowns(messages: &[Msg], _mode: CostMode) -> Vec<SourceBreakdown> {
    let mut map: HashMap<&'static str, (u64, u64, HashSet<String>)> = HashMap::new();
    for m in messages {
        let e = map.entry(source_key(m.source)).or_default();
        e.0 += 1; // messages
        e.1 += m.input_tokens + m.output_tokens; // est tokens
        e.2.insert(m.session_id.clone());
    }
    let order = ["claude", "gemini", "cursor"];
    order
        .iter()
        .map(|src| {
            let (messages, est_tokens, sessions) = map
                .get(*src)
                .map(|(m, t, s)| (*m, *t, s.len() as u64))
                .unwrap_or((0, 0, 0));
            SourceBreakdown {
                source: (*src).to_string(),
                sessions,
                messages,
                est_tokens,
                error: None,
            }
        })
        .collect()
}

/// Split the message stream into 5-hour billing blocks. ccusage's rule: sort by
/// time, floor the first message to the hour to open a block, and start a NEW
/// block when a message is either ≥5h after the block's start OR >5h after the
/// previous message (an idle gap closes the window).
fn compute_blocks(messages: &[Msg], now_ms: i64, mode: CostMode) -> Vec<BlockBucket> {
    let mut timed: Vec<&Msg> = messages.iter().filter(|m| m.ts_ms > 0).collect();
    timed.sort_by_key(|m| m.ts_ms);
    if timed.is_empty() {
        return Vec::new();
    }

    let mut blocks: Vec<BlockBucket> = Vec::new();
    let mut start = floor_to_hour(timed[0].ts_ms);
    let mut prev_ts = timed[0].ts_ms;
    let mut cur = new_block(start);

    for m in &timed {
        let too_far = m.ts_ms - start >= BLOCK_MS;
        let big_gap = m.ts_ms - prev_ts > BLOCK_MS;
        if (too_far || big_gap) && cur.messages > 0 {
            finish_block(&mut cur, now_ms, mode);
            blocks.push(cur);
            start = floor_to_hour(m.ts_ms);
            cur = new_block(start);
        }
        accumulate_block(&mut cur, m, mode);
        prev_ts = m.ts_ms;
    }
    finish_block(&mut cur, now_ms, mode);
    blocks.push(cur);

    blocks
}

fn floor_to_hour(ts_ms: i64) -> i64 {
    (ts_ms / 3_600_000) * 3_600_000
}

fn new_block(start_ms: i64) -> BlockBucket {
    BlockBucket {
        start_ms,
        end_ms: start_ms + BLOCK_MS,
        is_active: false,
        messages: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost_usd: 0.0,
        models: Vec::new(),
        burn_rate_tpm: None,
        projected_cost_usd: None,
    }
}

fn accumulate_block(b: &mut BlockBucket, m: &Msg, mode: CostMode) {
    b.messages += 1;
    b.input_tokens += m.input_tokens;
    b.output_tokens += m.output_tokens;
    b.total_tokens += m.input_tokens + m.output_tokens;
    b.cost_usd += mode.cost(m);
    if let Some(model) = &m.model {
        if !b.models.contains(model) {
            b.models.push(model.clone());
        }
    }
}

fn finish_block(b: &mut BlockBucket, now_ms: i64, _mode: CostMode) {
    b.models.sort();
    b.is_active = now_ms >= b.start_ms && now_ms < b.end_ms;
    // Burn rate over the elapsed span: up to now for the active block, the full
    // window for a completed one.
    let elapsed_ms = if b.is_active {
        (now_ms - b.start_ms).max(0)
    } else {
        BLOCK_MS
    };
    let elapsed_min = elapsed_ms as f64 / 60_000.0;
    if elapsed_min > 0.0 {
        let tpm = b.total_tokens as f64 / elapsed_min;
        b.burn_rate_tpm = Some(tpm);
        if b.is_active && b.cost_usd > 0.0 {
            // Linear projection of the current spend to the full 5h window.
            let frac = elapsed_ms as f64 / BLOCK_MS as f64;
            if frac > 0.0 {
                b.projected_cost_usd = Some(b.cost_usd / frac);
            }
        }
    }
}

/// Scan all sources (reusing agentscan's parsers) and aggregate ccusage reports.
///
/// `now_ms`/`tz_offset_ms` come from the webview (owns the user's clock); `cost_mode`
/// is `auto` | `calculate` | `display`.
#[tauri::command]
pub fn ccusage_collect(now_ms: i64, tz_offset_ms: i64, cost_mode: String) -> CcusageReport {
    let mode = CostMode::parse(&cost_mode);
    let mut messages = Vec::new();
    for res in [claude::scan(), gemini::scan(), cursor::scan()] {
        messages.extend(res.messages);
    }
    build(messages, now_ms, tz_offset_ms, mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::agentscan::Role;

    fn msg(
        source: Source,
        sid: &str,
        ts: i64,
        role: Role,
        model: &str,
        i: u64,
        o: u64,
    ) -> Msg {
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
            message_id: None,
            request_id: None,
            cost_usd: None,
        }
    }

    // Live smoke test against this machine's real agent session data. Ignored
    // by default (machine-dependent); run with
    // `cargo test ccusage_live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn ccusage_live() {
        let r = ccusage_collect(1_900_000_000_000, 0, "auto".into());
        eprintln!(
            "totals: sessions={} messages={} tokens={} cost=${:.4}",
            r.totals.sessions, r.totals.messages, r.totals.total_tokens, r.totals.cost_usd
        );
        eprintln!("daily buckets={} weekly={} monthly={}", r.daily.len(), r.weekly.len(), r.monthly.len());
        eprintln!("sessions={} blocks={}", r.sessions.len(), r.blocks.len());
        for b in r.blocks.iter().rev().take(3) {
            eprintln!(
                "  block {}–{} active={} msg={} tok={} cost=${:.4} burn={:?}",
                b.start_ms, b.end_ms, b.is_active, b.messages, b.total_tokens, b.cost_usd, b.burn_rate_tpm
            );
        }
    }

    #[test]
    fn dedup_drops_exact_id_pair_keeps_idless() {
        let mut a = msg(Source::Claude, "s", 1000, Role::Assistant, "claude-opus", 10, 20);
        a.message_id = Some("m1".into());
        a.request_id = Some("r1".into());
        let mut a_dup = a.clone();
        a_dup.input_tokens = 999; // same ids → must be dropped regardless of body
        let b = msg(Source::Claude, "s", 1000, Role::Assistant, "claude-opus", 5, 5); // no ids → kept
        let c = msg(Source::Claude, "s", 1000, Role::Assistant, "claude-opus", 5, 5); // no ids → kept

        let out = dedup(vec![a, a_dup, b, c]);
        assert_eq!(out.len(), 3, "one exact dup removed, two id-less kept");
    }

    #[test]
    fn cost_modes_differ() {
        let mut m = msg(Source::Claude, "s", 1000, Role::Assistant, "claude-opus-4-7", 1_000_000, 0);
        m.cost_usd = Some(2.5); // pretend the line carried a costUSD

        // calculate ignores costUSD: opus input $15/1M * 1M = $15.
        assert!((CostMode::Calculate.cost(&m) - 15.0).abs() < 1e-9);
        // display trusts the line.
        assert!((CostMode::Display.cost(&m) - 2.5).abs() < 1e-9);
        // auto prefers the line.
        assert!((CostMode::Auto.cost(&m) - 2.5).abs() < 1e-9);

        // No costUSD → display=0, auto falls back to calculation.
        m.cost_usd = None;
        assert_eq!(CostMode::Display.cost(&m), 0.0);
        assert!((CostMode::Auto.cost(&m) - 15.0).abs() < 1e-9);
    }

    #[test]
    fn week_and_month_keys() {
        // 2024-01-01 is a Monday in ISO week 2024-W01.
        let mon = days_from_civil_local(2024, 1, 1);
        assert_eq!(week_key(mon), "2024-W01");
        // 2021-01-01 is a Friday → ISO week belongs to 2020-W53.
        let fri = days_from_civil_local(2021, 1, 1);
        assert_eq!(week_key(fri), "2020-W53");
        // First week of an ISO year whose Jan 1 is a Friday (regression for the
        // Jan-4 anchor): 2021-01-04 (Mon) must be 2021-W01, not 2021-W02.
        assert_eq!(week_key(days_from_civil_local(2021, 1, 4)), "2021-W01");
        // Jan 1 on a Saturday (2022) → belongs to the prior ISO year's W52.
        assert_eq!(week_key(days_from_civil_local(2022, 1, 1)), "2021-W52");
        assert_eq!(week_key(days_from_civil_local(2022, 1, 3)), "2022-W01");
        // Jan 1 on a Friday (2027) → 2026-W53; first W01 day is 2027-01-04.
        assert_eq!(week_key(days_from_civil_local(2027, 1, 1)), "2026-W53");
        assert_eq!(week_key(days_from_civil_local(2027, 1, 4)), "2027-W01");
        assert_eq!(month_key("2026-05-29"), "2026-05");
    }

    #[test]
    fn blocks_split_on_window_and_gap() {
        let h = 3_600_000i64;
        // Three msgs in hour 0..1 → one block. One 6h later → new block (gap).
        let m0 = msg(Source::Claude, "s", 0, Role::Assistant, "claude-opus", 10, 10);
        let m1 = msg(Source::Claude, "s", h / 2, Role::Assistant, "claude-opus", 10, 10);
        let m2 = msg(Source::Claude, "s", 6 * h, Role::Assistant, "claude-opus", 10, 10);
        let blocks = compute_blocks(&[m0, m1, m2], 100 * h, CostMode::Calculate);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].messages, 2);
        assert_eq!(blocks[1].messages, 1);
        // Completed blocks are not active and have no projection.
        assert!(!blocks[0].is_active);
        assert!(blocks[0].projected_cost_usd.is_none());
    }

    #[test]
    fn active_block_has_burn_and_projection() {
        let h = 3_600_000i64;
        // Block starts at 0, "now" is 1h in → active, half a window remaining.
        let m = msg(Source::Claude, "s", 0, Role::Assistant, "claude-opus-4-7", 1_000_000, 0);
        let blocks = compute_blocks(std::slice::from_ref(&m), h, CostMode::Calculate);
        assert_eq!(blocks.len(), 1);
        let b = &blocks[0];
        assert!(b.is_active);
        // 1M tokens over ~60 min → ~16.6k tpm.
        let tpm = b.burn_rate_tpm.unwrap();
        assert!(tpm > 16_000.0 && tpm < 17_000.0, "tpm={tpm}");
        // Cost $15 at 1/5 of the window → projected ~$75.
        let proj = b.projected_cost_usd.unwrap();
        assert!((proj - 75.0).abs() < 1.0, "proj={proj}");
    }

    #[test]
    fn build_rolls_up_totals_and_periods() {
        let a = msg(Source::Claude, "s1", 1_700_000_000_000, Role::Assistant, "claude-opus", 100, 200);
        let b = msg(Source::Gemini, "g1", 1_700_000_000_000, Role::Assistant, "gemini-2.5-pro", 10, 20);
        let rep = build(vec![a, b], 1_700_100_000_000, 0, CostMode::Calculate);
        assert_eq!(rep.totals.messages, 2);
        assert_eq!(rep.totals.sessions, 2);
        assert_eq!(rep.totals.total_tokens, 100 + 200 + 10 + 20);
        assert_eq!(rep.daily.len(), 1, "both messages land on the same day");
        assert_eq!(rep.sources.len(), 3);
    }
}
