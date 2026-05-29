import { cn } from "@/lib/utils";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";

type Props = {
  path: string;
  visible: boolean;
};

const SVG_RE = /\.svg$/i;

/**
 * Renders a local image file. Tauri's asset protocol (`convertFileSrc`) streams
 * the bytes natively — no base64 round-trip through IPC — and the CSP already
 * allows `asset:` / `asset.localhost` for `img-src`. A checkerboard backdrop
 * makes transparency obvious.
 */
export function ImagePreviewPane({ path, visible }: Props) {
  const [errored, setErrored] = useState(false);
  // `convertFileSrc` is pure; memoize so the <img> src is stable across renders.
  const src = useMemo(() => convertFileSrc(path), [path]);
  const isSvg = SVG_RE.test(path);

  return (
    <div
      className={cn(
        "flex h-full w-full items-center justify-center overflow-auto rounded-md border border-border/60 bg-background",
        !visible && "pointer-events-none",
      )}
    >
      {errored ? (
        <p className="text-[12px] text-destructive">
          Failed to load image: {path}
        </p>
      ) : (
        <div
          className="flex max-h-full max-w-full items-center justify-center p-4"
          // Checkerboard so transparent regions read as transparent, not as the
          // pane background.
          style={{
            backgroundImage:
              "repeating-conic-gradient(rgba(127,127,127,0.18) 0% 25%, transparent 0% 50%)",
            backgroundSize: "20px 20px",
          }}
        >
          <img
            src={src}
            alt={path}
            onError={() => setErrored(true)}
            className={cn(
              "max-h-full max-w-full object-contain",
              // SVGs have no intrinsic raster size; give them a sane default box.
              isSvg && "h-auto w-[min(80%,640px)]",
            )}
          />
        </div>
      )}
    </div>
  );
}
