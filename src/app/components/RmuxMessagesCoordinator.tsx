import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  allMessages,
  useMessagesStore,
  type BusMessage,
  type BusTarget,
} from "@/modules/terminal-rmux";
import {
  Alert02Icon,
  Delete02Icon,
  InboxIcon,
  Mail01Icon,
  SentIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

/**
 * Self-contained coordinator for the rmux message bus (#138). It owns a floating
 * inbox button (with an unread badge), a dialog hosting (a) a per-pane inbox
 * viewer and (b) a compose form, and its own subscription to the live
 * `terax:rmux-message` Tauri event via useMessagesStore.
 *
 * FLAG GATE: like RmuxSessionsCoordinator, the rmux daemon flag is not surfaced
 * to the webview, so this gates indirectly on `daemonSeen` — set true only once a
 * delivered publish, a non-empty inbox read, OR a received live message proves a
 * connected daemon. With the flag off none of those happen, so the button stays
 * invisible and the coordinator issues no further calls beyond the one-time event
 * subscription (which is inert with no daemon emitting). It is fully self-mounted:
 * App.tsx adds it with no props, deriving everything from the store.
 */
export function RmuxMessagesCoordinator() {
  const [open, setOpen] = useState(false);
  const inboxes = useMessagesStore((s) => s.inboxes);
  const unread = useMessagesStore((s) => s.unread);
  const daemonSeen = useMessagesStore((s) => s.daemonSeen);
  const subscribe = useMessagesStore((s) => s.subscribe);
  const ack = useMessagesStore((s) => s.ack);
  const publish = useMessagesStore((s) => s.publish);

  // Subscribe to the live bus event once on mount. The store guards against a
  // double subscription (React StrictMode double-mount), so this is safe to run
  // unconditionally; the returned unlisten tears the listener down on unmount.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void subscribe().then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [subscribe]);

  // The flat, newest-first view across every watched pane inbox.
  const messages = useMemo(() => allMessages(inboxes), [inboxes]);

  // Stay invisible until a connected daemon is proven (see FLAG GATE above), but
  // never hide while the dialog is open (so an in-progress compose isn't yanked).
  if (!daemonSeen && !open) return null;

  return (
    <>
      <button
        type="button"
        aria-label="rmux messages"
        title="rmux messages"
        onClick={() => setOpen(true)}
        className={cn(
          "fixed bottom-20 right-3 z-30 flex h-9 w-9 items-center justify-center rounded-full",
          "border border-border/60 bg-card text-muted-foreground shadow-sm outline-none",
          "transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
          "focus-visible:ring-2 focus-visible:ring-primary/40",
        )}
      >
        <HugeiconsIcon icon={Mail01Icon} size={16} strokeWidth={1.75} />
        {unread > 0 ? (
          // Unread badge: a small count chip pinned to the button corner.
          <Badge
            variant="destructive"
            className={cn(
              "pointer-events-none absolute -right-1 -top-1 h-4 min-w-4 px-1",
              "justify-center rounded-full text-[10px] leading-none",
            )}
          >
            {unread > 99 ? "99+" : unread}
          </Badge>
        ) : null}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-0 p-0">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>rmux messages</DialogTitle>
            <DialogDescription>
              Inter-pane bus messages delivered to attached panes. View the inbox
              or compose a message to another pane, session, or window.
            </DialogDescription>
          </DialogHeader>
          <MessagesPanel
            messages={messages}
            onAck={async (paneIds) => {
              // Ack drains the daemon inbox for each touched pane; we re-read in
              // the store so the unread count and list reflect the daemon truth.
              try {
                await Promise.all(paneIds.map((id) => ack(id)));
              } catch (e) {
                toast.error("Could not clear inbox", { description: String(e) });
              }
            }}
            onPublish={async (from, to, type, payload, inject) => {
              try {
                const result = await publish(from, to, type, payload, inject);
                toast.success(
                  `Delivered to ${result.delivered} pane${
                    result.delivered === 1 ? "" : "s"
                  }`,
                );
                return true;
              } catch (e) {
                toast.error("Could not publish message", {
                  description: String(e),
                });
                return false;
              }
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The dialog body: a two-tab-free stacked layout with the inbox viewer on top
 * and the compose form below. Kept as a single panel (not a Tabs widget) to match
 * the compact, single-column feel of the SessionSwitcher.
 */
function MessagesPanel({
  messages,
  onAck,
  onPublish,
}: {
  messages: BusMessage[];
  onAck: (paneIds: number[]) => Promise<void>;
  onPublish: (
    from: number,
    to: BusTarget,
    type: string,
    payload: unknown,
    inject: boolean,
  ) => Promise<boolean>;
}) {
  // The set of distinct pane ids the visible messages were bucketed under, so
  // "clear" can ack each one's daemon inbox.
  const paneIds = useMemo(() => {
    const ids = new Set<number>();
    for (const m of messages) {
      ids.add(typeof m.to === "number" ? m.to : m.from);
    }
    return [...ids];
  }, [messages]);

  return (
    <div className="flex max-h-[32rem] min-h-0 flex-col">
      <InboxViewer messages={messages} onClear={() => void onAck(paneIds)} />
      <div className="border-t border-border/60" />
      <ComposeForm onPublish={onPublish} />
    </div>
  );
}

/** Inbox list: messages newest-first with from / type / payload preview / ts. */
function InboxViewer({
  messages,
  onClear,
}: {
  messages: BusMessage[];
  onClear: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/90">
          Inbox
        </span>
        {messages.length > 0 ? (
          <button
            type="button"
            aria-label="Clear inbox"
            title="Acknowledge and clear all messages"
            onClick={onClear}
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
            Clear
          </button>
        ) : null}
      </div>

      <div className="max-h-56 min-h-0 overflow-y-auto px-2 pb-2">
        {messages.length === 0 ? (
          <Empty className="border-0 p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={InboxIcon} size={20} strokeWidth={1.75} />
              </EmptyMedia>
              <EmptyTitle>No messages</EmptyTitle>
              <EmptyDescription>
                Messages delivered to attached panes appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {messages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A single inbox row: sender, type chip, a one-line payload preview, and time. */
function MessageRow({ message }: { message: BusMessage }) {
  // Render the payload as a compact single-line JSON preview. It is `unknown`
  // (the sender chose the shape), so stringify defensively and truncate.
  const preview = useMemo(() => payloadPreview(message.payload), [message.payload]);
  const time = useMemo(() => formatTs(message.ts), [message.ts]);

  return (
    <li className="rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/[0.04]">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">
          {message.type}
        </Badge>
        <span className="truncate text-[11px] text-muted-foreground">
          from pane {message.from}
          {message.inject ? " · injected" : ""}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
          {time}
        </span>
      </div>
      {preview ? (
        <p className="mt-0.5 truncate font-mono text-[11px] text-foreground/80">
          {preview}
        </p>
      ) : null}
    </li>
  );
}

/** The "to" picker mode. Mirrors the BusTarget union the form builds. */
type TargetMode = "pane" | "session" | "window" | "broadcast";

/**
 * Compose form: a target picker (pane id | session name | window name |
 * broadcast), a `from` pane id, a free-text `type`, a JSON `payload` textarea
 * with inline validation, an `inject` checkbox, and a submit that calls publish.
 */
function ComposeForm({
  onPublish,
}: {
  onPublish: (
    from: number,
    to: BusTarget,
    type: string,
    payload: unknown,
    inject: boolean,
  ) => Promise<boolean>;
}) {
  const [from, setFrom] = useState("");
  const [mode, setMode] = useState<TargetMode>("pane");
  const [targetValue, setTargetValue] = useState("");
  const [type, setType] = useState("");
  const [payloadText, setPayloadText] = useState("{}");
  const [inject, setInject] = useState(false);
  const [busy, setBusy] = useState(false);

  // Inline JSON validation for the payload textarea. An empty box is treated as
  // an empty object (a common "no body" case), otherwise it must parse.
  const payloadError = useMemo(() => {
    const text = payloadText.trim();
    if (text === "") return null;
    try {
      JSON.parse(text);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid JSON";
    }
  }, [payloadText]);

  // Build the BusTarget union from the picker, or null when the value is missing
  // / invalid (a numeric pane id must parse; names must be non-empty).
  const target = useMemo<BusTarget | null>(() => {
    if (mode === "broadcast") return "*";
    const value = targetValue.trim();
    if (mode === "pane") {
      const n = Number(value);
      return value !== "" && Number.isInteger(n) && n >= 0 ? n : null;
    }
    if (value === "") return null;
    return mode === "session" ? { session: value } : { window: value };
  }, [mode, targetValue]);

  const fromId = useMemo(() => {
    const n = Number(from.trim());
    return from.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : null;
  }, [from]);

  const canSubmit =
    !busy &&
    fromId !== null &&
    target !== null &&
    type.trim() !== "" &&
    payloadError === null;

  const submit = useCallback(async () => {
    if (fromId === null || target === null || type.trim() === "") return;
    // Re-parse here (canSubmit already proved it valid) so the published payload
    // is the parsed value, not the raw string. Empty box -> empty object.
    let payload: unknown = {};
    const text = payloadText.trim();
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        return; // Unreachable while canSubmit holds, but keeps types honest.
      }
    }
    setBusy(true);
    try {
      const ok = await onPublish(fromId, target, type.trim(), payload, inject);
      if (ok) {
        // Reset the volatile fields on success, keeping `from` (the user likely
        // sends several messages from the same pane).
        setType("");
        setPayloadText("{}");
        setInject(false);
      }
    } finally {
      setBusy(false);
    }
  }, [fromId, target, type, payloadText, inject, onPublish]);

  return (
    <div className="flex flex-col gap-2.5 px-4 py-3">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/90">
        Compose
      </span>

      {/* from + target: the sender pane id and the routing target. */}
      <div className="flex items-end gap-2">
        <div className="flex w-20 shrink-0 flex-col gap-1">
          <Label htmlFor="rmux-from" className="text-[11px]">
            From
          </Label>
          <Input
            id="rmux-from"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            inputMode="numeric"
            placeholder="pane"
            spellCheck={false}
            className="h-8 text-[12.5px]"
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Label className="text-[11px]">To</Label>
          <div className="flex items-center gap-1.5">
            <Select
              value={mode}
              onValueChange={(v) => {
                setMode(v as TargetMode);
                setTargetValue("");
              }}
            >
              <SelectTrigger size="sm" className="h-8 w-28 shrink-0 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pane">Pane</SelectItem>
                <SelectItem value="session">Session</SelectItem>
                <SelectItem value="window">Window</SelectItem>
                <SelectItem value="broadcast">Broadcast</SelectItem>
              </SelectContent>
            </Select>
            {mode !== "broadcast" ? (
              <Input
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                inputMode={mode === "pane" ? "numeric" : "text"}
                placeholder={mode === "pane" ? "pane id" : `${mode} name`}
                spellCheck={false}
                className="h-8 min-w-0 flex-1 text-[12.5px]"
              />
            ) : (
              <span className="flex-1 truncate text-[11px] text-muted-foreground">
                all panes
              </span>
            )}
          </div>
        </div>
      </div>

      {/* type: a free-text message type tag. */}
      <div className="flex flex-col gap-1">
        <Label htmlFor="rmux-type" className="text-[11px]">
          Type
        </Label>
        <Input
          id="rmux-type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          placeholder="e.g. ping"
          spellCheck={false}
          className="h-8 text-[12.5px]"
        />
      </div>

      {/* payload: a JSON body with inline validation. */}
      <div className="flex flex-col gap-1">
        <Label htmlFor="rmux-payload" className="text-[11px]">
          Payload (JSON)
        </Label>
        <Textarea
          id="rmux-payload"
          value={payloadText}
          onChange={(e) => setPayloadText(e.target.value)}
          spellCheck={false}
          aria-invalid={payloadError !== null}
          className="min-h-16 rounded-md px-2.5 py-2 font-mono text-[12px]"
        />
        {payloadError ? (
          <span className="flex items-start gap-1 text-[11px] text-destructive">
            <HugeiconsIcon
              icon={Alert02Icon}
              size={12}
              strokeWidth={1.75}
              className="mt-0.5 shrink-0"
            />
            <span className="break-words">{payloadError}</span>
          </span>
        ) : null}
      </div>

      {/* inject + submit. */}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <Label className="flex items-center gap-2 text-[12px] font-normal">
          <Checkbox
            checked={inject}
            onCheckedChange={(c) => setInject(c === true)}
          />
          Inject into pane stdin
        </Label>
        <Button
          size="sm"
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="gap-1.5"
        >
          <HugeiconsIcon icon={SentIcon} size={14} strokeWidth={1.75} />
          Send
        </Button>
      </div>
    </div>
  );
}

/** A compact single-line JSON preview of a message payload (truncated upstream
 *  by CSS). Returns "" for null/undefined so the row omits the preview line. */
function payloadPreview(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/** Format a daemon epoch-ms timestamp as a local HH:MM:SS. Falls back to "" for
 *  a missing/invalid ts so the row simply omits the time. */
function formatTs(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  return new Date(ts).toLocaleTimeString();
}
