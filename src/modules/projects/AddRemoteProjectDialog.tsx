import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { connectRemote, readDir, remoteUri } from "@/modules/explorer/lib/remote";
import { describeHost, useSshHosts } from "@/modules/ssh-remote";
import {
  ArrowLeft01Icon,
  Folder01Icon,
  RefreshIcon,
  ServerStackIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { basename, newProjectId, parseTags, type Project } from "./lib/projects";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (project: Project) => void;
};

/**
 * Add a project that lives on a remote SSH host. The host list comes from the
 * user's `~/.ssh/config` (same source the SSH panel uses). We build the project
 * path as `ssh://<alias>/<absolute/path>` via {@link remoteUri} so the rest of
 * the app (explorer, open-in-tab, server grouping) treats it like any other
 * remote root — no separate remote-project plumbing needed.
 */
export function AddRemoteProjectDialog({ open, onOpenChange, onSubmit }: Props) {
  const { hosts, loading, error } = useSshHosts();
  const [alias, setAlias] = useState<string>("");
  const [remotePath, setRemotePath] = useState("");
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  // Whether the user has hand-edited the name (so we stop auto-filling it).
  const [nameTouched, setNameTouched] = useState(false);
  // Whether the user has hand-edited the path (so we stop auto-seeding home).
  const [pathTouched, setPathTouched] = useState(false);

  // Reset the form each time the dialog opens; default the alias to the first
  // available host so the common single-host case needs no extra click.
  useEffect(() => {
    if (!open) return;
    setAlias(hosts[0]?.alias ?? "");
    setRemotePath("");
    setName("");
    setTags("");
    setNotes("");
    setNameTouched(false);
    setPathTouched(false);
  }, [open, hosts]);

  // Seed the path with the host's home directory (resolved via the SFTP
  // connect, which also warms the session) whenever the host changes and the
  // user hasn't typed a path yet. Falls back to root if home can't be resolved.
  useEffect(() => {
    if (!open || !alias || pathTouched) return;
    let cancelled = false;
    void connectRemote(alias)
      .then((home) => {
        if (!cancelled && !pathTouched) setRemotePath(home || "/");
      })
      .catch(() => {
        if (!cancelled && !pathTouched) setRemotePath("/");
      });
    return () => {
      cancelled = true;
    };
  }, [open, alias, pathTouched]);

  // Keep the name in sync with the folder basename until the user edits it.
  useEffect(() => {
    if (nameTouched) return;
    const base = remotePath ? basename(remotePath) : "";
    setName(base);
  }, [remotePath, nameTouched]);

  const effectivePath =
    alias && remotePath.trim() ? remoteUri(alias, remotePath.trim()) : "";
  const canSubmit = !!name.trim() && !!effectivePath;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      id: newProjectId(),
      name: name.trim(),
      path: effectivePath,
      tags: parseTags(tags),
      notes: notes.trim(),
      createdAt: Date.now(),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 sm:max-w-md">
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon icon={ServerStackIcon} size={16} strokeWidth={1.75} />
            Add remote project
          </DialogTitle>
          <DialogDescription className="min-w-0 truncate" title={effectivePath}>
            {effectivePath || "Pick an SSH host and remote folder"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-3 overflow-y-auto px-0.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="remote-host">SSH host</Label>
            {loading ? (
              <span className="text-[12px] text-muted-foreground">
                Loading hosts…
              </span>
            ) : hosts.length === 0 ? (
              <span className="text-[12px] text-muted-foreground">
                {error
                  ? `Could not read SSH config: ${error}`
                  : "No hosts found in ~/.ssh/config."}
              </span>
            ) : (
              <Select value={alias} onValueChange={setAlias}>
                <SelectTrigger id="remote-host">
                  <SelectValue placeholder="Select a host" />
                </SelectTrigger>
                <SelectContent>
                  {hosts.map((h) => {
                    const target = describeHost(h);
                    return (
                      <SelectItem key={h.alias} value={h.alias}>
                        {h.alias}
                        {target ? (
                          <span className="ml-1.5 text-muted-foreground">
                            {target}
                          </span>
                        ) : null}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="remote-path">Remote folder path</Label>
            <Input
              id="remote-path"
              value={remotePath}
              onChange={(e) => {
                setPathTouched(true);
                setRemotePath(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="/home/user/my-project"
            />
            {/* Live SFTP browser: pick a folder by clicking through the remote
                tree. Disabled until a host is selected. The text field above
                stays the source of truth and mirrors the browser's location. */}
            <RemoteFolderBrowser
              alias={alias}
              path={remotePath}
              onNavigate={(p) => {
                setPathTouched(true);
                setRemotePath(p);
              }}
            />
            <span className="text-[11px] text-muted-foreground">
              Type an absolute path or browse the host above.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="remote-name">Name</Label>
            <Input
              id="remote-name"
              value={name}
              onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="My project"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="remote-tags">Tags</Label>
            <Input
              id="remote-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="frontend, rust, wip"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="remote-notes">Notes</Label>
            <Textarea
              id="remote-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What is this project about?"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Remote folder browser ───────────────────────────────────────────── */

type RemoteDir = { name: string };

/**
 * A compact SFTP folder browser for the Add-remote dialog. Lists directories at
 * the current `path` on `alias` (via the explorer's {@link readDir}), lets the
 * user descend into a subfolder or go up a level, and reports every navigation
 * back through `onNavigate` so the dialog's path field stays in sync.
 *
 * Only directories are shown — you're picking a project root, not a file. The
 * browser starts at the typed path (or `/` when empty) and re-lists whenever the
 * host or path changes, so editing the text field above also drives it.
 */
function RemoteFolderBrowser({
  alias,
  path,
  onNavigate,
}: {
  alias: string;
  path: string;
  onNavigate: (path: string) => void;
}) {
  const [dirs, setDirs] = useState<RemoteDir[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The directory we actually list: the typed path, normalized to an absolute
  // POSIX dir. Empty/relative input falls back to root so there's always a
  // valid listing target.
  const cwd = normalizeRemoteDir(path);

  const list = useCallback(async () => {
    if (!alias) return;
    setLoading(true);
    setError(null);
    try {
      const entries = await readDir(remoteUri(alias, cwd), false);
      const onlyDirs = entries
        .filter((e) => e.kind === "dir")
        .map((e) => ({ name: e.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setDirs(onlyDirs);
    } catch (e) {
      setDirs([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [alias, cwd]);

  useEffect(() => {
    void list();
  }, [list]);

  const goUp = () => {
    if (cwd === "/") return;
    const parent = cwd.slice(0, cwd.lastIndexOf("/")) || "/";
    onNavigate(parent);
  };

  const enter = (name: string) => {
    onNavigate(cwd === "/" ? `/${name}` : `${cwd}/${name}`);
  };

  if (!alias) {
    return (
      <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 text-[11px] text-muted-foreground">
        Select a host to browse its folders.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-card/40">
      {/* Browser toolbar: up + current dir + refresh */}
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <button
          type="button"
          onClick={goUp}
          disabled={cwd === "/"}
          title="Go up"
          aria-label="Go up"
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors",
            "hover:bg-foreground/[0.08] hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent",
          )}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} strokeWidth={1.75} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/80">
          {cwd}
        </span>
        <button
          type="button"
          onClick={() => void list()}
          title="Refresh"
          aria-label="Refresh"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
        >
          <HugeiconsIcon icon={RefreshIcon} size={13} strokeWidth={1.75} />
        </button>
      </div>

      {/* Listing */}
      <div className="max-h-40 overflow-y-auto py-1">
        {loading ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">
            Loading…
          </div>
        ) : error ? (
          <div className="px-3 py-2 text-[11px] text-rose-500/90">{error}</div>
        ) : dirs.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">
            No subfolders here.
          </div>
        ) : (
          dirs.map((d) => (
            <button
              key={d.name}
              type="button"
              onClick={() => enter(d.name)}
              className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] text-foreground/90 transition-colors hover:bg-foreground/[0.06]"
            >
              <HugeiconsIcon
                icon={Folder01Icon}
                size={14}
                strokeWidth={1.75}
                className="shrink-0 text-muted-foreground"
              />
              <span className="truncate">{d.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** Normalize free-form input into an absolute POSIX directory for listing. */
function normalizeRemoteDir(path: string): string {
  let p = path.trim().replace(/\\/g, "/");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}
