import { lazy } from "react";

export {
  bunqueueNative,
  type BunqueueStatus,
  type BunqueueLogResponse,
  type BunqueueWorkerInfo,
} from "./lib/native";
export * as bunqueueApi from "./lib/api";
export {
  enqueueCreateIssue,
  enqueueHttpRequest,
  enqueueFetchOwnIp,
  enqueue,
  type CreateIssueJob,
  type HttpRequestJob,
  type DashboardOverview,
} from "./lib/api";
export {
  bunqueueClient,
  resolveBaseUrl,
  invalidateBaseUrl,
  isReady,
  get,
  post,
  BunqueueHttpError,
} from "./lib/client";
export { useBunqueue, type UseBunqueue } from "./hooks/useBunqueue";
export { useBunqueueData, type BunqueueData } from "./hooks/useBunqueueData";

/** Code-split dashboard — load on demand (e.g. from a tab). */
export const BunqueueDashboard = lazy(() =>
  import("./components/BunqueueDashboard").then((m) => ({
    default: m.BunqueueDashboard,
  })),
);

export { BunqueueStack } from "./components/BunqueueStack";
