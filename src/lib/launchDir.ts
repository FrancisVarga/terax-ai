import { invoke } from "@tauri-apps/api/core";

let cached: string | undefined;
let cachedFile: string | undefined;

export async function initLaunchDir(): Promise<void> {
  // A `?dir=` query param (set when opening a window for a project) wins over
  // the process-global launch dir, which is shared across all windows.
  let fromUrl: string | null = null;
  try {
    fromUrl = new URLSearchParams(window.location.search).get("dir");
  } catch {
    // ignore
  }
  const dir =
    fromUrl ??
    (await invoke<string | null>("get_launch_dir").catch(() => null)) ??
    (await invoke<string>("workspace_current_dir").catch(() => null));
  cached = dir ? dir.replace(/\\/g, "/") : undefined;

  // "Open with Terax Camelot" on a file: the backend sets the cwd to the
  // file's parent dir (above) and exposes the file path here so the app opens
  // it in the editor on launch. Skipped for project windows (`?dir=`), which
  // never carry a launch file. Drained on first read backend-side.
  if (!fromUrl) {
    const file = await invoke<string | null>("get_launch_file").catch(
      () => null,
    );
    cachedFile = file ? file.replace(/\\/g, "/") : undefined;
  }
}

export function getLaunchDir(): string | undefined {
  return cached;
}

/** Absolute file path the app was launched to open, if any (drained once). */
export function getLaunchFile(): string | undefined {
  return cachedFile;
}

/**
 * True when this window was opened for a specific project/folder via the
 * `?dir=` query param (e.g. "Open project"), as opposed to a plain app launch.
 * Plain launches fall back to the process cwd, which should NOT count as an
 * explicit project window.
 */
export function hasExplicitLaunchDir(): boolean {
  try {
    return !!new URLSearchParams(window.location.search).get("dir");
  } catch {
    return false;
  }
}
