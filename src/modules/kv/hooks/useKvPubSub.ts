import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { kvNative, type KvPubSubEvent } from "../lib/native";

/** Cap retained messages so a long-lived subscription can't grow unbounded. */
const MAX_MESSAGES = 500;

export type UseKvPubSub = {
  subscribed: boolean;
  channels: string[];
  messages: KvPubSubEvent[];
  error: string | null;
  subscribe: (channels: string[]) => Promise<void>;
  unsubscribe: () => void;
  clear: () => void;
  publish: (channel: string, message: string) => Promise<number>;
};

/**
 * Manages a `Channel<KvPubSubEvent>` subscription lifecycle. The Channel is
 * owned here (not in a component) so the subscription survives tab switches:
 * the dashboard stack stays mounted while hidden. Dropping the Channel ref (on
 * unsubscribe or unmount) lets the backend subscriber task abort itself.
 */
export function useKvPubSub(): UseKvPubSub {
  const [subscribed, setSubscribed] = useState(false);
  const [channels, setChannels] = useState<string[]>([]);
  const [messages, setMessages] = useState<KvPubSubEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const channelRef = useRef<Channel<KvPubSubEvent> | null>(null);

  const unsubscribe = useCallback(() => {
    // Drop the Channel handler; the backend stops streaming once send() fails.
    if (channelRef.current) channelRef.current.onmessage = () => {};
    channelRef.current = null;
    setSubscribed(false);
    setChannels([]);
  }, []);

  const subscribe = useCallback(
    async (nextChannels: string[]) => {
      const cleaned = nextChannels.map((c) => c.trim()).filter(Boolean);
      if (cleaned.length === 0) {
        setError("enter at least one channel");
        return;
      }
      // Replace any existing subscription.
      if (channelRef.current) channelRef.current.onmessage = () => {};
      setError(null);
      const ch = new Channel<KvPubSubEvent>();
      ch.onmessage = (ev) => {
        setMessages((prev) => {
          const next = [...prev, ev];
          return next.length > MAX_MESSAGES
            ? next.slice(next.length - MAX_MESSAGES)
            : next;
        });
      };
      channelRef.current = ch;
      try {
        await kvNative.data.subscribe(cleaned, ch);
        setSubscribed(true);
        setChannels(cleaned);
      } catch (e) {
        setError(String(e));
        channelRef.current = null;
        setSubscribed(false);
      }
    },
    [],
  );

  const publish = useCallback(async (channel: string, message: string) => {
    const ch = channel.trim();
    if (!ch) {
      setError("enter a channel to publish to");
      return 0;
    }
    setError(null);
    try {
      return await kvNative.data.publish(ch, message);
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }, []);

  const clear = useCallback(() => setMessages([]), []);

  // Release the subscription when the dashboard unmounts entirely.
  useEffect(() => {
    return () => {
      if (channelRef.current) channelRef.current.onmessage = () => {};
      channelRef.current = null;
    };
  }, []);

  return {
    subscribed,
    channels,
    messages,
    error,
    subscribe,
    unsubscribe,
    clear,
    publish,
  };
}
