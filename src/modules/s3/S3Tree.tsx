import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import {
  AddCircleIcon,
  ArrowRight01Icon,
  CloudServerIcon,
  DatabaseIcon,
  Delete02Icon,
  File01Icon,
  Folder01Icon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import type { S3Connection, S3Entry } from "./lib/types";

/**
 * Mutation actions wired to the `s3local_*` commands. Only ever passed down for
 * an `is_local` connection — remote connections render no mutation controls, so
 * the existing read-only browser is unchanged for them. Each action, on success,
 * reloads the affected tree node so the change shows without a full refresh.
 */
type Mutations = {
  createBucket: (name: string) => Promise<void>;
  deleteBucket: (bucket: string) => Promise<void>;
  upload: (bucket: string, prefix: string) => Promise<void>;
  deleteObject: (bucket: string, key: string) => Promise<void>;
};

/**
 * Lazy S3 object browser. The hierarchy is:
 *   connection → buckets → prefixes ("folders") → objects
 * Each expandable node fetches its children via `s3_list` the first time it's
 * opened (`load` on the node) and caches them, mirroring the file explorer's
 * lazy tree. Buckets and prefixes are expandable; objects are leaf rows that
 * invoke `onOpenObject` on click.
 *
 * Addressing: the root row is the connection itself. Expanding it lists buckets
 * (empty `bucket` arg). Below that, `bucket` is fixed and the row's `prefix`
 * (an S3 key ending in "/", or "") is what we list with delimiter "/".
 */

type NodeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; entries: S3Entry[] }
  | { status: "error"; message: string };

type Props = {
  /** The active connection the tree browses. */
  connection: S3Connection;
  /** Called when an object (leaf) row is clicked. */
  onOpenObject: (connId: string, bucket: string, key: string) => void;
  /** The currently selected object key, for highlight. */
  selectedKey: string | null;
};

export function S3Tree({ connection, onOpenObject, selectedKey }: Props) {
  // Per-node child cache keyed by a stable node id (see nodeId below). Reset
  // whenever the connection changes so stale buckets never bleed across.
  const [nodes, setNodes] = useState<Record<string, NodeState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    setNodes({});
    setExpanded(new Set());
  }, [connection.id]);

  // List children of a node. `bucket` empty → list buckets; otherwise list the
  // immediate children of `prefix` under the connection's bucket.
  const load = useCallback(
    (id: string, bucket: string, prefix: string) => {
      setNodes((n) => ({ ...n, [id]: { status: "loading" } }));
      invoke<S3Entry[]>("s3_list", {
        id: connection.id,
        bucket,
        prefix,
      })
        .then((entries) => {
          setNodes((n) => ({ ...n, [id]: { status: "loaded", entries } }));
        })
        .catch((e) => {
          setNodes((n) => ({
            ...n,
            [id]: { status: "error", message: String(e) },
          }));
        });
    },
    [connection.id],
  );

  // Drop a node's cached children so the next render re-fetches it. Used after a
  // mutation so the tree reflects the change without a full reload. The bucket
  // level uses the fixed id "buckets"; a prefix node uses `${bucket}::${prefix}`.
  const reload = useCallback(
    (id: string, bucket: string, prefix: string) => {
      if (expanded.has(id) || id === "buckets") load(id, bucket, prefix);
      else setNodes((n) => ({ ...n, [id]: { status: "idle" } }));
    },
    [expanded, load],
  );

  // Mutation actions, only built for the local server connection. `null` for
  // remote connections → the read-only browser is unchanged for them.
  const mutations: Mutations | null = connection.is_local
    ? {
        createBucket: async (name) => {
          await invoke("s3local_create_bucket", { bucket: name });
          reload("buckets", "", "");
        },
        deleteBucket: async (bucket) => {
          await invoke("s3local_delete_bucket", { bucket });
          reload("buckets", "", "");
        },
        upload: async (bucket, prefix) => {
          const picked = await openFileDialog({ multiple: false });
          if (!picked || Array.isArray(picked)) return;
          // Object key = current prefix + the picked file's base name.
          const base = picked.split(/[\\/]/).pop() ?? "file";
          await invoke("s3local_upload", {
            bucket,
            key: `${prefix}${base}`,
            srcPath: picked,
          });
          reload(`${bucket}::${prefix}`, bucket, prefix);
        },
        deleteObject: async (bucket, key) => {
          await invoke("s3local_delete_object", { bucket, key });
          // Reload the object's parent prefix (everything up to the last "/").
          const slash = key.lastIndexOf("/");
          const prefix = slash >= 0 ? key.slice(0, slash + 1) : "";
          reload(`${bucket}::${prefix}`, bucket, prefix);
        },
      }
    : null;

  const toggle = useCallback(
    (id: string, bucket: string, prefix: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
          // Lazy-load on first expand only.
          setNodes((n) => {
            if (n[id] && n[id].status !== "idle") return n;
            // Defer the fetch out of the setState updater.
            queueMicrotask(() => load(id, bucket, prefix));
            return { ...n, [id]: { status: "loading" } };
          });
        }
        return next;
      });
    },
    [load],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <HugeiconsIcon
          icon={CloudServerIcon}
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="truncate text-xs font-medium text-foreground/80">
          {connection.name}
        </span>
        {mutations ? (
          <button
            type="button"
            title="Create bucket"
            className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent/70 hover:text-foreground"
            onClick={() => {
              const name = window.prompt("New bucket name:");
              if (name?.trim()) void mutations.createBucket(name.trim());
            }}
          >
            <HugeiconsIcon icon={AddCircleIcon} size={14} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1 [scrollbar-gutter:stable]">
        <BucketsLevel
          connId={connection.id}
          defaultBucket={connection.bucket}
          nodes={nodes}
          expanded={expanded}
          onToggle={toggle}
          onOpenObject={onOpenObject}
          selectedKey={selectedKey}
          mutations={mutations}
        />
      </div>
    </div>
  );
}

