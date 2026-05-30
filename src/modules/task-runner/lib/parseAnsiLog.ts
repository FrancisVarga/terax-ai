import { classifyLine, type LogLevel } from "@/modules/log/lib/parseLog";

/**
 * One styled run of text within a log line. `color`/`bold` come from ANSI SGR
 * escape codes the build tool emitted; `url`, when set, marks the run as a
 * clickable link (the run's `text` is the href).
 */
export type AnsiSegment = {
  text: string;
  color?: string;
  bold?: boolean;
  /** Present when this segment is a detected URL — render as a link. */
  url?: string;
};

/**
 * A single parsed output line: a severity `level` (for the gutter accent + tint,
 * shared with the file log viewer) plus the ANSI-styled `segments` that compose
 * its visible text. `n` is the 1-based line number.
 */
export type AnsiLine = {
  n: number;
  level: LogLevel;
  segments: AnsiSegment[];
};

// The 8 standard + 8 bright ANSI foreground colors as CSS, tuned to read on
// both light and dark surfaces. (Same palette the old flat parser used.)
const FG: Record<number, string> = {
  30: "#555",
  31: "#d1413a",
  32: "#3a9d3a",
  33: "#b58900",
  34: "#3a6fd1",
  35: "#a33ad1",
  36: "#1f9ca8",
  37: "#aaa",
  90: "#888",
  91: "#f05a4f",
  92: "#4fc04f",
  93: "#d4a017",
  94: "#5a8af0",
  95: "#c05ae0",
  96: "#2fc0cf",
  97: "#ddd",
};

// Any ANSI escape: SGR (`m`, which we interpret) plus everything else (cursor
// moves, clears) which we consume and drop so it never leaks as visible text.
// eslint-disable-next-line no-control-regex
const ESC = /\x1b\[([0-9;]*)([A-Za-z])/g;

// Strip every ANSI escape — used to get the plain text for level classification
// without escape bytes tripping the word-boundary regexes.
// eslint-disable-next-line no-control-regex
const STRIP_ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

// http/https URLs. Trailing punctuation (.,;:) is excluded so a URL at the end
// of a sentence doesn't swallow the period.
const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

/** Map a 256-color index (`38;5;N`) to a hex/rgb string (cube + gray ramp). */
function ansi256(n: number): string {
  if (n < 16) return FG[n < 8 ? 30 + n : 82 + n] ?? "#aaa";
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const ch = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
}

/**
 * Split one raw line (which may embed ANSI SGR escapes) into styled segments,
 * carrying SGR state forward across the line. URLs in plain text are further
 * split out into `url` segments so they render as links.
 */
function lineToSegments(raw: string): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  let last = 0;
  let color: string | undefined;
  let bold = false;

  const push = (text: string) => {
    if (!text) return;
    // Linkify within this styled run: emit plain + url sub-segments in order.
    URL_RE.lastIndex = 0;
    let cursor = 0;
    let u: RegExpExecArray | null;
    while ((u = URL_RE.exec(text)) !== null) {
      if (u.index > cursor)
        out.push({ text: text.slice(cursor, u.index), color, bold });
      out.push({ text: u[0], color, bold, url: u[0] });
      cursor = u.index + u[0].length;
    }
    if (cursor < text.length)
      out.push({ text: text.slice(cursor), color, bold });
  };

  ESC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESC.exec(raw)) !== null) {
    if (m.index > last) push(raw.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== "m") continue; // non-SGR escape: dropped

    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        color = undefined;
        bold = false;
      } else if (c === 1) {
        bold = true;
      } else if (c === 22) {
        bold = false;
      } else if (c === 39) {
        color = undefined;
      } else if (FG[c]) {
        color = FG[c];
      } else if (c === 38 && codes[i + 1] === 5) {
        color = ansi256(codes[i + 2]);
        i += 2;
      }
    }
  }
  if (last < raw.length) push(raw.slice(last));
  return out;
}

/**
 * Parse a raw task-output byte stream into classified, ANSI-styled lines.
 * Newlines are normalized; a single trailing newline does not yield a phantom
 * empty line. Each line is classified by its ANSI-stripped text so severity
 * detection never trips on escape bytes.
 */
export function parseAnsiLog(raw: string): AnsiLine[] {
  if (!raw) return [];
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "")
    rawLines.pop();

  return rawLines.map((line, i) => {
    const plain = line.replace(STRIP_ANSI, "");
    return {
      n: i + 1,
      level: classifyLine(plain),
      segments: lineToSegments(line),
    };
  });
}
