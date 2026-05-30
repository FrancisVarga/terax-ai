import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ProviderInfo } from "@/modules/ai/config";
import type { KeyTestResult, ProviderAccount } from "@/modules/ai";
import {
  Add01Icon,
  AlertCircleIcon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { ProviderIcon } from "./ProviderIcon";

type Props = {
  provider: ProviderInfo;
  accounts: ProviderAccount[];
  activeId: string | null;
  onAdd: (label: string, key: string) => Promise<void>;
  onSetActive: (accountId: string) => Promise<void>;
  onRename: (accountId: string, label: string) => Promise<void>;
  onRemove: (accountId: string) => Promise<void>;
  onTest: (accountId: string) => Promise<KeyTestResult>;
  /** Remove the whole provider from the connected list. */
  onRemoveProvider?: () => void;
};

export function ProviderAccountsCard({
  provider,
  accounts,
  activeId,
  onAdd,
  onSetActive,
  onRename,
  onRemove,
  onTest,
  onRemoveProvider,
}: Props) {
  const [adding, setAdding] = useState(accounts.length === 0);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={provider.id} size={15} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {accounts.length > 0 ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={9} strokeWidth={2} />
            {accounts.length === 1
              ? "1 account"
              : `${accounts.length} accounts`}
          </Badge>
        ) : null}
        <button
          type="button"
          onClick={() => void openUrl(provider.consoleUrl)}
          className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Get key
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={11} strokeWidth={1.75} />
        </button>
        {onRemoveProvider ? (
          <Button
            size="icon"
            variant="ghost"
            onClick={onRemoveProvider}
            title="Remove provider"
            className="size-7 text-muted-foreground hover:text-destructive"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
          </Button>
        ) : null}
      </div>

      {accounts.length > 0 ? (
        <div className="flex flex-col gap-1">
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              active={a.id === activeId}
              onSetActive={() => onSetActive(a.id)}
              onRename={(label) => onRename(a.id, label)}
              onRemove={() => onRemove(a.id)}
              onTest={() => onTest(a.id)}
            />
          ))}
        </div>
      ) : null}

      {adding ? (
        <AddAccountForm
          provider={provider}
          onCancel={accounts.length > 0 ? () => setAdding(false) : undefined}
          onAdd={async (label, key) => {
            await onAdd(label, key);
            setAdding(false);
          }}
        />
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setAdding(true)}
          className="h-7 gap-1.5 self-start px-2.5 text-[11px]"
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
          Add account
        </Button>
      )}
    </div>
  );
}

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "result"; result: KeyTestResult };

function AccountRow({
  account,
  active,
  onSetActive,
  onRename,
  onRemove,
  onTest,
}: {
  account: ProviderAccount;
  active: boolean;
  onSetActive: () => Promise<void>;
  onRename: (label: string) => Promise<void>;
  onRemove: () => Promise<void>;
  onTest: () => Promise<KeyTestResult>;
}) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(account.label);
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  const runTest = async () => {
    setTest({ kind: "testing" });
    try {
      const result = await onTest();
      setTest({ kind: "result", result });
    } catch (e) {
      setTest({
        kind: "result",
        result: { kind: "unreachable", message: String(e) },
      });
    }
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5",
        active
          ? "border-primary/40 bg-primary/5"
          : "border-transparent hover:bg-muted/30",
      )}
    >
      <button
        type="button"
        onClick={() => !active && void onSetActive()}
        title={active ? "Active account" : "Set active"}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border",
          active ? "border-primary bg-primary" : "border-border",
        )}
        aria-label={active ? "Active account" : "Set active"}
      >
        {active ? (
          <span className="size-1.5 rounded-full bg-primary-foreground" />
        ) : null}
      </button>

      {editingLabel ? (
        <Input
          autoFocus
          value={labelDraft}
          onChange={(e) => setLabelDraft(e.target.value)}
          onBlur={() => {
            setEditingLabel(false);
            if (labelDraft.trim() && labelDraft.trim() !== account.label) {
              void onRename(labelDraft.trim());
            } else {
              setLabelDraft(account.label);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            else if (e.key === "Escape") {
              setLabelDraft(account.label);
              setEditingLabel(false);
            }
          }}
          className="h-6 flex-1 text-[11.5px]"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditingLabel(true)}
          title="Rename"
          className="flex-1 truncate text-left text-[11.5px]"
        >
          {account.label}
        </button>
      )}

      {active ? (
        <span className="text-[9.5px] tracking-wide text-primary/70 uppercase">
          Active
        </span>
      ) : null}

      <TestVerdict state={test} />

      <Button
        size="sm"
        variant="outline"
        onClick={() => void runTest()}
        disabled={test.kind === "testing"}
        title="Send an authenticated request to verify this key"
        className="h-6 gap-1 px-2 text-[10.5px]"
      >
        {test.kind === "testing" ? <Spinner className="size-3" /> : null}
        Test
      </Button>

      <Button
        size="icon"
        variant="ghost"
        onClick={() => void onRemove()}
        title="Remove account"
        className="size-6 text-muted-foreground hover:text-destructive"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={1.75} />
      </Button>
    </div>
  );
}

