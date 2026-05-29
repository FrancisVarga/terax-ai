import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Formatted, lightly syntax-highlighted view of the bunqueue server +
 * worker log stream.
 *
 * The server prints ANSI-colored banners and JSON blobs; workers print
 * `[queue] …` tagged lines. We strip ANSI, then classify each line by level
 * and decorate tokens (level, worker tag, timestamps, JSON, URLs, numbers)
 * so the log is scannable instead of a raw wall of text.
 */
export function LogView({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const lines = useMemo(() => parseLines(text), [text]);

  useEffect(() => {
    const el = ref.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="h-full overflow-auto rounded-xl bg-muted/30 p-3 font-mono text-[11px] leading-relaxed"
    >
      {lines.length === 0 ? (
        <span className="text-muted-foreground">No output yet.</span>
      ) : (
        lines.map((line, i) => <LogLine key={i} line={line} />)
      )}
    </div>
  );
}

type Level = "error" | "warn" | "info" | "debug" | "plain";

type ParsedLine = {
  raw: string;
  level: Level;
  /** Worker/queue tag like "github-create-issue", if present. */
  tag: string | null;
  /** Text after the tag (or the whole line when untagged). */
  body: string;
};

// ANSI escape sequences (SGR color codes) bunqueue emits in its banner.
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

function parseLines(text: string): ParsedLine[] {
  if (!text) return [];
  return stripAnsi(text)
    .split("\n")
    // Drop a single trailing empty line from the final newline, keep interior
    // blanks so banners render with their spacing.
    .filter((l, idx, arr) => !(idx === arr.length - 1 && l === ""))
    .map((raw) => {
      const tagMatch = raw.match(/^\s*\[([a-z0-9:_-]+)\]\s?(.*)$/i);
      const tag = tagMatch ? tagMatch[1] : null;
      const body = tagMatch ? tagMatch[2] : raw;
      return { raw, level: classify(raw), tag, body };
    });
}

function classify(line: string): Level {
  const l = line.toLowerCase();
  if (/\b(error|fail|failed|fatal|exception|refused|denied)\b/.test(l))
    return "error";
  if (/\b(warn|warning|deprecat|retry|stall)\b/.test(l)) return "warn";
  if (/\b(debug|trace)\b/.test(l)) return "debug";
  if (/\b(ready|started|listening|completed|ok|success|connected)\b/.test(l))
    return "info";
  return "plain";
}

const LEVEL_STYLE: Record<Level, string> = {
  error: "text-destructive",
  warn: "text-amber-600 dark:text-amber-400",
  info: "text-emerald-600 dark:text-emerald-400",
  debug: "text-muted-foreground",
  plain: "text-muted-foreground",
};

const LEVEL_BAR: Record<Level, string> = {
  error: "bg-destructive",
  warn: "bg-amber-500",
  info: "bg-emerald-500",
  debug: "bg-border",
  plain: "bg-transparent",
};

function LogLine({ line }: { line: ParsedLine }) {
  return (
    <div className="group flex items-start gap-2 rounded px-1 hover:bg-foreground/5">
      <span
        className={cn("mt-[3px] h-3 w-0.5 shrink-0 rounded-full", LEVEL_BAR[line.level])}
        aria-hidden
      />
      <div className="min-w-0 flex-1 break-words whitespace-pre-wrap">
        {line.tag && (
          <span className="mr-1.5 rounded bg-primary/10 px-1 text-[10px] text-primary">
            {line.tag}
          </span>
        )}
        <span className={LEVEL_STYLE[line.level]}>{highlight(line.body)}</span>
      </div>
    </div>
  );
}

// Token highlighter: wraps timestamps, URLs, numbers, quoted strings, and
// braces in colored spans. Splits on a combined regex and styles matches.
const TOKEN =
  /(\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b|https?:\/\/[^\s"]+|"[^"]*"|\b\d+(?:\.\d+)?(?:ms|s|MB|KB|GB)?\b)/g;

function highlight(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  let key = 0;
  while ((m = TOKEN.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(
      <span key={key++} className={tokenClass(tok)}>
        {tok}
      </span>,
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function tokenClass(tok: string): string {
  if (/^https?:\/\//.test(tok)) return "text-sky-600 underline dark:text-sky-400";
  if (/^"/.test(tok)) return "text-teal-600 dark:text-teal-400";
  if (/^\d{4}-\d{2}-\d{2}/.test(tok)) return "text-violet-500 dark:text-violet-400";
  // numeric (with optional unit)
  return "text-orange-600 dark:text-orange-400";
}
