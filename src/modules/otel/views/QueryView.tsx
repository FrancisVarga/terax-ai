import { cn } from "@/lib/utils";
import { useTheme } from "@/modules/theme";
import {
  autocompletion,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history as cmHistory,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { standardSQL as sqlMode } from "@codemirror/legacy-modes/mode/sql";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import {
  Clock01Icon,
  PlayIcon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ColDef, IDatasource, IGetRowsParams } from "ag-grid-community";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OTEL_SCHEMA, otel } from "../lib/useOtel";
import { OtelGrid } from "./detail/OtelGrid";

/** Rows fetched per infinite-scroll block (LIMIT per page). */
const QUERY_BLOCK = 200;

type GridCell = string | number | boolean | null;

/** Map a positional result row to a column-keyed object for AG Grid. */
function rowToObject(columns: string[], row: GridCell[]): Record<string, GridCell> {
  const obj: Record<string, GridCell> = {};
  for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i] ?? null;
  return obj;
}

/**
 * Query page: a read-only SQL console over the telemetry store. CodeMirror
 * provides SQL highlighting (same StreamParser as the rest of the app) plus
 * schema-aware autocomplete seeded from `OTEL_SCHEMA`. `sql-formatter`
 * pretty-prints; a template menu drops in starter queries; and a localStorage
 * history records what you've run. The backend (`otel_query`) enforces
 * SELECT-only — the UI cannot mutate the store.
 */

const HISTORY_KEY = "terax.otel.queryHistory";
const HISTORY_MAX = 30;

const TEMPLATES: Array<{ label: string; sql: string }> = [
  {
    label: "Recent error spans",
    sql: "SELECT service, name, status_message, duration_nano\nFROM spans\nWHERE status_code = 2\nORDER BY received_ms DESC\nLIMIT 50;",
  },
  {
    label: "Slowest spans",
    sql: "SELECT service, name, duration_nano\nFROM spans\nORDER BY duration_nano DESC\nLIMIT 50;",
  },
  {
    label: "Span count by service",
    sql: "SELECT service, COUNT(*) AS spans,\n       SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS errors\nFROM spans\nGROUP BY service\nORDER BY spans DESC;",
  },
  {
    label: "Error logs",
    sql: "SELECT time_nano, service, severity_text, body\nFROM logs\nWHERE severity_number >= 17\nORDER BY time_nano DESC\nLIMIT 100;",
  },
  {
    label: "Log volume by severity",
    sql: "SELECT severity_text, COUNT(*) AS n\nFROM logs\nGROUP BY severity_text\nORDER BY n DESC;",
  },
  {
    label: "Latest metric points",
    sql: "SELECT name, kind, unit, value, time_nano\nFROM metric_points\nORDER BY time_nano DESC\nLIMIT 100;",
  },
  {
    label: "Trace span fan-out",
    sql: "SELECT trace_id, COUNT(*) AS spans, MAX(duration_nano) AS max_dur\nFROM spans\nGROUP BY trace_id\nORDER BY spans DESC\nLIMIT 50;",
  },
];

const DEFAULT_SQL = "SELECT service, name, duration_nano\nFROM spans\nORDER BY received_ms DESC\nLIMIT 50;";

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "LIMIT", "HAVING",
  "JOIN", "LEFT JOIN", "ON", "AS", "AND", "OR", "NOT", "NULL", "COUNT",
  "SUM", "AVG", "MIN", "MAX", "DISTINCT", "LIKE", "IN", "DESC", "ASC",
  "CASE", "WHEN", "THEN", "ELSE", "END",
];

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(list: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch {
    // localStorage full / unavailable — non-fatal.
  }
}

