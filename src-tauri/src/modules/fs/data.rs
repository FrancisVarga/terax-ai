//! Tabular data preview for the explorer: SQLite tables, CSV, and Parquet.
//!
//! Every command resolves its path through [`resolve_path`] and is therefore
//! sandboxed to the same authorized-workspace boundary as `fs_read_file` — a
//! data preview can never read outside a folder the user has opened.
//!
//! Rows are returned as `Vec<Vec<Option<String>>>`: each cell is stringified on
//! the Rust side so the React grid stays type-agnostic (it only ever renders
//! text). `None` is a SQL/Arrow NULL, which the grid shows as an empty muted
//! cell — distinct from the literal string "NULL".

use serde::{Deserialize, Serialize};

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

/// Hard cap on rows returned in a single page, regardless of the requested
/// `limit`. Keeps a single IPC payload bounded even if the UI asks for more.
const MAX_PAGE_ROWS: u32 = 5_000;

/// Error returned by `data_query` / `data_export` for CSV/Parquet files when the
/// build was compiled without the `sql` feature (DuckDB excluded — issue #72).
/// SQLite queries are unaffected. The message is user-facing in the query editor.
#[cfg(not(feature = "sql"))]
const SQL_DISABLED_MSG: &str =
    "SQL query for CSV/Parquet is disabled in this build (compiled without the `sql` feature).";

/// One column sort forwarded from the grid. `col` is a column index into the
/// preview's `columns`; `dir` is "asc" or "desc". Index (not name) avoids any
/// ambiguity from duplicate/empty source column names.
#[derive(Deserialize, Clone, Copy)]
pub struct SortSpec {
    pub col: usize,
    pub desc: bool,
}

/// Whether a stringified cell matches the (already lowercased) search needle.
fn cell_matches(cell: &Option<String>, needle: &str) -> bool {
    match cell {
        Some(s) => s.to_lowercase().contains(needle),
        None => false,
    }
}

/// True when any cell in the row matches the needle.
fn row_matches(row: &[Option<String>], needle: &str) -> bool {
    row.iter().any(|c| cell_matches(c, needle))
}

/// Sort fully-materialized rows in place by a column index. NULLs sort last.
/// Comparison is numeric when both cells parse as f64, else lexicographic —
/// so a numeric column orders 2 < 10 rather than "10" < "2".
fn sort_rows(rows: &mut [Vec<Option<String>>], sort: SortSpec) {
    rows.sort_by(|a, b| {
        let av = a.get(sort.col).and_then(|c| c.as_deref());
        let bv = b.get(sort.col).and_then(|c| c.as_deref());
        let ord = match (av, bv) {
            (None, None) => std::cmp::Ordering::Equal,
            (None, Some(_)) => std::cmp::Ordering::Greater, // NULL last
            (Some(_), None) => std::cmp::Ordering::Less,
            (Some(x), Some(y)) => match (x.parse::<f64>(), y.parse::<f64>()) {
                (Ok(nx), Ok(ny)) => {
                    nx.partial_cmp(&ny).unwrap_or(std::cmp::Ordering::Equal)
                }
                _ => x.cmp(y),
            },
        };
        if sort.desc { ord.reverse() } else { ord }
    });
}

#[derive(Serialize, Debug)]
pub struct DataPreview {
    /// Column display names, in order.
    pub columns: Vec<String>,
    /// Row-major cells. `None` = NULL.
    pub rows: Vec<Vec<Option<String>>>,
    /// Total row count of the underlying table/file when known, so the UI can
    /// page. `None` when computing it would be as expensive as reading the
    /// whole file (kept `Some` for all three current backends).
    pub total: Option<u64>,
}

