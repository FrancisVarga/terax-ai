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
#[tauri::command]
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

#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
}
