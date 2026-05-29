import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  onKeysChanged,
  type AccountRegistry,
  type ProviderAccount,
} from "@/modules/settings/store";
import {
  ArrowDown01Icon,
  Settings01Icon,
  Tick01Icon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { getModel, providerNeedsKey } from "../config";
import {
  accountsForProvider,
  activeAccountId,
  getRegistry,
  setActiveAccount,
} from "../lib/keyring";
import { useChatStore } from "../store/chatStore";

/**
 * Status-bar control for switching the active account of the *currently
 * selected model's provider*. Hidden unless that provider has ≥2 accounts —
 * single-account users (the common case) see nothing. Switching emits the
 * shared keys-changed event, so the resolved key reloads app-wide.
 */
export function AccountSwitcher() {
  const selected = useChatStore((s) => s.selectedModelId);
  const provider = getModel(selected).provider;
  const [registry, setRegistry] = useState<AccountRegistry | null>(null);

  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getRegistry().then((r) => {
        if (alive) setRegistry(r);
      });
    };
    reload();
    const unlisten = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  const accounts = useMemo(
    () => (registry ? accountsForProvider(registry, provider) : []),
    [registry, provider],
  );
  const activeId = registry ? activeAccountId(registry, provider) : null;
  const active = accounts.find((a) => a.id === activeId) ?? null;

  // Only meaningful for key providers with more than one account.
  if (!providerNeedsKey(provider) || accounts.length < 2) return null;

  const pick = async (a: ProviderAccount) => {
    if (a.id === activeId) return;
    await setActiveAccount(provider, a.id);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={`Account: ${active?.label ?? "—"}`}
          className="h-5.5 gap-1 rounded-md px-1.5 my-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={UserCircleIcon} size={12} strokeWidth={1.75} />
          <span className="max-w-24 truncate">{active?.label ?? "—"}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className="opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52 p-1">
        <DropdownMenuLabel className="px-2 text-[10px] tracking-wide text-muted-foreground uppercase">
          {getModel(selected).label} account
        </DropdownMenuLabel>
        {accounts.map((a) => (
          <DropdownMenuItem
            key={a.id}
            onSelect={() => void pick(a)}
            className={cn(
              "flex items-center gap-2 text-[12px]",
              a.id === activeId && "bg-accent/50",
            )}
          >
            <span className="flex-1 truncate">{a.label}</span>
            {a.id === activeId ? (
              <HugeiconsIcon icon={Tick01Icon} size={12} strokeWidth={2} />
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void openSettingsWindow("models")}
          className="flex items-center gap-2 text-[11.5px] text-muted-foreground"
        >
          <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />
          Manage accounts
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
