import { cn } from "@/lib/utils";
import { useTheme } from "@/modules/theme";
import { StreamLanguage } from "@codemirror/language";
// The standard-SQL legacy stream parser — same highlighter the editor module's
// language resolver loads for `.sql` files, so SQL colors match app-wide.
import { standardSQL as sqlMode } from "@codemirror/legacy-modes/mode/sql";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";

/** Output formats the export menu offers. Mirrors the Rust `ExportFormat`. */
export type ExportFormat = "csv" | "json" | "parquet" | "xlsx";

const EXPORT_OPTIONS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: "csv", label: "CSV", ext: "csv" },
  { id: "json", label: "JSON", ext: "json" },
  { id: "parquet", label: "Parquet", ext: "parquet" },
  { id: "xlsx", label: "Excel", ext: "xlsx" },
];

/** Imperative handle so the parent can read the current SQL on demand (e.g. to
 * export the active query without lifting the editor's full text into React
 * state on every keystroke). */
export type SqlQueryBarHandle = {
  getSql: () => string;
};

type Props = {
  /** A sensible starting query for this file (e.g. `SELECT * FROM data`). */
  initialSql: string;
  /** Run the current query. Called on the Run button and Cmd/Ctrl+Enter. */
  onRun: (sql: string) => void;
  /** Clear the query and return to plain browse mode. */
  onClear: () => void;
  /** Export the current query result in `format` to a user-chosen path. */
  onExport: (format: ExportFormat) => void;
  /** True while a query/export is in flight, to disable the action buttons. */
  busy?: boolean;
  /** Whether a query result is currently displayed (enables Clear/Export). */
  hasResult?: boolean;
  ref?: Ref<SqlQueryBarHandle>;
};

/**
 * Compact SQL editor mounted above the data grid. It is a *lightweight*
 * CodeMirror instance — deliberately not the heavy editor-module setup (no vim,
 * lint, fold gutter, or autocomplete machinery): a query box wants fast mount
 * and a small surface. SQL syntax highlighting comes from the same
 * `legacy-modes/mode/sql` StreamParser the editor module's language resolver
 * uses, so highlighting is consistent app-wide without a new dependency.
 *
 * Cmd/Ctrl+Enter runs the query (a keymap entry that consumes the event before
 * the newline insertion). The Format button pretty-prints via `sql-formatter`,
 * loaded lazily so it stays out of the initial bundle.
 */
export function SqlQueryBar({
  initialSql,
  onRun,
  onClear,
  onExport,
  busy = false,
  hasResult = false,
  ref,
}: Props) {
  const { resolvedMode } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest callbacks visible to the static keymap closure without rebuilding
  // the editor on every render.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  const [exportOpen, setExportOpen] = useState(false);

  useImperativeHandle(ref, () => ({
    getSql: () => viewRef.current?.state.doc.toString() ?? "",
  }));

  // Mount the editor once. We never tear it down on prop changes — the doc and
  // theme are reconfigured in place where needed.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const runFromKeymap = (view: EditorView) => {
      onRunRef.current(view.state.doc.toString());
      return true; // consume — don't also insert a newline
    };

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialSql,
        extensions: [
          history(),
          // Standard-SQL dialect highlighting; covers both the SQLite and
          // DuckDB query syntaxes we run well enough for a query box.
          StreamLanguage.define(sqlMode),
          keymap.of([
            { key: "Mod-Enter", run: runFromKeymap },
            { key: "Shift-Enter", run: runFromKeymap },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          placeholder("SELECT * FROM data …"),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": {
              fontSize: "12.5px",
              backgroundColor: "transparent",
            },
            "&.cm-focused": { outline: "none" },
            ".cm-scroller": {
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              lineHeight: "1.5",
              maxHeight: "120px",
            },
            ".cm-content": {
              caretColor: "var(--foreground)",
              padding: "6px 0",
            },
            ".cm-cursor": { borderLeftColor: "var(--foreground)" },
            ".cm-placeholder": { color: "var(--muted-foreground)" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor:
                "color-mix(in srgb, var(--foreground) 18%, transparent)",
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // initialSql intentionally only seeds the *first* mount; later changes to it
    // (e.g. switching files) are handled by the parent remounting via `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedMode]);

  const handleRun = useCallback(() => {
    onRun(viewRef.current?.state.doc.toString() ?? "");
  }, [onRun]);

  const handleFormat = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const sql = view.state.doc.toString();
    if (!sql.trim()) return;
    try {
      const { format } = await import("sql-formatter");
      const pretty = format(sql, {
        // `sql` is the permissive standard dialect — safe for both our engines.
        language: "sql",
        keywordCase: "upper",
        tabWidth: 2,
      });
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: pretty },
      });
    } catch {
      // sql-formatter throws on unparseable SQL; leave the text untouched.
    }
  }, []);

  return (
    <div className="flex shrink-0 flex-col border-b border-border/60 bg-card/40">
      <div className="flex items-start gap-2 px-2 py-1.5">
        <div
          ref={hostRef}
          className="min-w-0 flex-1 overflow-hidden rounded-sm border border-border/60 bg-background px-2"
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <BarButton onClick={handleFormat} title="Format SQL">
            Format
          </BarButton>
          <BarButton
            onClick={handleRun}
            disabled={busy}
            title="Run query (⌘/Ctrl+Enter)"
            variant="primary"
          >
            {busy ? "Running…" : "Run"}
          </BarButton>
          {hasResult && (
            <BarButton onClick={onClear} title="Clear query (browse mode)">
              Clear
            </BarButton>
          )}
          <div className="relative">
            <BarButton
              onClick={() => setExportOpen((v) => !v)}
              disabled={busy}
              title="Export result"
            >
              Export ▾
            </BarButton>
            {exportOpen && (
              <>
                {/* Click-away backdrop. */}
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setExportOpen(false)}
                />
                <div className="absolute right-0 z-20 mt-1 min-w-28 overflow-hidden rounded-sm border border-border/60 bg-popover py-1 shadow-md">
                  {EXPORT_OPTIONS.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => {
                        setExportOpen(false);
                        onExport(o.id);
                      }}
                      className="block w-full px-3 py-1 text-left text-[12px] text-popover-foreground hover:bg-accent"
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BarButton({
  children,
  onClick,
  disabled,
  title,
  variant = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  variant?: "default" | "primary";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "h-6 rounded-sm border px-2 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary"
          ? "border-ring/60 bg-accent text-foreground hover:bg-accent/80"
          : "border-border/60 bg-card text-foreground/80 hover:border-ring/50 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
