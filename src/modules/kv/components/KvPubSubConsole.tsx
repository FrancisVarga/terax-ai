import { useEffect, useRef, useState } from "react";
import { RssIcon, SentIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { UseKvPubSub } from "../hooks/useKvPubSub";
import { formatClock } from "../lib/format";
import { EmptyHint } from "./parts";

/**
 * Pub/Sub pane: subscribe to channels (comma/space separated), tail incoming
 * messages, and publish to a channel. The subscription lives in `useKvPubSub`
 * so it survives tab switches.
 */
export function KvPubSubConsole({
  pubsub,
  disabled,
}: {
  pubsub: UseKvPubSub;
  disabled: boolean;
}) {
  const [subInput, setSubInput] = useState("");
  const [pubChannel, setPubChannel] = useState("");
  const [pubMessage, setPubMessage] = useState("");

  const logRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    const el = logRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [pubsub.messages]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const doSubscribe = async () => {
    const channels = subInput.split(/[\s,]+/).filter(Boolean);
    await pubsub.subscribe(channels);
  };

  const doPublish = async () => {
    try {
      const receivers = await pubsub.publish(pubChannel, pubMessage);
      toast.success(`Published to ${receivers} receiver(s)`);
      setPubMessage("");
    } catch {
      // Error surfaced via pubsub.error / toast below.
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex flex-1 items-center gap-1">
          <Input
            value={subInput}
            onChange={(e) => setSubInput(e.target.value)}
            placeholder="Channels to subscribe, e.g. news, alerts:*"
            spellCheck={false}
            className="h-8 text-xs"
          />
          {pubsub.subscribed ? (
            <Button variant="outline" size="sm" onClick={pubsub.unsubscribe}>
              Unsubscribe
            </Button>
          ) : (
            <Button size="sm" onClick={() => void doSubscribe()} disabled={disabled}>
              <HugeiconsIcon icon={RssIcon} size={14} strokeWidth={1.75} />
              Subscribe
            </Button>
          )}
        </div>
      </div>

      {pubsub.subscribed ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">subscribed:</span>
          {pubsub.channels.map((c) => (
            <Badge key={c} variant="secondary" className="font-mono text-[10px]">
              {c}
            </Badge>
          ))}
        </div>
      ) : null}

      {pubsub.error ? (
        <p className="text-[11px] text-destructive">{pubsub.error}</p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Messages
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={pubsub.clear}
            disabled={pubsub.messages.length === 0}
          >
            Clear
          </Button>
        </div>
        <div
          ref={logRef}
          onScroll={onLogScroll}
          className="min-h-0 flex-1 overflow-auto rounded-xl bg-muted/30 p-2 font-mono text-[11px]"
        >
          {pubsub.messages.length === 0 ? (
            <EmptyHint>
              {pubsub.subscribed
                ? "Listening. No messages yet."
                : "Subscribe to a channel to see messages."}
            </EmptyHint>
          ) : (
            pubsub.messages.map((m, i) => (
              <div key={i} className="flex items-start gap-2 px-1 py-0.5">
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatClock(m.at_ms)}
                </span>
                <span className="shrink-0 text-sky-600 dark:text-sky-400">
                  {m.channel}
                </span>
                <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                  {m.payload}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-border/60 p-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Publish
        </span>
        <div className="flex flex-col gap-1.5 sm:flex-row">
          <Input
            value={pubChannel}
            onChange={(e) => setPubChannel(e.target.value)}
            placeholder="channel"
            spellCheck={false}
            className="h-8 text-xs sm:w-40"
          />
          <Input
            value={pubMessage}
            onChange={(e) => setPubMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doPublish();
            }}
            placeholder="message"
            spellCheck={false}
            className="h-8 flex-1 text-xs"
          />
          <Button size="sm" onClick={() => void doPublish()} disabled={disabled}>
            <HugeiconsIcon icon={SentIcon} size={14} strokeWidth={1.75} />
            Publish
          </Button>
        </div>
      </div>
    </div>
  );
}