fn clamp_limit(limit: u32) -> u32 {
    limit.clamp(1, MAX_PAGE_ROWS)
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/// List user-facing table and view names in a SQLite database, alphabetically.
/// Internal `sqlite_*` bookkeeping tables are filtered out.
// (async): opens + queries a SQLite file; off the main thread.
#[tauri::command(async)]
pub fn data_sqlite_tables(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<String>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    // read-only open: previewing must never mutate the file or create a -wal.
    let conn = rusqlite::Connection::open_with_flags(
        &p,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("open sqlite: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master \
             WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(names)
}

/// Validate that `table` is a real table/view in this database, returning its
/// canonical name. Guards against SQL injection — the name is spliced into the
/// query (SQLite can't bind an identifier), so it MUST be verified to exist
/// before use rather than escaped.
fn verified_table_name(conn: &rusqlite::Connection, table: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT name FROM sqlite_master \
         WHERE type IN ('table','view') AND name = ?1",
        [table],
        |row| row.get::<_, String>(0),
    )
    .map_err(|_| format!("no such table: {table}"))
}

// (async): pages through a SQLite table (search scans rows); off the main thread.
#[tauri::command(async)]
pub fn data_sqlite_rows(
    path: String,
    table: String,
    limit: u32,
    offset: u32,
    search: Option<String>,
    sort: Option<SortSpec>,
    workspace: Option<WorkspaceEnv>,
) -> Result<DataPreview, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let limit = clamp_limit(limit);
    let conn = rusqlite::Connection::open_with_flags(
        &p,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("open sqlite: {e}"))?;

    let name = verified_table_name(&conn, &table)?;
    // `name` is now known to match an existing identifier exactly; quote it by
    // doubling embedded quotes so identifiers containing `"` are still valid.
    let quoted = format!("\"{}\"", name.replace('"', "\"\""));

    // Resolve the column list up front (needed to build a search WHERE that
    // spans every column, and to map a sort index → identifier).
    let columns: Vec<String> = {
        let stmt = conn
            .prepare(&format!("SELECT * FROM {quoted} LIMIT 0"))
            .map_err(|e| e.to_string())?;
        stmt.column_names().iter().map(|c| c.to_string()).collect()
    };
    let col_count = columns.len();

    // Build an optional WHERE that LIKEs the needle against every column,
    // CAST to TEXT so numeric/real columns are searchable too. The `%needle%`
    // bound param is reused for all columns via `?1`. `search` is bound, never
    // spliced, so it can't inject SQL.
    let needle = search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let where_sql = if needle.is_some() && col_count > 0 {
        let preds: Vec<String> = (0..col_count)
            .map(|i| {
                let q = format!("\"{}\"", columns[i].replace('"', "\"\""));
                format!("CAST({q} AS TEXT) LIKE ?1 ESCAPE '\\'")
            })
            .collect();
        format!("WHERE {}", preds.join(" OR "))
    } else {
        String::new()
    };

    // ORDER BY a verified column index. SQLite has no bind for ORDER BY, but
    // `sort.col` is an in-range index into our own column list, so the spliced
    // identifier is trusted.
    let order_sql = match sort {
        Some(s) if s.col < col_count => {
            let q = format!("\"{}\"", columns[s.col].replace('"', "\"\""));
            format!("ORDER BY {q} {}", if s.desc { "DESC" } else { "ASC" })
        }
        _ => String::new(),
    };

    // Filtered total so the grid's scroll bounds match the result set.
    let count_sql = format!("SELECT COUNT(*) FROM {quoted} {where_sql}");
    let total: u64 = if let Some(n) = &needle {
        conn.query_row(&count_sql, [n], |r| r.get::<_, i64>(0))
    } else {
        conn.query_row(&count_sql, [], |r| r.get::<_, i64>(0))
    }
    .map_err(|e| e.to_string())? as u64;

    let sql = format!("SELECT * FROM {quoted} {where_sql} {order_sql} LIMIT ?2 OFFSET ?3");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut collect = |query_rows: &mut rusqlite::Rows| -> Result<(), String> {
        while let Some(row) = query_rows.next().map_err(|e| e.to_string())? {
            let mut cells = Vec::with_capacity(col_count);
            for i in 0..col_count {
                cells.push(sqlite_value_to_string(row, i));
            }
            rows.push(cells);
        }
        Ok(())
    };
    // `?1` is the needle (only referenced when where_sql is non-empty); `?2`/`?3`
    // are limit/offset. Binding an unused `?1` is harmless.
    let blank = String::new();
    let needle_bind = needle.as_ref().unwrap_or(&blank);
    let mut q = stmt
        .query(rusqlite::params![needle_bind, limit, offset])
        .map_err(|e| e.to_string())?;
    collect(&mut q)?;

    Ok(DataPreview {
        columns,
        rows,
        total: Some(total),
    })
}

fn sqlite_value_to_string(row: &rusqlite::Row, idx: usize) -> Option<String> {
    use rusqlite::types::ValueRef;
    match row.get_ref(idx).ok()? {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(i.to_string()),
        ValueRef::Real(f) => Some(f.to_string()),
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Some(format!("<blob {} bytes>", b.len())),
    }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/// Preview a CSV file. The first record is treated as the header row. Parsing
/// is intentionally minimal but RFC-4180-aware (handles quoted fields with
/// embedded commas, quotes, and newlines) — no external crate needed.
// (async): parses the CSV up to the requested page; off the main thread.
#[tauri::command(async)]
pub fn data_csv_preview(
    path: String,
    limit: u32,
    offset: u32,
    search: Option<String>,
    sort: Option<SortSpec>,
    workspace: Option<WorkspaceEnv>,
) -> Result<DataPreview, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let limit = clamp_limit(limit) as usize;
    let offset = offset as usize;

    let text = std::fs::read_to_string(&p).map_err(|e| format!("read csv: {e}"))?;
    let mut records = parse_csv(&text);
    if records.is_empty() {
        return Ok(DataPreview {
            columns: Vec::new(),
            rows: Vec::new(),
            total: Some(0),
        });
    }

    let header = records.remove(0);
    let col_count = header.len();
    let columns: Vec<String> = header;

    // Normalize every record to col_count cells of Option<String> so search,
    // sort, and the window all operate on a uniform shape.
    let mut all: Vec<Vec<Option<String>>> = records
        .into_iter()
        .map(|mut rec| {
            rec.resize(col_count, String::new());
            rec.into_iter().map(Some).collect()
        })
        .collect();

    apply_search_sort(&mut all, search.as_deref(), sort);
    let total = all.len() as u64;
    let rows = window(all, offset, limit);

    Ok(DataPreview {
        columns,
        rows,
        total: Some(total),
    })
}

/// Filter rows by a case-insensitive substring across all cells, then sort.
/// Shared by the in-memory CSV/Parquet backends. No-ops when both are absent.
fn apply_search_sort(
    rows: &mut Vec<Vec<Option<String>>>,
    search: Option<&str>,
    sort: Option<SortSpec>,
) {
    if let Some(needle) = search.map(str::trim).filter(|s| !s.is_empty()) {
        let needle = needle.to_lowercase();
        rows.retain(|r| row_matches(r, &needle));
    }
    if let Some(s) = sort {
        sort_rows(rows, s);
    }
}

/// Slice the `[offset, offset+limit)` window out of fully-built rows.
fn window(
    rows: Vec<Vec<Option<String>>>,
    offset: usize,
    limit: usize,
) -> Vec<Vec<Option<String>>> {
    rows.into_iter().skip(offset).take(limit).collect()
}

/// Minimal RFC-4180 CSV tokenizer → `Vec<record>` where each record is a
/// `Vec<field>`. Splits on commas and CRLF/LF, honoring double-quoted fields
/// (`""` is an escaped quote inside a quoted field).
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    let mut started = false; // saw any char on the current record

    while let Some(c) = chars.next() {
        started = true;
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' => in_quotes = true,
            ',' => {
                record.push(std::mem::take(&mut field));
            }
            '\r' => { /* swallow; the \n (or EOF) ends the record */ }
            '\n' => {
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
                started = false;
            }
            _ => field.push(c),
        }
    }
    // Flush the trailing field/record if the file didn't end with a newline.
    if started || !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }
    records
}

