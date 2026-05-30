import { useEffect, useMemo } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  getBindingTokens,
  SHORTCUTS,
  SHORTCUT_GROUPS,
  type ShortcutHandlers,
  type ShortcutId,
} from "@/modules/shortcuts";
import { useTaskRunnerStore } from "@/modules/task-runner";

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
  // Runnable scripts discovered by the Tasks panel's last scan, plus its runner.
  // Listing them here makes Ctrl+Shift+P a second front-end onto "run a task",
  // grouped per manifest to mirror the panel's package headers.
  const manifests = useTaskRunnerStore((s) => s.manifests);
  const runTask = useTaskRunnerStore((s) => s.run);
  const scanTasks = useTaskRunnerStore((s) => s.scan);

  // Populate runnable scripts the first time the palette opens, so Ctrl+Shift+P
  // lists tasks even if the user has never visited the Tasks panel. If the panel
  // already scanned, `manifests` is non-empty and we skip the redundant walk.
  useEffect(() => {
    if (!open || manifests.length > 0) return;
    const root = useChatStore.getState().live.getWorkspaceRoot();
    if (root) void scanTasks(root);
  }, [open, manifests.length, scanTasks]);

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

  const runScript = (manifestPath: string, scriptName: string) => {
    // Resolve fresh from the store at click time — the cached `manifests` array
    // is fine, but re-finding keeps the closure tiny and avoids stale captures.
    const manifest = manifests.find((m) => m.path === manifestPath);
    const script = manifest?.scripts.find((s) => s.name === scriptName);
    if (!manifest || !script) return;
    onOpenChange(false);
    requestAnimationFrame(() => void runTask(manifest, script));
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
        {/* One group per manifest mirrors the Tasks panel's package headers.
            Selecting a script runs it via the same store action as the panel. */}
        {manifests.map((m) => (
          <CommandGroup key={m.path} heading={m.name}>
            {m.scripts.map((s) => (
              <CommandItem
                key={s.name}
                // Include manifest + script + command so cmdk search matches any.
                value={`${m.name} ${s.name} ${s.command}`}
                onSelect={() => runScript(m.path, s.name)}
              >
                <span>{s.name}</span>
                <CommandShortcut className="font-mono opacity-70">
                  {s.command}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
