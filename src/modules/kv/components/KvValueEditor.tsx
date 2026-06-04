import { useEffect, useState } from "react";
import { Delete02Icon, FloppyDiskIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";

import type { KvValue } from "../lib/native";
import { formatTtl } from "../lib/format";
import { EmptyHint, TypeBadge } from "./parts";

/**
 * Right pane: view/edit the selected key's value. Save writes via SET (with an
 * optional TTL), the TTL editor sets/clears expiry via EXPIRE/PERSIST, and
 * Delete removes the key. Non-string types are read-only (Phase 1 backend only
 * returns string values).
 */
export function KvValueEditor({
  selectedKey,
  value,
  loading,
  onSave,
  onSetTtl,
  onDelete,
}: {
  selectedKey: string | null;
  value: KvValue | null;
  loading: boolean;
  onSave: (key: string, value: string, ttlMs?: number) => Promise<void>;
  onSetTtl: (key: string, ttlMs?: number) => Promise<void>;
  onDelete: (key: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [ttlInput, setTtlInput] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset the editor whenever the selected value loads/changes.
  useEffect(() => {
    setDraft(value?.value ?? "");
    setTtlInput("");
  }, [value, selectedKey]);

  if (!selectedKey) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <EmptyHint>Select a key to view and edit its value.</EmptyHint>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const isString = value?.type === "string" || value === null;
  const dirty = value !== null && draft !== value.value;

  const save = async () => {
    setSaving(true);
    try {
      await onSave(selectedKey, draft);
      toast.success("Saved");
    } catch (e) {
      toast.error(`Save failed: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const applyTtl = async () => {
    const ms = Number(ttlInput);
    if (!ttlInput || !Number.isFinite(ms) || ms <= 0) {
      toast.error("Enter a positive TTL in milliseconds");
      return;
    }
    try {
      await onSetTtl(selectedKey, ms);
      toast.success("TTL set");
      setTtlInput("");
    } catch (e) {
      toast.error(`Set TTL failed: ${String(e)}`);
    }
  };

  const clearTtl = async () => {
    try {
      await onSetTtl(selectedKey);
      toast.success("TTL cleared");
    } catch (e) {
      toast.error(`Clear TTL failed: ${String(e)}`);
    }
  };

  const remove = async () => {
    try {
      await onDelete(selectedKey);
      toast.success("Deleted");
    } catch (e) {
      toast.error(`Delete failed: ${String(e)}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs font-medium" title={selectedKey}>
            {selectedKey}
          </span>
          {value ? <TypeBadge type={value.type} /> : null}
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          TTL: {value ? formatTtl(value.ttl_ms) : "-"}
        </span>
      </div>

      {isString ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none font-mono text-xs"
          placeholder="Value"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl bg-muted/30 p-3">
          <EmptyHint>
            Editing {value?.type} values is not supported here. View only.
          </EmptyHint>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={!isString || saving || !dirty}
        >
          {saving ? (
            <Spinner className="size-3.5" />
          ) : (
            <HugeiconsIcon icon={FloppyDiskIcon} size={14} strokeWidth={1.75} />
          )}
          Save
        </Button>
        <div className="flex items-center gap-1">
          <Input
            value={ttlInput}
            onChange={(e) => setTtlInput(e.target.value)}
            inputMode="numeric"
            placeholder="TTL ms"
            className="h-8 w-24 text-xs"
          />
          <Button variant="outline" size="sm" onClick={() => void applyTtl()}>
            Set TTL
          </Button>
          <Button variant="outline" size="sm" onClick={() => void clearTtl()}>
            Clear
          </Button>
        </div>
        <div className="flex-1" />
        <Button
          variant="destructive"
          size="sm"
          onClick={() => void remove()}
        >
          <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.75} />
          Delete
        </Button>
      </div>
    </div>
  );
}
