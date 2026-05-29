import { cn } from "@/lib/utils";
import type { LogLevel } from "@/modules/log/lib/parseLog";
import {
  ArrowDownDoubleIcon,
  ArrowRight01Icon,
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  Search01Icon,
  TextWrapIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type GroupMode,
  type LogEntry,
  type LogGroup,
  groupLog,
} from "../lib/groupLog";
import { type AnsiLine, type AnsiSegment, parseAnsiLog } from "../lib/parseAnsiLog";

/**
 * A proper viewer for a task's raw output stream. On top of ANSI SGR colors it
 * adds: grouping (collapse adjacent duplicates, fold stack traces / continuation
 * lines, bucket by severity or source), structured formatting (timestamp · level
 * · message columns, pretty-printed JSON), per-line severity highlighting, a
 * line-number gutter, URL linkification, in-pane search, soft-wrap, copy, and an
 * autoscroll pin. Rows are virtualized over a flattened group/entry/fold list so
 * collapsibles and tall JSON blobs stay smooth.
 */
export function AnsiLog({
  text,
  onClear,
}: {
  text: string;
  onClear?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [structured, setStructured] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>("none");
  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState(false);
  const [copied, setCopied] = useState(false);
  // Collapsed state keyed by stable id: section labels and entry fold keys.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const allLines = useMemo(() => parseAnsiLog(text), [text]);

  const q = query.trim().toLowerCase();
  const lineText = useCallback(
    (l: AnsiLine) => l.segments.map((s) => s.text).join(""),
    [],
  );

  // Search filters at the line level *before* grouping so folds/sections only
  // contain matching content.
  const visibleLines = useMemo(() => {
    if (!filterMode || q === "") return allLines;
    return allLines.filter((l) => lineText(l).toLowerCase().includes(q));
  }, [allLines, filterMode, q, lineText]);

  const matchCount = useMemo(
    () =>
      q === ""
        ? 0
        : allLines.filter((l) => lineText(l).toLowerCase().includes(q)).length,
    [allLines, q, lineText],
  );

  const groups = useMemo(
    () => groupLog(visibleLines, groupMode),
    [visibleLines, groupMode],
  );

  // Flatten groups → entries → (optional) continuation rows into one render
  // list the virtualizer can index. Collapsing a section or fold simply omits
  // its child rows.
  const rows = useMemo(
    () => flattenRows(groups, collapsed, groupMode),
    [groups, collapsed, groupMode],
  );

  const lastLineNo = useMemo(() => {
    let max = 1;
    for (const g of groups)
      for (const e of g.entries) if (e.n > max) max = e.n;
    return max;
  }, [groups]);
  const gutterWidth = Math.max(2, String(lastLineNo).length) + 1;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
    // Variable heights: JSON blobs and wrapped lines are taller than one row.
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    atBottomRef.current = atBottom;
    setPinned(atBottom);
  };

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setPinned(true);
  }, []);

  // Auto-follow only while pinned. Grouped/severity views don't auto-follow
  // (order isn't chronological), so this only fires in stream order modes.
  useEffect(() => {
    if (atBottomRef.current && groupMode !== "severity") {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [rows, groupMode]);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const copyAll = useCallback(() => {
    const plain = allLines.map(lineText).join("\n");
    void navigator.clipboard.writeText(plain).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [allLines, lineText]);

  const empty = allLines.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      {/* Toolbar row 1: search */}
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border/50 px-2">
        <HugeiconsIcon
          icon={Search01Icon}
          size={12}
          className="shrink-0 text-muted-foreground"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search output…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />
        {q !== "" ? (
          <>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {matchCount}
            </span>
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} />
            </button>
          </>
        ) : null}
      </div>

      {/* Toolbar row 2: grouping + format + actions */}
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border/50 px-2">
        <span className="mr-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Group
        </span>
        <SegGroup
          value={groupMode}
          onChange={setGroupMode}
          options={[
            ["none", "None"],
            ["collapse", "Dups"],
            ["severity", "Level"],
            ["source", "Source"],
          ]}
        />

        <div className="mx-1 h-3.5 w-px bg-border/60" />

        <ToolbarButton
          active={structured}
          onClick={() => setStructured((v) => !v)}
          label={structured ? "Raw view" : "Structured columns + JSON"}
        >
          <span className="text-[10px] font-medium">Format</span>
        </ToolbarButton>
        <ToolbarButton
          active={filterMode}
          disabled={q === ""}
          onClick={() => setFilterMode((v) => !v)}
          label={filterMode ? "Show all lines" : "Show only matches"}
        >
          <span className="text-[10px] font-medium">Filter</span>
        </ToolbarButton>
        <ToolbarButton
          active={wrap}
          onClick={() => setWrap((v) => !v)}
          label={wrap ? "Disable wrap" : "Enable wrap"}
        >
          <HugeiconsIcon icon={TextWrapIcon} size={13} />
        </ToolbarButton>

        <div className="flex-1" />

        <ToolbarButton onClick={copyAll} label="Copy all output">
          <HugeiconsIcon
            icon={copied ? Tick02Icon : Copy01Icon}
            size={12}
            className={copied ? "text-emerald-500" : undefined}
          />
        </ToolbarButton>
        {onClear ? (
          <ToolbarButton onClick={onClear} label="Clear output">
            <HugeiconsIcon icon={Delete02Icon} size={12} />
          </ToolbarButton>
        ) : null}
      </div>

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        {empty ? (
          <div className="px-3 py-3 font-mono text-[11px] text-muted-foreground">
            Waiting for output…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-3 font-mono text-[11px] text-muted-foreground">
            No lines match “{query}”.
          </div>
        ) : (
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="h-full select-text overflow-auto font-mono text-[11px] leading-[16px]"
          >
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: "relative",
                width: "100%",
              }}
            >
              {virtualizer.getVirtualItems().map((vr) => {
                const row = rows[vr.index];
                if (!row) return null;
                return (
                  <div
                    key={row.id}
                    data-index={vr.index}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${vr.start}px)` }}
                  >
                    <RenderRow
                      row={row}
                      wrap={wrap}
                      structured={structured}
                      query={q}
                      gutterWidth={gutterWidth}
                      collapsed={collapsed}
                      onToggle={toggle}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!pinned && !empty && rows.length > 0 ? (
          <button
            type="button"
            onClick={scrollToBottom}
            title="Jump to bottom"
            className="absolute bottom-2 right-3 flex items-center gap-1 rounded-full border border-border/60 bg-background/90 px-2 py-1 text-[10px] text-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent"
          >
            <HugeiconsIcon icon={ArrowDownDoubleIcon} size={11} />
            Bottom
          </button>
        ) : null}
      </div>
    </div>
  );
}

const ROW_HEIGHT = 16;

const LEVEL_STYLE: Record<LogLevel, { text: string; accent: string }> = {
  error: { text: "text-rose-400", accent: "bg-rose-500/80" },
  warn: { text: "text-amber-400", accent: "bg-amber-500/80" },
  info: { text: "text-sky-400/90", accent: "bg-sky-500/70" },
  debug: { text: "text-emerald-400/85", accent: "bg-emerald-500/60" },
  trace: { text: "text-muted-foreground", accent: "bg-muted-foreground/40" },
  none: { text: "text-foreground/85", accent: "bg-transparent" },
};

// ── Flattened render rows ───────────────────────────────────────────────────

type RenderRow =
  | { kind: "section"; id: string; label: string; level?: LogLevel; n: number }
  | { kind: "entry"; id: string; entry: LogEntry }
  | { kind: "cont"; id: string; line: AnsiLine; n: number }
  | { kind: "json"; id: string; json: string; n: number };

/** Section id used both as a collapse key and a React key. */
const sectionId = (g: LogGroup) => `sec:${g.label || "_"}`;

function flattenRows(
  groups: LogGroup[],
  collapsed: Set<string>,
  mode: GroupMode,
): RenderRow[] {
  const rows: RenderRow[] = [];
  const sectioned = mode === "severity" || mode === "source";

  for (const g of groups) {
    const sid = sectionId(g);
    if (sectioned) {
      rows.push({
        kind: "section",
        id: sid,
        label: g.label,
        level: g.level,
        n: g.entries[0]?.n ?? 0,
      });
      if (collapsed.has(sid)) continue; // section folded: skip its entries
    }
    for (const e of g.entries) {
      rows.push({ kind: "entry", id: `e:${sid}:${e.key}`, entry: e });
      const foldId = `fold:${sid}:${e.key}`;
      const foldOpen = !collapsed.has(foldId);
      if (foldOpen) {
        if (e.fields.json) {
          rows.push({
            kind: "json",
            id: `${foldId}:json`,
            json: e.fields.json,
            n: e.n,
          });
        }
        for (let i = 0; i < e.continuation.length; i++) {
          const line = e.continuation[i];
          rows.push({
            kind: "cont",
            id: `${foldId}:c${i}`,
            line,
            n: line.n,
          });
        }
      }
    }
  }
  return rows;
}

function RenderRow({
  row,
  wrap,
  structured,
  query,
  gutterWidth,
  collapsed,
  onToggle,
}: {
  row: RenderRow;
  wrap: boolean;
  structured: boolean;
  query: string;
  gutterWidth: number;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (row.kind === "section") {
    const open = !collapsed.has(row.id);
    const lv = row.level ? LEVEL_STYLE[row.level] : undefined;
    return (
      <button
        type="button"
        onClick={() => onToggle(row.id)}
        className="flex w-full items-center gap-1.5 border-y border-border/30 bg-muted/40 px-2 py-1 text-left hover:bg-muted/60"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={12}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className={cn("size-1.5 rounded-full", lv?.accent ?? "bg-muted-foreground/40")} />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground/80">
          {row.label || "—"}
        </span>
      </button>
    );
  }

  if (row.kind === "json") {
    return (
      <div className="flex w-full items-start">
        <span aria-hidden className="h-full w-[2px] shrink-0 bg-transparent" />
        <span
          className="shrink-0 select-none px-2 text-right tabular-nums text-transparent"
          style={{ width: `${gutterWidth}ch` }}
        >
          ·
        </span>
        <pre className="m-0 min-w-0 flex-1 overflow-x-auto rounded bg-foreground/[0.04] px-2 py-1 pr-3 text-[10.5px] leading-[15px] text-foreground/80">
          {row.json}
        </pre>
      </div>
    );
  }

  if (row.kind === "cont") {
    const lv = LEVEL_STYLE[row.line.level];
    return (
      <LineRow
        segments={row.line.segments}
        level={row.line.level}
        n={row.n}
        wrap={wrap}
        query={query}
        gutterWidth={gutterWidth}
        textClass={lv.text}
        accentClass="bg-transparent"
        dim
      />
    );
  }

  // entry
  const e = row.entry;
  const lv = LEVEL_STYLE[e.level];
  const foldId = row.id.replace(/^e:/, "fold:");
  const hasFold = e.continuation.length > 0 || !!e.fields.json;
  const foldOpen = !collapsed.has(foldId);

  if (structured) {
    return (
      <StructuredEntryRow
        entry={e}
        n={e.n}
        wrap={wrap}
        query={query}
        gutterWidth={gutterWidth}
        lv={lv}
        hasFold={hasFold}
        foldOpen={foldOpen}
        onToggleFold={() => onToggle(foldId)}
      />
    );
  }

  return (
    <LineRow
      segments={e.segments}
      level={e.level}
      n={e.n}
      wrap={wrap}
      query={query}
      gutterWidth={gutterWidth}
      textClass={lv.text}
      accentClass={lv.accent}
      count={e.count}
      hasFold={hasFold}
      foldOpen={foldOpen}
      onToggleFold={hasFold ? () => onToggle(foldId) : undefined}
    />
  );
}

/** The common one-line row: accent · [fold] · gutter · [count] · text. */
function LineRow({
  segments,
  n,
  wrap,
  query,
  gutterWidth,
  textClass,
  accentClass,
  count,
  hasFold,
  foldOpen,
  onToggleFold,
  dim,
}: {
  segments: AnsiSegment[];
  level: LogLevel;
  n: number;
  wrap: boolean;
  query: string;
  gutterWidth: number;
  textClass: string;
  accentClass: string;
  count?: number;
  hasFold?: boolean;
  foldOpen?: boolean;
  onToggleFold?: () => void;
  dim?: boolean;
}) {
  return (
    <div className="flex w-full items-start hover:bg-foreground/[0.03]">
      <span aria-hidden className={cn("min-h-[16px] w-[2px] shrink-0 self-stretch", accentClass)} />
      {hasFold ? (
        <button
          type="button"
          onClick={onToggleFold}
          aria-label={foldOpen ? "Collapse" : "Expand"}
          className="flex w-3 shrink-0 items-center justify-center self-stretch text-muted-foreground/60 hover:text-foreground"
        >
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={10}
            className={cn("transition-transform", foldOpen && "rotate-90")}
          />
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <span
        className="shrink-0 select-none px-1 text-right tabular-nums text-muted-foreground/45"
        style={{ width: `${gutterWidth}ch` }}
      >
        {n}
      </span>
      {count && count > 1 ? (
        <span className="mr-1 shrink-0 self-center rounded-full bg-foreground/10 px-1.5 text-[9px] font-semibold tabular-nums text-foreground/70">
          ×{count}
        </span>
      ) : null}
      <pre
        className={cn(
          "m-0 min-w-0 flex-1 pr-3 font-mono",
          wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
          textClass,
          dim && "opacity-70",
        )}
      >
        {segments.length === 0 ? (
          " "
        ) : (
          segments.map((seg, i) => (
            <SegmentSpan key={i} seg={seg} query={query} />
          ))
        )}
      </pre>
    </div>
  );
}

/** Structured columns: time · level · message, with the message linkified. */
function StructuredEntryRow({
  entry,
  n,
  wrap,
  query,
  gutterWidth,
  lv,
  hasFold,
  foldOpen,
  onToggleFold,
}: {
  entry: LogEntry;
  n: number;
  wrap: boolean;
  query: string;
  gutterWidth: number;
  lv: { text: string; accent: string };
  hasFold: boolean;
  foldOpen: boolean;
  onToggleFold: () => void;
}) {
  const { ts, source, message } = entry.fields;
  return (
    <div className="flex w-full items-start hover:bg-foreground/[0.03]">
      <span aria-hidden className={cn("min-h-[16px] w-[2px] shrink-0 self-stretch", lv.accent)} />
      {hasFold ? (
        <button
          type="button"
          onClick={onToggleFold}
          aria-label={foldOpen ? "Collapse" : "Expand"}
          className="flex w-3 shrink-0 items-center justify-center self-stretch text-muted-foreground/60 hover:text-foreground"
        >
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={10}
            className={cn("transition-transform", foldOpen && "rotate-90")}
          />
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <span
        className="shrink-0 select-none px-1 text-right tabular-nums text-muted-foreground/40"
        style={{ width: `${gutterWidth}ch` }}
      >
        {n}
      </span>
      {entry.count > 1 ? (
        <span className="mr-1 shrink-0 self-center rounded-full bg-foreground/10 px-1.5 text-[9px] font-semibold tabular-nums text-foreground/70">
          ×{entry.count}
        </span>
      ) : null}
      {ts ? (
        <span className="mr-2 shrink-0 select-text tabular-nums text-muted-foreground/55">
          {ts}
        </span>
      ) : null}
      {entry.level !== "none" ? (
        <span
          className={cn(
            "mr-2 w-10 shrink-0 text-[9px] font-semibold uppercase",
            lv.text,
          )}
        >
          {entry.level}
        </span>
      ) : null}
      {source ? (
        <span className="mr-2 shrink-0 rounded bg-foreground/[0.06] px-1 text-[9px] text-muted-foreground">
          {source}
        </span>
      ) : null}
      <pre
        className={cn(
          "m-0 min-w-0 flex-1 pr-3 font-mono text-foreground/85",
          wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
        )}
      >
        {highlightLinkify(message, query)}
      </pre>
    </div>
  );
}

function SegmentSpan({ seg, query }: { seg: AnsiSegment; query: string }) {
  const style: React.CSSProperties | undefined =
    seg.color || seg.bold
      ? { color: seg.color, fontWeight: seg.bold ? 600 : undefined }
      : undefined;
  const inner = query ? highlight(seg.text, query) : seg.text;
  if (seg.url) {
    return (
      <a
        href={seg.url}
        target="_blank"
        rel="noreferrer"
        style={style}
        className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
      >
        {inner}
      </a>
    );
  }
  return <span style={style}>{inner}</span>;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

/** Plain-string message → linkified + search-highlighted nodes (structured
 *  view, where segments were already flattened to a message string). */
function highlightLinkify(text: string, query: string): React.ReactNode {
  URL_RE.lastIndex = 0;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > cursor)
      parts.push(<span key={`t${cursor}`}>{highlight(text.slice(cursor, m.index), query)}</span>);
    parts.push(
      <a
        key={`u${m.index}`}
        href={m[0]}
        target="_blank"
        rel="noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
      >
        {highlight(m[0], query)}
      </a>,
    );
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length)
    parts.push(<span key={`t${cursor}`}>{highlight(text.slice(cursor), query)}</span>);
  return parts;
}

/** Wrap case-insensitive matches of `query` with a highlight mark. */
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let from = 0;
  while ((i = lower.indexOf(query, from)) !== -1) {
    if (i > from) parts.push(text.slice(from, i));
    parts.push(
      <mark key={i} className="rounded-[2px] bg-amber-400/30 text-inherit">
        {text.slice(i, i + query.length)}
      </mark>,
    );
    from = i + query.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

function SegGroup({
  value,
  onChange,
  options,
}: {
  value: GroupMode;
  onChange: (v: GroupMode) => void;
  options: Array<[GroupMode, string]>;
}) {
  return (
    <div className="flex items-center rounded border border-border/50 p-0.5">
      {options.map(([val, label]) => (
        <button
          key={val}
          type="button"
          onClick={() => onChange(val)}
          aria-pressed={value === val}
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
            value === val
              ? "bg-foreground/[0.1] text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  label,
  active,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex h-5 min-w-5 items-center justify-center rounded px-1 text-muted-foreground transition-colors",
        disabled
          ? "cursor-not-allowed opacity-40"
          : "hover:bg-accent hover:text-foreground",
        active && !disabled && "bg-foreground/[0.08] text-foreground",
      )}
    >
      {children}
    </button>
  );
}