/**
 * The bucket level. If the connection pins a `defaultBucket`, the tree skips
 * the bucket-list call entirely and renders that single bucket's prefixes
 * directly. Otherwise it lists buckets via `s3_list` with an empty bucket arg.
 */
function BucketsLevel({
  connId,
  defaultBucket,
  nodes,
  expanded,
  onToggle,
  onOpenObject,
  selectedKey,
  mutations,
}: {
  connId: string;
  defaultBucket: string | null;
  nodes: Record<string, NodeState>;
  expanded: Set<string>;
  onToggle: (id: string, bucket: string, prefix: string) => void;
  onOpenObject: (connId: string, bucket: string, key: string) => void;
  selectedKey: string | null;
  mutations: Mutations | null;
}) {
  const rootId = "buckets";
  const node = nodes[rootId];

  // Auto-load the bucket list once when there's no pinned bucket. `onToggle`
  // and `rootId` are stable for a given connection, so re-running only on
  // `defaultBucket` change is correct (and `node` is read, not depended on, to
  // avoid re-firing on every cache write).
  const hasNode = !!node;
  useEffect(() => {
    if (defaultBucket) return;
    if (!hasNode) onToggle(rootId, "", "");
  }, [defaultBucket, hasNode, onToggle]);

  if (defaultBucket) {
    // Single pinned bucket: render it as the top-level expandable node.
    return (
      <PrefixNode
        connId={connId}
        bucket={defaultBucket}
        prefix=""
        name={defaultBucket}
        depth={0}
        icon="bucket"
        nodes={nodes}
        expanded={expanded}
        onToggle={onToggle}
        onOpenObject={onOpenObject}
        selectedKey={selectedKey}
        mutations={mutations}
      />
    );
  }

  if (!node || node.status === "loading") {
    return <Status depth={0} tone="muted" message="Loading buckets…" />;
  }
  if (node.status === "error") {
    return <Status depth={0} tone="error" message={node.message} />;
  }
  if (node.status === "idle") return null;
  if (node.entries.length === 0) {
    return <Status depth={0} tone="muted" message="No buckets." />;
  }

  return (
    <>
      {node.entries.map((bucket) => (
        <PrefixNode
          key={bucket.key}
          connId={connId}
          bucket={bucket.key}
          prefix=""
          name={bucket.name}
          depth={0}
          icon="bucket"
          nodes={nodes}
          expanded={expanded}
          onToggle={onToggle}
          onOpenObject={onOpenObject}
          selectedKey={selectedKey}
          mutations={mutations}
        />
      ))}
    </>
  );
}

/**
 * An expandable bucket-or-prefix node plus, when expanded, its children. A
 * child `S3Entry` with `is_prefix` recurses as another `PrefixNode`; a
 * non-prefix entry is an object leaf. The node id encodes bucket + prefix so
 * two prefixes with the same trailing name never collide in the cache.
 */
