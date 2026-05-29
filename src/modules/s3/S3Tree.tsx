import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight01Icon,
  CloudServerIcon,
  DatabaseIcon,
  File01Icon,
  Folder01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import type { S3Connection, S3Entry } from "./lib/types";

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
}: {
  connId: string;
  defaultBucket: string | null;
  nodes: Record<string, NodeState>;
  expanded: Set<string>;
  onToggle: (id: string, bucket: string, prefix: string) => void;
  onOpenObject: (connId: string, bucket: string, key: string) => void;
  selectedKey: string | null;
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
}) {
  const id = `${bucket}::${prefix}`;
  const isExpanded = expanded.has(id);
  const node = nodes[id];

  return (
    <>
      <Row
        depth={depth}
        expandable
        isExpanded={isExpanded}
        icon={icon === "bucket" ? "bucket" : "folder"}
        label={name}
        onClick={() => onToggle(id, bucket, prefix)}
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
                />
              ),
            )
          )
        ) : null
      ) : null}
    </>
  );
}

/** A single tree row. Mirrors explorer `EntryRow` styling (chevron, indent). */
function Row({
  depth,
  expandable,
  isExpanded = false,
  icon,
  label,
  isSelected = false,
  onClick,
}: {
  depth: number;
  expandable: boolean;
  isExpanded?: boolean;
  icon: "bucket" | "folder" | "object";
  label: string;
  isSelected?: boolean;
  onClick: () => void;
}) {
  const iconNode =
    icon === "bucket"
      ? DatabaseIcon
      : icon === "folder"
        ? Folder01Icon
        : File01Icon;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        "group flex h-6 w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-left text-[13px] text-foreground/85 transition-colors hover:bg-accent/70",
        isSelected && "bg-accent text-foreground",
      )}
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