// ---------------------------------------------------------------------------
// Parquet
// ---------------------------------------------------------------------------

/// Preview a Parquet file via the Arrow reader. We stream record batches and
/// stop once `offset + limit` rows have been seen, so a huge file is never
/// fully materialized just to show the first page.
// (async): decodes Arrow record batches; off the main thread.
#[tauri::command(async)]
pub fn data_parquet_preview(
    path: String,
    limit: u32,
    offset: u32,
    search: Option<String>,
    sort: Option<SortSpec>,
    workspace: Option<WorkspaceEnv>,
) -> Result<DataPreview, String> {
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let limit = clamp_limit(limit) as usize;
    let offset = offset as usize;

    let file = std::fs::File::open(&p).map_err(|e| format!("open parquet: {e}"))?;
    let builder =
        ParquetRecordBatchReaderBuilder::try_new(file).map_err(|e| format!("parquet: {e}"))?;

    // Total rows from file metadata — cheap, no scan. Only valid as the grid
    // total when there's no filter; a search recomputes it below.
    let file_total: u64 = builder
        .metadata()
        .file_metadata()
        .num_rows()
        .max(0) as u64;

    let schema = builder.schema().clone();
    let columns: Vec<String> = schema
        .fields()
        .iter()
        .map(|f| f.name().to_string())
        .collect();

    let reader = builder.build().map_err(|e| format!("parquet: {e}"))?;

    let needle = search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);

    // Fast path: no search and no sort → stream batches and stop once the
    // window is filled, so a huge file is never fully materialized.
    if needle.is_none() && sort.is_none() {
        let mut rows: Vec<Vec<Option<String>>> = Vec::new();
        let mut seen = 0usize;
        let want_until = offset.saturating_add(limit);
        'outer: for batch in reader {
            let batch = batch.map_err(|e| format!("parquet batch: {e}"))?;
            let n = batch.num_rows();
            if seen + n <= offset {
                seen += n;
                continue;
            }
            let cols = batch.columns();
            let start = offset.saturating_sub(seen);
            for r in start..n {
                if seen + r >= want_until {
                    break 'outer;
                }
                let mut cells = Vec::with_capacity(cols.len());
                for col in cols {
                    cells.push(arrow_value_to_string(col, r));
                }
                rows.push(cells);
            }
            seen += n;
            if seen >= want_until {
                break;
            }
        }
        return Ok(DataPreview {
            columns,
            rows,
            total: Some(file_total),
        });
    }

    // Filter/sort path: materialize every row (Parquet has no index to scan
    // selectively), filter+sort, then window. Bounded by file size, which for a
    // preview file is acceptable.
    let mut all: Vec<Vec<Option<String>>> = Vec::new();
    for batch in reader {
        let batch = batch.map_err(|e| format!("parquet batch: {e}"))?;
        let n = batch.num_rows();
        let cols = batch.columns();
        for r in 0..n {
            let mut cells = Vec::with_capacity(cols.len());
            for col in cols {
                cells.push(arrow_value_to_string(col, r));
            }
            all.push(cells);
        }
    }

    apply_search_sort(&mut all, needle.as_deref(), sort);
    let total = all.len() as u64;
    let rows = window(all, offset, limit);

    Ok(DataPreview {
        columns,
        rows,
        total: Some(total),
    })
}

