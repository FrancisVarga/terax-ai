import { useEffect, useMemo, useRef } from "react";

/** Plain tailing view of the KV server stdout/stderr stream, auto-scrolled to
 *  the bottom while the user is already at the bottom. */
export function LogView({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const lines = useMemo(
    () => (text ? text.replace(/\n$/, "").split("\n") : []),
    [text],
  );

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
        lines.map((line, i) => (
          <div key={i} className="break-words whitespace-pre-wrap">
            {line || " "}
          </div>
        ))
      )}
    </div>
  );
}
