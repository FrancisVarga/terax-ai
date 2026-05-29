import { memo } from "react";
import type { DockerDetailTab } from "@/modules/tabs";
import { DockerDetailPane } from "./DockerDetailPane";

type Props = {
  /** Pre-filtered, referentially-stable slice (see `useStableTabSlice`). */
  dockerDetails: DockerDetailTab[];
  activeId: number;
};

/** Renders the active Docker detail tab, if one is focused. Keyed by id so
 * switching containers remounts the pane (fresh inspect + logs fetch). */
export const DockerDetailStack = memo(function DockerDetailStack({
  dockerDetails,
  activeId,
}: Props) {
  const active = dockerDetails.find((t) => t.id === activeId);
  if (!active) return null;
  return (
    <DockerDetailPane
      key={active.id}
      containerId={active.containerId}
      containerName={active.containerName}
      host={active.host}
    />
  );
});