/// Stringify one Arrow cell. Uses Arrow's display formatter, which handles
/// every primitive + temporal type uniformly; falls back to `<unsupported>`
/// for exotic nested types the formatter can't render. Shared with the S3
/// parquet streamer (`modules::s3`).
pub(crate) fn arrow_value_to_string(col: &arrow::array::ArrayRef, row: usize) -> Option<String> {
    use arrow::array::Array;
    if col.is_null(row) {
        return None;
    }
    // `array_value_to_string` takes `&dyn Array`; `col` is `&Arc<dyn Array>`,
    // so deref through the Arc explicitly (no auto-coercion in arg position).
    match arrow::util::display::array_value_to_string(col.as_ref(), row) {
        Ok(s) => Some(s),
        Err(_) => Some("<unsupported>".to_string()),
    }
}

// ---------------------------------------------------------------------------
// SQL query editor (cross-format)
// ---------------------------------------------------------------------------
//
// The data viewer's SQL editor runs arbitrary user `SELECT`s against the open
// file. Two engines back it, each native to its format so neither needs a
// network-loaded extension:
//
//   * SQLite  → `rusqlite` (already bundled), opened read-only. The user's SQL
//     runs verbatim against the real database, so joins/views/pragmas all work.
//   * CSV/Parquet → an in-memory DuckDB whose core `read_csv_auto`/`read_parquet`
//     table functions expose the file as a view named `data`. The user query
//     references `data` (a `SELECT * FROM data` default is offered by the UI).
//
// Both paths share the `DataPreview` wire shape and the same paging contract as
// the browse-mode commands, so the grid's infinite row model is unchanged.

/// The format of the file a query runs against. Mirrors the TS `Format` union.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DataFormat {
    Sqlite,
    Csv,
    Parquet,
}

/// Reject anything that isn't a single read-only statement. DuckDB and SQLite
/// are both opened read-only so a write would error anyway, but rejecting it up
/// front gives a clear message and blocks multi-statement batches (`;`-joined)
/// that could smuggle a second command past the read-only intent.
fn ensure_read_only_query(sql: &str) -> Result<&str, String> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return Err("Empty query.".into());
    }
    // A bare `;` inside string literals is legal, but a preview query has no need
    // for multiple statements; the simplest safe rule is "no interior semicolon".
    if trimmed.contains(';') {
        return Err("Only a single statement is allowed.".into());
    }
    let head = trimmed
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    // Allow the read-only entry keywords. `WITH` covers CTEs that end in SELECT;
    // `PRAGMA`/`EXPLAIN`/`DESCRIBE`/`SHOW`/`VALUES`/`TABLE` are read-only too.
    const ALLOWED: &[&str] = &[
        "SELECT", "WITH", "PRAGMA", "EXPLAIN", "DESCRIBE", "SHOW", "VALUES", "TABLE",
    ];
    if !ALLOWED.contains(&head.as_str()) {
        return Err(format!(
            "Only read-only queries are allowed (got `{head}`)."
        ));
    }
    Ok(trimmed)
}

/// Build the DuckDB SQL that exposes a CSV/Parquet file as a view named `data`.
/// The path is bound as a parameter to the table function, never spliced, so a
/// path containing quotes can't break out. Returns the `CREATE VIEW` statement.
#[cfg(feature = "sql")]
fn duckdb_view_sql(format: DataFormat) -> &'static str {
    match format {
        DataFormat::Csv => "CREATE VIEW data AS SELECT * FROM read_csv_auto(?)",
        DataFormat::Parquet => "CREATE VIEW data AS SELECT * FROM read_parquet(?)",
        // SQLite never reaches DuckDB.
        DataFormat::Sqlite => unreachable!("sqlite uses rusqlite"),
    }
}

/// Open an in-memory, read-only DuckDB with the file mounted as view `data`.
#[cfg(feature = "sql")]
fn open_duckdb_with_view(p: &std::path::Path, format: DataFormat) -> Result<duckdb::Connection, String> {
    let conn = duckdb::Connection::open_in_memory().map_err(|e| format!("duckdb: {e}"))?;
    let path_str = p.to_string_lossy();
    conn.execute(duckdb_view_sql(format), duckdb::params![path_str.as_ref()])
        .map_err(|e| format!("open {}: {e}", path_str))?;
    // Belt-and-suspenders: forbid writes for the rest of the session. The view is
    // already created; the user query runs after this flips.
    conn.execute_batch("SET access_mode='READ_ONLY';").ok();
    Ok(conn)
}

