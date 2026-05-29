import { useMemo } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  getBindingTokens,
  SHORTCUTS,
  SHORTCUT_GROUPS,
  type ShortcutHandlers,
  type ShortcutId,
} from "@/modules/shortcuts";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Same handler map App wires into `useGlobalShortcuts`. The palette is just a
   * second front-end onto those actions, so commands stay in sync with the
   * single shortcut registry.
   */
  handlers: ShortcutHandlers;
};

// Editor entries are display-only (CodeMirror owns the keys natively, no
// App-level handler), and surfacing the palette's own opener would be noise.
const HIDDEN_IDS = new Set<ShortcutId>([
  "editor.undo",
  "editor.redo",
  "commandPopup.open",
]);

export function CommandPopup({ open, onOpenChange, handlers }: Props) {
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);

  // Only list commands that actually have a runnable handler. Re-derived from
  // the shared SHORTCUTS registry so new shortcuts appear automatically.
  const groups = useMemo(
    () =>
      SHORTCUT_GROUPS.map((group) => ({
        group,
        items: SHORTCUTS.filter(
          (s) =>
            s.group === group &&
            !HIDDEN_IDS.has(s.id) &&
            typeof handlers[s.id] === "function",
        ),
      })).filter((g) => g.items.length > 0),
    [handlers],
  );

  const run = (id: ShortcutId) => {
    onOpenChange(false);
    // Defer so the dialog's close/focus-restore settles before the action runs
    // (some handlers move focus, e.g. ai.toggle / explorer.focus).
    requestAnimationFrame(() => handlers[id]?.(new KeyboardEvent("keydown")));
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} className="sm:max-w-xl">
      <CommandInput placeholder="Type a command…" />
      <CommandList>
        <CommandEmpty>No commands found.</CommandEmpty>
        {groups.map(({ group, items }) => (
          <CommandGroup key={group} heading={group}>
            {items.map((s) => {
              const bindings = userShortcuts[s.id] || s.defaultBindings;
              const tokens = getBindingTokens(bindings[0]);
              return (
                <CommandItem
                  key={s.id}
                  // cmdk filters on `value`; include label so search matches it.
                  value={`${s.label} ${s.group}`}
                  onSelect={() => run(s.id)}
                >
                  <span>{s.label}</span>
                  {tokens.length > 0 ? (
                    <CommandShortcut>{tokens.join(" ")}</CommandShortcut>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
