import { useState } from "react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** "New key" affordance: key + value + optional TTL, written via SET. */
export function KvNewKeyDialog({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate: (key: string, value: string, ttlMs?: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [ttl, setTtl] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setKey("");
    setValue("");
    setTtl("");
  };

  const create = async () => {
    const k = key.trim();
    if (!k) {
      toast.error("Key is required");
      return;
    }
    let ttlMs: number | undefined;
    if (ttl.trim()) {
      const n = Number(ttl);
      if (!Number.isFinite(n) || n <= 0) {
        toast.error("TTL must be a positive number of milliseconds");
        return;
      }
      ttlMs = n;
    }
    setSaving(true);
    try {
      await onCreate(k, value, ttlMs);
      toast.success("Key created");
      reset();
      setOpen(false);
    } catch (e) {
      toast.error(`Create failed: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.75} />
          New key
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New key</DialogTitle>
          <DialogDescription>
            Create or overwrite a string key. Leave TTL empty for no expiry.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] text-muted-foreground">Key</Label>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="user:42:name"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] text-muted-foreground">Value</Label>
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Value"
              spellCheck={false}
              className="min-h-24 font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] text-muted-foreground">
              TTL (ms, optional)
            </Label>
            <Input
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
              inputMode="numeric"
              placeholder="e.g. 60000"
              className="w-40 text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={() => void create()} disabled={saving}>
            {saving ? <Spinner className="size-3.5" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