/// Run a user query through DuckDB (CSV/Parquet) and collect every cell as an
/// `Option<String>`. `paged` adds an outer `LIMIT/OFFSET`; when `None` the full
/// result is returned (used by export). Returns `(columns, rows)`.
#[cfg(feature = "sql")]
fn duckdb_run(
    conn: &duckdb::Connection,
    user_sql: &str,
    paged: Option<(u32, u32)>,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), String> {
    let sql = match paged {
        Some((limit, offset)) => {
            format!("SELECT * FROM ({user_sql}) AS _q LIMIT {limit} OFFSET {offset}")
        }
        None => format!("SELECT * FROM ({user_sql}) AS _q"),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows_iter = stmt.query([]).map_err(|e| e.to_string())?;

    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut col_count = 0usize;
    let mut first = true;
    while let Some(row) = rows_iter.next().map_err(|e| e.to_string())? {
        if first {
            // Column names are only known from the statement after the first
            // query; pull them once.
            let stmt_ref = row.as_ref();
            columns = stmt_ref
                .column_names()
                .into_iter()
                .map(|s| s.to_string())
                .collect();
            col_count = columns.len();
            first = false;
        }
        let mut cells = Vec::with_capacity(col_count);
        for i in 0..col_count {
            cells.push(duckdb_value_to_string(row, i));
        }
        rows.push(cells);
    }
    // Zero-row result: recover column names from the prepared statement directly.
    if first {
        columns = stmt
            .column_names()
            .into_iter()
            .map(|s| s.to_string())
            .collect();
    }
    Ok((columns, rows))
}

/// Stringify one DuckDB cell. DuckDB's row API exposes values as `duckdb::types::
/// Value`; we render each variant to text mirroring `sqlite_value_to_string`.
#[cfg(feature = "sql")]
fn duckdb_value_to_string(row: &duckdb::Row, idx: usize) -> Option<String> {
    use duckdb::types::Value;
    match row.get::<_, Value>(idx).ok()? {
        Value::Null => None,
        Value::Boolean(b) => Some(b.to_string()),
        Value::TinyInt(v) => Some(v.to_string()),
        Value::SmallInt(v) => Some(v.to_string()),
        Value::Int(v) => Some(v.to_string()),
        Value::BigInt(v) => Some(v.to_string()),
        Value::HugeInt(v) => Some(v.to_string()),
        Value::UTinyInt(v) => Some(v.to_string()),
        Value::USmallInt(v) => Some(v.to_string()),
        Value::UInt(v) => Some(v.to_string()),
        Value::UBigInt(v) => Some(v.to_string()),
        Value::Float(v) => Some(v.to_string()),
        Value::Double(v) => Some(v.to_string()),
        Value::Decimal(v) => Some(v.to_string()),
        Value::Text(s) => Some(s),
        Value::Blob(b) => Some(format!("<blob {} bytes>", b.len())),
        // Temporal / nested types: fall back to debug formatting, which DuckDB's
        // Value implements for every variant.
        other => Some(format!("{other:?}")),
    }
}

/// Run a user SQL query against a SQLite file via rusqlite (read-only) and
/// collect cells. `paged` wraps with LIMIT/OFFSET like the DuckDB path.
fn sqlite_run(
    conn: &rusqlite::Connection,
    user_sql: &str,
    paged: Option<(u32, u32)>,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), String> {
    let sql = match paged {
        Some((limit, offset)) => {
            format!("SELECT * FROM ({user_sql}) LIMIT {limit} OFFSET {offset}")
        }
        None => format!("SELECT * FROM ({user_sql})"),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(|s| s.to_string())
        .collect();
    let col_count = columns.len();
    let mut q = stmt.query([]).map_err(|e| e.to_string())?;
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    while let Some(row) = q.next().map_err(|e| e.to_string())? {
        let mut cells = Vec::with_capacity(col_count);
        for i in 0..col_count {
            cells.push(sqlite_value_to_string(row, i));
        }
        rows.push(cells);
    }
    Ok((columns, rows))
}

/// Count rows of a user query without materializing them, for the grid's scroll
/// bounds. Wraps the query in `SELECT COUNT(*) FROM (<sql>)`.
fn count_sql(user_sql: &str) -> String {
    format!("SELECT COUNT(*) FROM ({user_sql}) AS _c")
}

/// Run a single read-only SQL query against the open data file and return one
/// page of results plus the total row count, mirroring the browse-mode preview
/// commands so the grid pages identically. SQLite uses `rusqlite`; CSV/Parquet
/// use an in-memory DuckDB exposing the file as view `data`.
// (async): runs arbitrary user SQL (rusqlite / in-memory DuckDB) — unbounded
// duration; must never run on the main thread.
#[tauri::command(async)]
pub fn data_query(
    path: String,
    format: DataFormat,
    sql: String,
    limit: u32,
    offset: u32,
    workspace: Option<WorkspaceEnv>,
) -> Result<DataPreview, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let limit = clamp_limit(limit);
    let user_sql = ensure_read_only_query(&sql)?;

    let (columns, rows, total) = if format == DataFormat::Sqlite {
        let conn = rusqlite::Connection::open_with_flags(
            &p,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| format!("open sqlite: {e}"))?;
        let total: u64 = conn
            .query_row(&count_sql(user_sql), [], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())? as u64;
        let (columns, rows) = sqlite_run(&conn, user_sql, Some((limit, offset)))?;
        (columns, rows, total)
    } else {
        // CSV/Parquet SQL runs through DuckDB, gated behind the `sql` feature so
        // the default dev build skips DuckDB's bundled C++ compile (issue #72).
        #[cfg(feature = "sql")]
        {
            let conn = open_duckdb_with_view(&p, format)?;
            // DuckDB COUNT(*) is a BIGINT (i64); cast to the u64 the grid expects.
            let total: u64 = conn
                .query_row(&count_sql(user_sql), [], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())? as u64;
            let (columns, rows) = duckdb_run(&conn, user_sql, Some((limit, offset)))?;
            (columns, rows, total)
        }
        #[cfg(not(feature = "sql"))]
        {
            let _ = (&p, user_sql, limit, offset);
            return Err(SQL_DISABLED_MSG.into());
        }
    };

    Ok(DataPreview {
        columns,
        rows,
        total: Some(total),
    })
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Output format for [`data_export`]. Serialized lowercase from the UI.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    Parquet,
    Xlsx,
}

/// Run a query (or a whole table) and write the *entire* result set to
/// `dest_path` in the chosen format. Unlike [`data_query`] this never pages —
/// export is "give me everything the query returns". The same read-only rules
/// and per-format engine routing as `data_query` apply.
///
/// `dest_path` is taken verbatim from a native save dialog the user picked, so
/// it is intentionally *not* run through `resolve_path` (it's an output target
/// the user explicitly chose, not a workspace-relative read).
// (async): runs user SQL and writes the full result set (csv/xlsx) to disk —
// unbounded duration; must never run on the main thread.
#[tauri::command(async)]
pub fn data_export(
    path: String,
    format: DataFormat,
    sql: String,
    dest_path: String,
    out_format: ExportFormat,
    workspace: Option<WorkspaceEnv>,
) -> Result<u64, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let user_sql = ensure_read_only_query(&sql)?;

    // Materialize the full result. For a preview/export tool the result set is
    // user-bounded (they write the query), so collecting it is acceptable.
    let (columns, rows) = if format == DataFormat::Sqlite {
        let conn = rusqlite::Connection::open_with_flags(
            &p,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| format!("open sqlite: {e}"))?;
        sqlite_run(&conn, user_sql, None)?
    } else {
        // CSV/Parquet export runs through DuckDB; gated behind `sql` (issue #72).
        #[cfg(feature = "sql")]
        {
            let conn = open_duckdb_with_view(&p, format)?;
            duckdb_run(&conn, user_sql, None)?
        }
        #[cfg(not(feature = "sql"))]
        {
            let _ = (&p, user_sql);
            return Err(SQL_DISABLED_MSG.into());
        }
    };

    let dest = std::path::Path::new(&dest_path);
    match out_format {
        ExportFormat::Csv => write_csv(dest, &columns, &rows)?,
        ExportFormat::Json => write_json(dest, &columns, &rows)?,
        ExportFormat::Parquet => write_parquet(dest, &columns, &rows)?,
        ExportFormat::Xlsx => write_xlsx(dest, &columns, &rows)?,
    }
    Ok(rows.len() as u64)
}

