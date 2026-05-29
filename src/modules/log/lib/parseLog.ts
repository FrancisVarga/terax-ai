/** Severity buckets a log line can be classified into. */
export type LogLevel =
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "none";

export type LogLine = {
  /** 1-based line number. */
  n: number;
  text: string;
  level: LogLevel;
};

// Level is detected from a standalone token (word-boundaried, case-insensitive)
// so substrings like "information" or "errorCode" don't trigger false hits.
const LEVEL_PATTERNS: Array<[LogLevel, RegExp]> = [
  ["error", /\b(error|err|fatal|fail(?:ed|ure)?|panic|exception)\b/i],
  ["warn", /\b(warn(?:ing)?)\b/i],
  ["info", /\b(info|notice)\b/i],
  ["debug", /\b(debug|dbg)\b/i],
  ["trace", /\b(trace|verbose|vrb)\b/i],
];

/** Classifies one raw log line by the first severity keyword it contains. */
export function classifyLine(text: string): LogLevel {
  for (const [level, re] of LEVEL_PATTERNS) {
    if (re.test(text)) return level;
  }
  return "none";
}

/** Splits raw log text into classified lines. A trailing newline does not
 *  produce a phantom empty line. */
export function parseLog(raw: string): LogLine[] {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  // Drop a single trailing empty line caused by a final newline.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((text, i) => ({
    n: i + 1,
    text,
    level: classifyLine(text),
  }));
}
