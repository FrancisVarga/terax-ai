import { lazy } from "react";

export {
  kvNative,
  type KvStatus,
  type KvLogResponse,
  type KvKeyInfo,
  type KvScanPage,
  type KvValue,
  type KvPubSubEvent,
} from "./lib/native";
export { useKvStatus, type UseKvStatus } from "./hooks/useKvStatus";
export { useKvData, type UseKvData } from "./hooks/useKvData";
export { useKvPubSub, type UseKvPubSub } from "./hooks/useKvPubSub";

/** Code-split dashboard, loaded on demand from the KV tab. */
export const KvDashboard = lazy(() =>
  import("./components/KvDashboard").then((m) => ({ default: m.KvDashboard })),
);

export { KvStack } from "./components/KvStack";
