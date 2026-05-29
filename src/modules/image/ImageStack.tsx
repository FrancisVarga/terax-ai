import { memo } from "react";
import { cn } from "@/lib/utils";
import type { ImageTab } from "@/modules/tabs";
import { ImagePreviewPane } from "./ImagePreviewPane";

type Props = {
  /** Pre-filtered, referentially-stable slice (see `useStableTabSlice`). */
  images: ImageTab[];
  activeId: number;
};

export const ImageStack = memo(function ImageStack({ images, activeId }: Props) {
  if (images.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {images.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <ImagePreviewPane path={t.path} visible={visible} />
          </div>
        );
      })}
    </div>
  );
});
