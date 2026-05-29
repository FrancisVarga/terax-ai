import { cn } from "@/lib/utils";
import { Activity03Icon, ConnectIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  fmtClock,
  severityLevel,
  type LogRow,
} from "../../lib/useOtel";
import {
  CopyButton,
  DetailSection,
  DetailShell,
  KvRow,
} from "./DetailShell";

/**
 * Full-page log-record detail: severity + timestamps, the full body, any
 * stack-trace blobs, trace/span correlation (with a jump to the trace), and the
 * complete attribute + resource sets. A promotion of the inline log expander to
 * a dedicated page with room for long bodies and stacks.
 */
export function LogDetail({
  log,
  onBack,
  onOpenTrace,
}: {
  log: LogRow;
  onBack: () => void;
  onOpenTrace?: (traceId: string) => void;
}) {
  const sev = severityLevel(log.severityNumber);
  const attrs = Object.entries(log.attributes ?? {});
  const resource = Object.entries(log.resource ?? {});
  const stacks = attrs.filter(([k, v]) => isStackLike(k, String(v)));
  const scalars = attrs.filter(([k, v]) => !isStackLike(k, String(v)));

  return (
    <DetailShell
      title={log.body || "(empty log)"}
      subtitle={`${log.service}${log.scopeName ? ` · ${log.scopeName}` : ""}`}
      icon={<HugeiconsIcon icon={Activity03Icon} size={16} strokeWidth={1.75} className={sev.cls} />}
      onBack={onBack}
      actions={
        log.traceId && onOpenTrace ? (
          <button
            type="button"
            onClick={() => onOpenTrace(log.traceId)}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={ConnectIcon} size={12} strokeWidth={1.75} />
            View trace
          </button>
        ) : undefined
      }
    >
      {/* Header facts */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-muted-foreground">
        <span className={cn("font-semibold", sev.cls)}>
          {sev.label || log.severityText} ({log.severityNumber})
        </span>
        <span>emitted {fmtClock(log.timeNano)}</span>
        {log.observedTimeNano > 0 && log.observedTimeNano !== log.timeNano && (
          <span>observed {fmtClock(log.observedTimeNano)}</span>
        )}
        <span>service {log.service}</span>
      </div>

      {/* Body */}
      <DetailSection title="Body">
        <div className="relative rounded-lg border border-border/50 bg-background/40 p-3">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90">
            {log.body || "(empty)"}
          </pre>
          <div className="absolute right-2 top-2">
            <CopyButton text={log.body} />
          </div>
        </div>
      </DetailSection>

      {/* Stack traces */}
      {stacks.map(([k, v]) => (
        <DetailSection key={k} title={k}>
          <div className="relative rounded-lg border border-border/50 bg-background/40 p-3">
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-foreground/85">
              {prettyStack(String(v))}
            </pre>
            <div className="absolute right-2 top-2">
              <CopyButton text={String(v)} />
            </div>
          </div>
        </DetailSection>
      ))}

      {/* Correlation */}
      {(log.traceId || log.spanId) && (
        <DetailSection title="Correlation">
          <div className="flex flex-col gap-0.5 rounded-lg border border-border/50 bg-background/40 p-3">
            {log.traceId && <KvRow k="trace.id" v={log.traceId} />}
            {log.spanId && <KvRow k="span.id" v={log.spanId} />}
          </div>
        </DetailSection>
      )}

      {/* Attributes */}
      {scalars.length > 0 && (
        <DetailSection title="Attributes" count={scalars.length}>
          <div className="flex flex-col gap-0.5 rounded-lg border border-border/50 bg-background/40 p-3">
            {scalars.map(([k, v]) => (
              <KvRow key={k} k={k} v={String(v)} />
            ))}
          </div>
        </DetailSection>
      )}

      {/* Resource */}
      {resource.length > 0 && (
        <DetailSection title="Resource" count={resource.length}>
          <div className="flex flex-col gap-0.5 rounded-lg border border-border/50 bg-background/40 p-3">
            {resource.map(([k, v]) => (
              <KvRow key={k} k={k} v={String(v)} />
            ))}
          </div>
        </DetailSection>
      )}
    </DetailShell>
  );
}

function isStackLike(key: string, value: string): boolean {
  const k = key.toLowerCase();
  return (
    value.includes("\n") ||
    (value.length > 120 && (k.includes("stack") || k.includes("trace") || k.includes("exception")))
  );
}

function prettyStack(value: string): string {
  if (value.includes("\n")) return value;
  return value.replace(/\s+at\s+/g, "\n    at ");
}
