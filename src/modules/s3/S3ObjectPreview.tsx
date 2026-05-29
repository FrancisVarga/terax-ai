import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Alert02Icon, File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
// DataPane is NOT re-exported from `@/modules/data` (only DataStack +
// dataFormatForPath are), so we import it directly from its source file.
import { DataPane } from "@/modules/data/DataPane";
import { S3ParquetGrid } from "./S3ParquetGrid";
import { s3FormatForKey, type S3ObjectBytes } from "./lib/types";

type Props = {
  connId: string;
  bucket: string;
  objectKey: string;
  visible: boolean;
};

/**
 * Routes one selected S3 object to the right viewer based on its key
 * extension (`s3FormatForKey`):
 *   - sqlite / csv  → download to a local cache file, then reuse `DataPane`.
 *   - parquet       → stream rows straight from S3 via `S3ParquetGrid`.
 *   - json          → fetch bytes, decode UTF-8, pretty-print (raw on failure).
 *   - image         → fetch bytes, render an inline data: <img>.
 *   - pdf           → fetch bytes, render an inline data: <iframe>.
 *   - unknown       → "No preview available" empty state.
 * Loading/error states match the SshRemotePanel inline-message style.
 */
export function S3ObjectPreview({ connId, bucket, objectKey, visible }: Props) {
  const format = s3FormatForKey(objectKey);

  // Parquet streams directly; no download/byte fetch needed.
  if (format === "parquet") {
    return (
      <S3ParquetGrid
        connId={connId}
        bucket={bucket}
        objectKey={objectKey}
        visible={visible}
      />
    );
  }

  if (format === "sqlite" || format === "csv") {
    return (
      <CachedTabularPreview
        connId={connId}
        bucket={bucket}
        objectKey={objectKey}
        format={format}
        visible={visible}
      />
    );
  }

  if (format === "json" || format === "image" || format === "pdf") {
    return (
      <BytesPreview
        connId={connId}
        bucket={bucket}
        objectKey={objectKey}
        format={format}
      />
    );
  }

  return (
    <Empty
      icon
      message="No preview available"
      detail={objectKey.split("/").pop() ?? objectKey}
    />
  );
}

/**
 * sqlite/csv path: `s3_download_to_cache` returns a LOCAL file path, which we
 * then hand to the existing `DataPane` — reusing the full data-grid (table
 * picker, search, infinite scroll) without reimplementing it for S3.
 */
function CachedTabularPreview({
  connId,
  bucket,
  objectKey,
  format,
  visible,
}: {
  connId: string;
  bucket: string;
  objectKey: string;
  format: "sqlite" | "csv";
  visible: boolean;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPath(null);
    setError(null);
    invoke<string>("s3_download_to_cache", {
      id: connId,
      bucket,
      key: objectKey,
    })
      .then((local) => {
        if (!cancelled) setPath(local);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [connId, bucket, objectKey]);

  if (error) return <ErrorState message={error} />;
  if (!path) return <LoadingState label="Downloading object…" />;
  return <DataPane path={path} format={format} visible={visible} />;
}

/**
 * Bytes path for json/image/pdf. Fetches base64 once via `s3_get_object_bytes`
 * (which rejects objects > 32MB) and renders accordingly. The base64 is decoded
 * to text only for json; image/pdf embed the base64 directly in a data: URL.
 */
function BytesPreview({
  connId,
  bucket,
  objectKey,
  format,
}: {
  connId: string;
  bucket: string;
  objectKey: string;
  format: "json" | "image" | "pdf";
}) {
  const [bytes, setBytes] = useState<S3ObjectBytes | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setError(null);
    invoke<S3ObjectBytes>("s3_get_object_bytes", {
      id: connId,
      bucket,
      key: objectKey,
    })
      .then((res) => {
        if (!cancelled) setBytes(res);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [connId, bucket, objectKey]);

  if (error) return <ErrorState message={error} />;
  if (!bytes) return <LoadingState label="Loading object…" />;

  if (format === "image") {
    const mime = bytes.content_type ?? "image/*";
    return (
      <div className="flex h-full w-full items-center justify-center overflow-auto bg-background p-4">
        <img
          src={`data:${mime};base64,${bytes.base64}`}
          alt={objectKey.split("/").pop() ?? objectKey}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  if (format === "pdf") {
    return (
      <iframe
        title={objectKey.split("/").pop() ?? objectKey}
        src={`data:application/pdf;base64,${bytes.base64}`}
        className="h-full w-full border-0 bg-background"
      />
    );
  }

  // json: base64 → UTF-8 text → pretty-printed, falling back to raw text when
  // the body isn't valid JSON. `atob` yields a binary string; we map it through
  // a byte array so multi-byte UTF-8 sequences decode correctly via TextDecoder.
  return <JsonPreview base64={bytes.base64} />;
}

function JsonPreview({ base64 }: { base64: string }) {
  const text = decodeBase64Utf8(base64);
  let display = text;
  try {
    display = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Not valid JSON — show the raw text instead.
    display = text;
  }
  return (
    <div className="h-full w-full overflow-auto bg-background">
      <pre className="p-4 font-mono text-[12px] leading-relaxed text-muted-foreground whitespace-pre">
        {display}
      </pre>
    </div>
  );
}

/** Decode a base64 string (binary-safe) to a UTF-8 JS string. */
function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted-foreground">
      <Spinner className="size-3.5" />
      <span>{label}</span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-start justify-center px-6 py-8">
      <div className="flex items-start gap-2 text-[12px] text-destructive">
        <HugeiconsIcon
          icon={Alert02Icon}
          size={14}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0"
        />
        <span className="break-words">{message}</span>
      </div>
    </div>
  );
}

function Empty({
  icon,
  message,
  detail,
}: {
  icon?: boolean;
  message: string;
  detail?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      {icon ? (
        <HugeiconsIcon
          icon={File01Icon}
          size={22}
          strokeWidth={1.5}
          className={cn("text-muted-foreground")}
        />
      ) : null}
      <div className="text-[12px] text-muted-foreground">{message}</div>
      {detail ? (
        <div className="max-w-full truncate text-[11px] text-muted-foreground/70">
          {detail}
        </div>
      ) : null}
    </div>
  );
}