/** CodeMirror completion source seeded from the OTEL schema + SQL keywords. */
function sqlCompletions(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[\w.]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const options: Completion[] = [];
  for (const table of Object.keys(OTEL_SCHEMA)) {
    options.push({ label: table, type: "class", detail: "table" });
    for (const col of OTEL_SCHEMA[table]) {
      options.push({ label: col, type: "property", detail: table });
    }
  }
  for (const kw of SQL_KEYWORDS) {
    options.push({ label: kw, type: "keyword" });
  }
  // De-dupe column names that appear in multiple tables for a cleaner list.
  const seen = new Set<string>();
  const deduped = options.filter((o) => {
    const k = `${o.label}:${o.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { from: word.from, options: deduped, validFor: /^[\w.]*$/ };
}

export function QueryView() {
  const { resolvedMode } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const runRef = useRef<() => void>(() => {});

  // An active result is the discovered columns + an infinite datasource bound
  // to the run's SQL. The grid pages through blocks via the datasource; we don't
  // hold the rows in React state. `seq` bumps per run so the grid remounts and
  // re-pages from row 0 with the new datasource.
  const [active, setActive] = useState<{
    columns: string[];
    datasource: IDatasource;
    seq: number;
  } | null>(null);
  const [rowInfo, setRowInfo] = useState<{ loaded: number; done: boolean }>({ loaded: 0, done: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const run = useCallback(async () => {
    const sql = viewRef.current?.state.doc.toString().trim() ?? "";
    if (!sql) return;
    setBusy(true);
    setError(null);
    setRowInfo({ loaded: 0, done: false });
    const started = performance.now();
    try {
      // Probe block 0 to learn the result's columns (unknown until the query
      // runs) and to surface a syntax/guard error before wiring the grid.
      const probe = await otel.query(sql, QUERY_BLOCK, 0);
      setElapsedMs(performance.now() - started);
      setHistory((prev) => {
        const next = [sql, ...prev.filter((q) => q !== sql)].slice(0, HISTORY_MAX);
        saveHistory(next);
        return next;
      });

      // Infinite datasource: each block runs the SQL windowed by LIMIT/OFFSET on
      // the Rust side (async IPC = off the UI thread). `truncated` (backend
      // fetched one extra row) tells us whether more pages exist.
      const datasource: IDatasource = {
        getRows: async (params: IGetRowsParams) => {
          try {
            const res =
              params.startRow === 0
                ? probe
                : await otel.query(sql, params.endRow - params.startRow, params.startRow);
            const rows = res.rows.map((r) => rowToObject(res.columns, r));
            const lastRow = res.truncated ? undefined : params.startRow + rows.length;
            params.successCallback(rows, lastRow);
            setRowInfo((prev) => ({
              loaded: Math.max(prev.loaded, params.startRow + rows.length),
              done: lastRow !== undefined,
            }));
          } catch (e) {
            setError(String(e));
            params.failCallback();
          }
        },
      };
      setActive((prev) => ({
        columns: probe.columns,
        datasource,
        seq: (prev?.seq ?? 0) + 1,
      }));
    } catch (e) {
      setError(String(e));
      setActive(null);
      setElapsedMs(null);
    } finally {
      setBusy(false);
    }
  }, []);
  runRef.current = run;

  const setSql = useCallback((sql: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sql } });
    view.focus();
  }, []);

  const format = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const sql = view.state.doc.toString();
    if (!sql.trim()) return;
    try {
      const { format } = await import("sql-formatter");
      const pretty = format(sql, { language: "sqlite", keywordCase: "upper", tabWidth: 2 });
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: pretty } });
    } catch {
      // Unparseable SQL — leave as-is.
    }
  }, []);

  // Mount editor once per theme.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: DEFAULT_SQL,
        extensions: [
          cmHistory(),
          StreamLanguage.define(sqlMode),
          autocompletion({ override: [sqlCompletions] }),
          keymap.of([
            { key: "Mod-Enter", run: () => (runRef.current(), true) },
            { key: "Shift-Enter", run: () => (runRef.current(), true) },
            indentWithTab,
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          placeholder("SELECT * FROM spans LIMIT 100 …"),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { fontSize: "12.5px", backgroundColor: "transparent" },
            "&.cm-focused": { outline: "none" },
            ".cm-scroller": {
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              lineHeight: "1.55",
              maxHeight: "200px",
            },
            ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
            ".cm-cursor": { borderLeftColor: "var(--foreground)" },
            ".cm-placeholder": { color: "var(--muted-foreground)" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [resolvedMode]);

  // Column defs derived from the active result's discovered columns. Every
  // column is plain text; null cells render as a dim "null".
  const columnDefs = useMemo<ColDef<Record<string, GridCell>>[]>(
    () =>
      (active?.columns ?? []).map((c) => ({
        field: c,
        headerName: c,
        minWidth: 100,
        flex: 1,
        valueFormatter: (p) => (p.value == null ? "null" : String(p.value)),
        cellClassRules: { "italic text-muted-foreground/40": (p) => p.value == null },
      })),
    [active?.columns],
  );
  // Remount the grid per run so a new datasource pages from row 0.
  const resultKey = active?.seq ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Editor + toolbar */}
      <div className="flex flex-col gap-2 border-b border-border/60 p-2.5">
        <div
          ref={hostRef}
          className="min-w-0 overflow-hidden rounded-md border border-border/60 bg-background px-2"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md border border-ring/60 bg-accent px-3 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-accent/80 disabled:opacity-50"
          >
            <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={1.75} />
            {busy ? "Running…" : "Run"}
            <span className="ml-1 font-mono text-[10px] text-muted-foreground">⌘↵</span>
          </button>
          <button
            type="button"
            onClick={format}
            className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={1.75} />
            Format
          </button>

          <Dropdown
            open={templatesOpen}
            onToggle={() => setTemplatesOpen((v) => !v)}
            label="Templates"
            onClose={() => setTemplatesOpen(false)}
          >
            {TEMPLATES.map((t) => (
              <button
                key={t.label}
                type="button"
                onClick={() => {
                  setSql(t.sql);
                  setTemplatesOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left text-[12px] text-popover-foreground hover:bg-accent"
              >
                {t.label}
              </button>
            ))}
          </Dropdown>

          <Dropdown
            open={historyOpen}
            onToggle={() => setHistoryOpen((v) => !v)}
            label="History"
            icon={Clock01Icon}
            onClose={() => setHistoryOpen(false)}
          >
            {history.length === 0 ? (
              <div className="px-3 py-2 text-[11.5px] text-muted-foreground">No history yet.</div>
            ) : (
              history.map((q, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setSql(q);
                    setHistoryOpen(false);
                  }}
                  className="block w-full max-w-md truncate px-3 py-1.5 text-left font-mono text-[11px] text-popover-foreground hover:bg-accent"
                  title={q}
                >
                  {q.replace(/\s+/g, " ").slice(0, 80)}
                </button>
              ))
            )}
          </Dropdown>

          <div className="ml-auto flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
            {active && (
              <span className="flex items-center gap-1 text-emerald-400">
                <HugeiconsIcon icon={Tick02Icon} size={11} strokeWidth={2} />
                {rowInfo.loaded} rows{rowInfo.done ? "" : "+"} loaded
              </span>
            )}
            {elapsedMs != null && <span>{elapsedMs.toFixed(0)}ms</span>}
          </div>
        </div>
      </div>

      {/* Results — infinite-scroll grid paging the query via the Rust backend */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <div className="m-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11.5px] text-destructive">
            {error}
          </div>
        ) : active && active.columns.length > 0 ? (
          <OtelGrid
            key={resultKey}
            columnDefs={columnDefs}
            datasource={active.datasource}
            cacheBlockSize={QUERY_BLOCK}
            fill
          />
        ) : active ? (
          <p className="p-4 text-[11.5px] text-muted-foreground">Query returned no columns.</p>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-[11.5px] text-muted-foreground">
            Write a read-only SELECT and press ⌘/Ctrl+Enter. Tables:{" "}
            <span className="ml-1 font-mono text-foreground/70">
              {Object.keys(OTEL_SCHEMA).join(", ")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Dropdown({
  open,
  onToggle,
  onClose,
  label,
  icon,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  label: string;
  icon?: typeof Clock01Icon;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
          open
            ? "border-ring/60 bg-accent text-foreground"
            : "border-border/60 bg-background/50 text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        {icon && <HugeiconsIcon icon={icon} size={13} strokeWidth={1.75} />}
        {label} ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={onClose} />
          <div className="absolute left-0 z-20 mt-1 max-h-80 min-w-48 overflow-auto rounded-md border border-border/60 bg-popover py-1 shadow-md">
            {children}
          </div>
        </>
      )}
    </div>
  );
}
