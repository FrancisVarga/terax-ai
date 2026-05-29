import { AiInputBar, AiInputBarConnect } from "@/modules/ai";

type Props = {
  hasComposer: boolean;
  onConnect: () => void;
};

/**
 * Right-sidebar AI view. Hosts the AI composer when at least one provider key
 * (or a local model) is configured, otherwise the connect prompt. This reuses
 * the same lazy-loaded components as the bottom input bar — they read their
 * own chat state from the shared `useChatStore`, so no props are threaded.
 */
export function AiPanel({ hasComposer, onConnect }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-border/60 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        AI
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {hasComposer ? (
          <AiInputBar />
        ) : (
          <AiInputBarConnect onAdd={onConnect} />
        )}
      </div>
    </div>
  );
}
