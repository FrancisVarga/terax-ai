import { useEffect, useMemo, useRef } from "react";

/**
 * Renders a raw byte stream that may contain ANSI SGR escape codes (the colored
 * output `vite`, `tsc`, `eslint`, etc. emit) into highlighted, scroll-pinned
 * React spans. We parse the SGR subset that build tools actually use —
 * foreground colors (30-37 / 90-97 / 38;5;N), bold, and reset — and drop every
 * other escape sequence (cursor moves, clears) so they don't leak as text.
 *
 * Mapping the 16 ANSI colors to CSS keeps the output legible across themes
 * (the bright variants read fine on both light and dark surfaces).
 */
export function AnsiLog({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    atBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const segments = useMemo(() => parseAnsi(text), [text]);

  // Auto-scroll only when the user is already pinned to the bottom, so reading
  // back through history isn't yanked away by new output.
  useEffect(() => {
    const el = ref.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [segments]);

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="h-full overflow-auto whitespace-pre-wrap break-words bg-muted/20 p-3 font-mono text-[11px] leading-relaxed text-foreground/90"
    >
      {segments.length === 0 ? (
        <span className="text-muted-foreground">Waiting for output…</span>
      ) : (
        segments.map((seg, i) => (
          <span key={i} className={seg.className} style={seg.style}>
            {seg.text}
          </span>
        ))
      )}
    </div>
  );
}

type Segment = {
  text: string;
  className?: string;
  style?: React.CSSProperties;
};

// CSS for the 8 standard + 8 bright ANSI foreground colors. Tuned to stay
// readable on both light and dark backgrounds.
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

// Matches any ANSI escape: SGR (`m`) and everything else we discard.
// eslint-disable-next-line no-control-regex
const ESC = /\[([0-9;]*)([A-Za-z])/g;

function parseAnsi(text: string): Segment[] {
  if (!text) return [];
  const out: Segment[] = [];
  let last = 0;
  let color: string | undefined;
  let bold = false;

  const styleOf = (): React.CSSProperties | undefined => {
    if (!color && !bold) return undefined;
    return { color, fontWeight: bold ? 600 : undefined };
  };

  ESC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESC.exec(text)) !== null) {
    if (m.index > last) {
      const chunk = text.slice(last, m.index);
      if (chunk) out.push({ text: chunk, style: styleOf() });
    }
    last = m.index + m[0].length;
    if (m[2] !== "m") continue; // non-SGR escape: consume and drop

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
        // 256-color: approximate by reusing the nearest base color slot.
        const n = codes[i + 2];
        color = ansi256(n);
        i += 2;
      }
    }
  }
  if (last < text.length) {
    const chunk = text.slice(last);
    if (chunk) out.push({ text: chunk, style: styleOf() });
  }
  return out;
}

/** Map a 256-color index to a hex string (cube + grayscale ramp). */
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
