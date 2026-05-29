import type { DockerDetailTab, Tab } from "@/modules/tabs";
import { DockerDetailPane } from "./DockerDetailPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/** Renders the active Docker detail tab, if one is focused. Keyed by id so
 * switching containers remounts the pane (fresh inspect + logs fetch). */
export function DockerDetailStack({ tabs, activeId }: Props) {
  const active = tabs.find(
    (t): t is DockerDetailTab =>
      t.kind === "docker-detail" && t.id === activeId,
  );
  if (!active) return null;
  return (
    <DockerDetailPane
      key={active.id}
      containerId={active.containerId}
      containerName={active.containerName}
      host={active.host}
    />
  );
}
