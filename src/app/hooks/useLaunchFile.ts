import { useEffect, useRef } from "react";
import { getLaunchFile } from "@/lib/launchDir";
import { isRemote } from "@/modules/explorer/lib/remote";

/**
 * "Open with Terax" on a file: the backend cd'd the workspace into the file's
 * parent dir; here we open the file itself in the editor. Fires once on mount.
 * Local files only (remote launch goes through the ssh auto-connect path).
 */
export function useLaunchFile(
  openFile: (path: string, pin: boolean) => void,
) {
  const launchFileOpenedRef = useRef(false);
  useEffect(() => {
    if (launchFileOpenedRef.current) return;
    const file = getLaunchFile();
    if (!file || isRemote(file)) return;
    launchFileOpenedRef.current = true;
    openFile(file, true);
  }, [openFile]);
}