function PrefixNode({
  connId,
  bucket,
  prefix,
  name,
  depth,
  icon,
  nodes,
  expanded,
  onToggle,
  onOpenObject,
  selectedKey,
  mutations,
}: {
  connId: string;
  bucket: string;
  prefix: string;
  name: string;
  depth: number;
  icon: "bucket" | "folder";
  nodes: Record<string, NodeState>;
  expanded: Set<string>;
  onToggle: (id: string, bucket: string, prefix: string) => void;
  onOpenObject: (connId: string, bucket: string, key: string) => void;
  selectedKey: string | null;
  mutations: Mutations | null;
}) {
  const id = `${bucket}::${prefix}`;
  const isExpanded = expanded.has(id);
  const node = nodes[id];

  // Row actions for the local server: upload into any bucket/folder; delete a
  // bucket (empty-only, S3 semantics — a non-empty bucket surfaces the server's
  // BucketNotEmpty error via the rejected promise).
  const nodeActions: RowAction[] = mutations
    ? [
        {
          icon: Upload01Icon,
          title: "Upload file here",
          onClick: () => void mutations.upload(bucket, prefix),
        },
        ...(icon === "bucket"
          ? [
              {
                icon: Delete02Icon,
                title: "Delete bucket (must be empty)",
                onClick: () => {
                  if (window.confirm(`Delete bucket "${bucket}"?`))
                    void mutations.deleteBucket(bucket);
                },
              } as RowAction,
            ]
          : []),
      ]
    : [];

  return (
    <>
      <Row
        depth={depth}
        expandable
        isExpanded={isExpanded}
        icon={icon === "bucket" ? "bucket" : "folder"}
        label={name}
        onClick={() => onToggle(id, bucket, prefix)}
        actions={nodeActions}
      />
      {isExpanded ? (
        node?.status === "loading" || !node ? (
          <Status depth={depth + 1} tone="muted" message="Loading…" />
        ) : node.status === "error" ? (
          <Status depth={depth + 1} tone="error" message={node.message} />
        ) : node.status === "loaded" ? (
          node.entries.length === 0 ? (
            <Status depth={depth + 1} tone="muted" message="Empty" />
          ) : (
            node.entries.map((entry) =>
              entry.is_prefix ? (
                <PrefixNode
                  key={entry.key}
                  connId={connId}
                  bucket={bucket}
                  prefix={entry.key}
                  name={entry.name}
                  depth={depth + 1}
                  icon="folder"
                  nodes={nodes}
                  expanded={expanded}
                  onToggle={onToggle}
                  onOpenObject={onOpenObject}
                  selectedKey={selectedKey}
                  mutations={mutations}
                />
              ) : (
                <Row
                  key={entry.key}
                  depth={depth + 1}
                  expandable={false}
                  icon="object"
                  label={entry.name}
                  isSelected={selectedKey === entry.key}
                  onClick={() => onOpenObject(connId, bucket, entry.key)}
                  actions={
                    mutations
                      ? [
                          {
                            icon: Delete02Icon,
                            title: "Delete object",
                            onClick: () => {
                              if (window.confirm(`Delete "${entry.key}"?`))
                                void mutations.deleteObject(bucket, entry.key);
                            },
                          },
                        ]
                      : []
                  }
                />
              ),
            )
          )
        ) : null
      ) : null}
    </>
  );
}

/** A hover-revealed trailing action on a row (upload / delete). */
type RowAction = {
  // HugeIcons icon node (typed loosely to avoid importing the icon type).
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  title: string;
  onClick: () => void;
};

/** A single tree row. Mirrors explorer `EntryRow` styling (chevron, indent). */
function Row({
  depth,
  expandable,
  isExpanded = false,
  icon,
  label,
  isSelected = false,
  onClick,
  actions = [],
}: {
  depth: number;
  expandable: boolean;
  isExpanded?: boolean;
  icon: "bucket" | "folder" | "object";
  label: string;
  isSelected?: boolean;
  onClick: () => void;
  actions?: RowAction[];
}) {
  const iconNode =
    icon === "bucket"
      ? DatabaseIcon
      : icon === "folder"
        ? Folder01Icon
        : File01Icon;
  return (
    <div
      className={cn(
        "group flex h-6 w-full min-w-0 items-center rounded-sm pr-1 text-foreground/85 transition-colors hover:bg-accent/70",
        isSelected && "bg-accent text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        title={label}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-1.5 text-left text-[13px]"
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {expandable ? (
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={12}
              strokeWidth={2.25}
              className={cn("transition-transform", isExpanded && "rotate-90")}
            />
          ) : null}
        </span>
        <HugeiconsIcon
          icon={iconNode}
          size={15}
          strokeWidth={1.75}
          className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      {actions.length > 0 ? (
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {actions.map((action) => (
            <button
              key={action.title}
              type="button"
              title={action.title}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick();
              }}
              className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <HugeiconsIcon icon={action.icon} size={13} strokeWidth={1.75} />
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** A muted/error status line, indented to align with tree rows. */
function Status({
  depth,
  tone,
  message,
}: {
  depth: number;
  tone: "muted" | "error";
  message: string;
}) {
  return (
    <div
      className={cn(
        "h-6 truncate px-2 text-[11px] leading-6",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      style={{ paddingLeft: 6 + depth * 12 + 18 }}
    >
      {message}
    </div>
  );
}
