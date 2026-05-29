import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/jetbrains-mono/cyrillic-400.css";
import "@fontsource/jetbrains-mono/cyrillic-700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { installGlobalErrorHandler } from "./app/globalErrorHandler";
import { initLaunchDir } from "./lib/launchDir";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";

// Catch async errors and unhandled promise rejections (the render-tree
// ErrorBoundary below only sees render/lifecycle crashes). Install before the
// first render so even bootstrap-time rejections are surfaced.
installGlobalErrorHandler();

// Register every AG Grid community feature once, before any grid mounts. v33+
// requires explicit module registration; the data-preview grid uses the
// Theming API (no legacy CSS import) so this is the only global AG Grid setup.
ModuleRegistry.registerModules([AllCommunityModule]);

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

// Reap PTY sessions orphaned by a prior webview load before any tab spawns.
// PTY sessions live in process-wide Rust state with no per-window scoping, so
// pty_close_all drains every window's sessions. Only the primary "main" window
// runs it (reaping its own orphans after HMR/reload); secondary windows
// (label "main-N") skip it so they don't kill the primary window's terminals.
if (getCurrentWindow().label === "main") {
  await invoke("pty_close_all").catch(() => {});
}

// Seed before first paint so default tab mounts at target cwd (no flicker).
await initLaunchDir();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

// Window starts hidden (per tauri.conf.json) so users never see a transparent
// shadow-only frame before React paints. Use setTimeout — rAF is throttled
// while the window is hidden and would never fire.
const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
// Safety net: if the first show somehow fails to take effect, force again.
setTimeout(showWindow, 500);