/// Quote a CSV field per RFC 4180 when it contains a comma, quote, or newline.
fn csv_quote(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn write_csv(
    dest: &std::path::Path,
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<(), String> {
    use std::fmt::Write as _;
    let mut out = String::new();
    out.push_str(
        &columns
            .iter()
            .map(|c| csv_quote(c))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push('\n');
    for row in rows {
        let line = row
            .iter()
            .map(|c| csv_quote(c.as_deref().unwrap_or("")))
            .collect::<Vec<_>>()
            .join(",");
        let _ = writeln!(out, "{line}");
    }
    std::fs::write(dest, out).map_err(|e| format!("write csv: {e}"))
}

fn write_json(
    dest: &std::path::Path,
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<(), String> {
    // Array of objects keyed by column name; NULL cells serialize as JSON null.
    let records: Vec<serde_json::Map<String, serde_json::Value>> = rows
        .iter()
        .map(|row| {
            let mut obj = serde_json::Map::with_capacity(columns.len());
            for (i, col) in columns.iter().enumerate() {
                let v = match row.get(i).and_then(|c| c.as_ref()) {
                    Some(s) => serde_json::Value::String(s.clone()),
                    None => serde_json::Value::Null,
                };
                obj.insert(col.clone(), v);
            }
            obj
        })
        .collect();
    let json = serde_json::to_vec_pretty(&records).map_err(|e| format!("json: {e}"))?;
    std::fs::write(dest, json).map_err(|e| format!("write json: {e}"))
}

fn write_parquet(
    dest: &std::path::Path,
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<(), String> {
    use arrow::array::StringArray;
    use arrow::datatypes::{DataType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use parquet::arrow::ArrowWriter;
    use std::sync::Arc;

    // Every cell is already a string (the engines stringify on read), so the
    // export schema is all-Utf8. This keeps types lossless-as-text and avoids
    // re-inferring numeric/temporal types we already flattened.
    let fields: Vec<Field> = columns
        .iter()
        .map(|c| Field::new(c, DataType::Utf8, true))
        .collect();
    let schema = Arc::new(Schema::new(fields));

    // Build one StringArray per column (column-major) from the row-major rows.
    let mut col_arrays: Vec<Arc<dyn arrow::array::Array>> = Vec::with_capacity(columns.len());
    for ci in 0..columns.len() {
        let values: Vec<Option<&str>> = rows
            .iter()
            .map(|r| r.get(ci).and_then(|c| c.as_deref()))
            .collect();
        col_arrays.push(Arc::new(StringArray::from(values)));
    }
    let batch = RecordBatch::try_new(schema.clone(), col_arrays)
        .map_err(|e| format!("parquet batch: {e}"))?;

    let file = std::fs::File::create(dest).map_err(|e| format!("create parquet: {e}"))?;
    let mut writer =
        ArrowWriter::try_new(file, schema, None).map_err(|e| format!("parquet: {e}"))?;
    writer.write(&batch).map_err(|e| format!("parquet: {e}"))?;
    writer.close().map_err(|e| format!("parquet: {e}"))?;
    Ok(())
}

fn write_xlsx(
    dest: &std::path::Path,
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<(), String> {
    use rust_xlsxwriter::{Format, Workbook};

    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    let header_fmt = Format::new().set_bold();

    for (ci, col) in columns.iter().enumerate() {
        sheet
            .write_string_with_format(0, ci as u16, col, &header_fmt)
            .map_err(|e| format!("xlsx header: {e}"))?;
    }
    for (ri, row) in rows.iter().enumerate() {
        for (ci, cell) in row.iter().enumerate() {
            // Row 0 is the header, so data starts at row 1.
            let r = (ri + 1) as u32;
            if let Some(s) = cell {
                sheet
                    .write_string(r, ci as u16, s)
                    .map_err(|e| format!("xlsx cell: {e}"))?;
            }
            // None → leave the cell blank.
        }
    }
    workbook
        .save(dest)
        .map_err(|e| format!("save xlsx: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_csv() {
        let recs = parse_csv("a,b,c\n1,2,3\n4,5,6");
        assert_eq!(recs.len(), 3);
        assert_eq!(recs[0], vec!["a", "b", "c"]);
        assert_eq!(recs[2], vec!["4", "5", "6"]);
    }

    #[test]
    fn parses_quoted_fields_with_commas_and_quotes() {
        let recs = parse_csv("name,note\n\"Doe, John\",\"he said \"\"hi\"\"\"");
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[1], vec!["Doe, John", "he said \"hi\""]);
    }

    #[test]
    fn handles_trailing_newline() {
        let recs = parse_csv("a,b\n1,2\n");
        assert_eq!(recs.len(), 2);
    }

    #[test]
    fn handles_crlf() {
        let recs = parse_csv("a,b\r\n1,2\r\n");
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[1], vec!["1", "2"]);
    }

    #[test]
    fn sqlite_tables_and_rows_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("t.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE people (id INTEGER, name TEXT, score REAL, blob_col BLOB);
                 INSERT INTO people VALUES (1,'Ann',9.5,NULL);
                 INSERT INTO people VALUES (2,NULL,NULL,x'00ff');",
            )
            .unwrap();
        }
        let path = db.to_string_lossy().into_owned();
        let tables = data_sqlite_tables(path.clone(), None).unwrap();
        assert_eq!(tables, vec!["people"]);

        let preview = data_sqlite_rows(path, "people".into(), 10, 0, None, None, None).unwrap();
        assert_eq!(preview.columns, vec!["id", "name", "score", "blob_col"]);
        assert_eq!(preview.total, Some(2));
        assert_eq!(preview.rows[0][1], Some("Ann".to_string()));
        assert_eq!(preview.rows[1][1], None); // NULL name
        assert_eq!(preview.rows[0][3], None); // NULL blob
        assert!(preview.rows[1][3].as_deref().unwrap().starts_with("<blob"));
    }

    #[test]
    fn sqlite_search_filters_total_and_rows() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("t.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE people (id INTEGER, name TEXT);
                 INSERT INTO people VALUES (1,'Ann');
                 INSERT INTO people VALUES (2,'Bob');
                 INSERT INTO people VALUES (3,'Anna');",
            )
            .unwrap();
        }
        let path = db.to_string_lossy().into_owned();
        // Case-insensitive substring across all columns; total reflects filter.
        let p = data_sqlite_rows(path.clone(), "people".into(), 10, 0, Some("ann".into()), None, None)
            .unwrap();
        assert_eq!(p.total, Some(2)); // Ann, Anna
        // Numeric column searchable via CAST: "2" matches id=2.
        let p2 =
            data_sqlite_rows(path, "people".into(), 10, 0, Some("2".into()), None, None).unwrap();
        assert_eq!(p2.total, Some(1));
    }

    #[test]
    fn sqlite_sort_desc_numeric() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("t.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE n (v INTEGER);
                 INSERT INTO n VALUES (2),(10),(1);",
            )
            .unwrap();
        }
        let path = db.to_string_lossy().into_owned();
        let p = data_sqlite_rows(
            path,
            "n".into(),
            10,
            0,
            None,
            Some(SortSpec { col: 0, desc: true }),
            None,
        )
        .unwrap();
        assert_eq!(p.rows[0][0], Some("10".to_string()));
        assert_eq!(p.rows[2][0], Some("1".to_string()));
    }

    #[test]
    fn sqlite_rejects_unknown_table() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("t.db");
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch("CREATE TABLE a (x);")
            .unwrap();
        let path = db.to_string_lossy().into_owned();
        // Injection attempt is treated as a (nonexistent) identifier, not SQL.
        let err =
            data_sqlite_rows(path, "a; DROP TABLE a".into(), 10, 0, None, None, None).unwrap_err();
        assert!(err.contains("no such table"));
    }

    #[test]
    fn read_only_guard_rejects_writes_and_multistatement() {
        assert!(ensure_read_only_query("SELECT 1").is_ok());
        assert!(ensure_read_only_query("  with t as (select 1) select * from t ").is_ok());
        assert!(ensure_read_only_query("DELETE FROM t").is_err());
        assert!(ensure_read_only_query("UPDATE t SET x=1").is_err());
        assert!(ensure_read_only_query("DROP TABLE t").is_err());
        assert!(ensure_read_only_query("").is_err());
        // Trailing `;` is fine (stripped); an interior one is not.
        assert!(ensure_read_only_query("SELECT 1;").is_ok());
        assert!(ensure_read_only_query("SELECT 1; DROP TABLE t").is_err());
    }

    #[test]
    fn sqlite_query_pages_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("t.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE people (id INTEGER, name TEXT);
                 INSERT INTO people VALUES (1,'Ann'),(2,'Bob'),(3,'Cat');",
            )
            .unwrap();
        }
        let path = db.to_string_lossy().into_owned();
        let p = data_query(
            path,
            DataFormat::Sqlite,
            "SELECT name FROM people ORDER BY id".into(),
            2,
            0,
            None,
        )
        .unwrap();
        assert_eq!(p.columns, vec!["name"]);
        assert_eq!(p.total, Some(3)); // count spans the full query, not the page
        assert_eq!(p.rows.len(), 2); // limit=2
        assert_eq!(p.rows[0][0], Some("Ann".to_string()));
    }

    #[test]
    fn export_csv_and_json_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("t.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE t (a TEXT, b INTEGER);
                 INSERT INTO t VALUES ('x',1),('has,comma',2),(NULL,3);",
            )
            .unwrap();
        }
        let path = db.to_string_lossy().into_owned();

        let csv_dest = dir.path().join("out.csv");
        let n = data_export(
            path.clone(),
            DataFormat::Sqlite,
            "SELECT a, b FROM t ORDER BY b".into(),
            csv_dest.to_string_lossy().into_owned(),
            ExportFormat::Csv,
            None,
        )
        .unwrap();
        assert_eq!(n, 3);
        let csv = std::fs::read_to_string(&csv_dest).unwrap();
        assert!(csv.starts_with("a,b\n"));
        assert!(csv.contains("\"has,comma\",2")); // comma field quoted
        assert!(csv.contains("\n,3\n") || csv.ends_with(",3\n")); // NULL → empty

        let json_dest = dir.path().join("out.json");
        data_export(
            path,
            DataFormat::Sqlite,
            "SELECT a, b FROM t ORDER BY b".into(),
            json_dest.to_string_lossy().into_owned(),
            ExportFormat::Json,
            None,
        )
        .unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&json_dest).unwrap()).unwrap();
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[2]["a"], serde_json::Value::Null); // NULL preserved
    }
}