function TestVerdict({ state }: { state: TestState }) {
  if (state.kind !== "result") return null;
  const r = state.result;
  if (r.kind === "ok") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-emerald-500">
        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={11} strokeWidth={2} />
        Valid
      </span>
    );
  }
  const label =
    r.kind === "unauthorized"
      ? r.status === 0
        ? "No key stored"
        : "Key rejected"
      : r.kind === "unreachable"
        ? "Unreachable"
        : r.message;
  return (
    <span
      className="flex items-center gap-1 text-[10px] text-destructive"
      title={
        r.kind === "unreachable"
          ? r.message
          : r.kind === "error"
            ? r.message
            : undefined
      }
    >
      <HugeiconsIcon icon={AlertCircleIcon} size={11} strokeWidth={2} />
      {label}
    </span>
  );
}

function AddAccountForm({
  provider,
  onAdd,
  onCancel,
}: {
  provider: ProviderInfo;
  onAdd: (label: string, key: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      setError("Enter your API key.");
      return;
    }
    if (provider.keyPrefix && !trimmedKey.startsWith(provider.keyPrefix)) {
      setError(`${provider.label} keys start with "${provider.keyPrefix}".`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onAdd(label.trim() || "Default", trimmedKey);
      setLabel("");
      setKey("");
      setReveal(false);
    } catch (e) {
      setError(`Failed to save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Work)"
          spellCheck={false}
          disabled={saving}
          className="h-8 w-32 text-[11.5px]"
        />
        <div className="relative flex-1">
          <Input
            type={reveal ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              provider.keyPrefix ? `${provider.keyPrefix}…` : "Paste API key"
            }
            value={key}
            disabled={saving}
            onChange={(e) => {
              setKey(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape" && onCancel) {
                onCancel();
              }
            }}
            className="h-8 pr-7 font-mono text-[11.5px]"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            tabIndex={-1}
            className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
            aria-label={reveal ? "Hide key" : "Show key"}
          >
            <HugeiconsIcon
              icon={reveal ? ViewOffSlashIcon : ViewIcon}
              size={12}
              strokeWidth={1.75}
            />
          </button>
        </div>
        <Button
          size="sm"
          onClick={() => void submit()}
          disabled={saving || !key.trim()}
          className="h-8 gap-1 px-3 text-[11px]"
        >
          {saving ? <Spinner className="size-3" /> : null}
          Add
        </Button>
        {onCancel ? (
          <Button
            size="icon"
            variant="ghost"
            onClick={onCancel}
            title="Cancel"
            className="size-8 text-muted-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-[10.5px] text-destructive">{error}</p> : null}
    </div>
  );
}
