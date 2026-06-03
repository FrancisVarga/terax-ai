import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { quoteShellArg } from "@/lib/shellQuote";
import { getLaunchDir } from "@/lib/launchDir";
import {
  connectRemote,
  disconnectRemote,
  isRemote,
  parseRemote,
  remoteUri,
} from "@/modules/explorer/lib/remote";
import {
  bindRemoteCwd,
  buildRemoteCwdHookCommand,
  newRemoteCwdNonce,
  unbindRemoteCwd,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { sshCommandFor, type SshHost } from "@/modules/ssh-remote";

type UseRemoteSessionArgs = {
  newAgentTab: (
    cwd: string | undefined,
    title: string,
  ) => { leafId: number };
  newTab: (cwd?: string) => number;
  /** Cwd a local new-tab should inherit (active terminal's cwd, else root). */
  inheritedCwdForNewTab: () => string | undefined;
  /** Switch the left sidebar to a given view (used to reveal the explorer). */
  persistSidebarView: (view: "explorer") => void;
};

/**
 * SSH/remote-browse session lifecycle: opening interactive `ssh <alias>` tabs
 * with remote cwd tracking + SFTP explorer browsing, exiting back to local, and
 * the remote-aware "new tab" + launch auto-connect. Owns `remoteRoot` and the
 * one-active-browse leaf ref. Extracted from App.tsx — the dense inline comments
 * document the PTY-handshake timing the launchers depend on.
 */
export function useRemoteSession({
  newAgentTab,
  newTab,
  inheritedCwdForNewTab,
  persistSidebarView,
}: UseRemoteSessionArgs) {
  // When set (`ssh://alias/path`), the explorer browses a remote SFTP root
  // instead of the local workspace. Cleared by switching workspace or
  // disconnecting.
  const [remoteRoot, setRemoteRoot] = useState<string | null>(null);
  // Leaf id of the ssh terminal currently driving remote cwd tracking, so we
  // can unbind it on disconnect / shell exit. One active remote browse at a time.
  const remoteCwdLeafRef = useRef<number | null>(null);
  // Active SSH alias (from the remote root) so the Docker panel targets that
  // server's daemon. `null` when browsing locally → local Docker daemon.
  const remoteAlias = useMemo(
    () => (remoteRoot ? (parseRemote(remoteRoot)?.alias ?? null) : null),
    [remoteRoot],
  );

  // Open a fresh terminal tab and run `ssh <alias>`. We wait for the PTY
  // session to be ready (same handshake the managed-agent spawn uses) before
  // writing the command, otherwise the bytes race the shell's first prompt and
  // get swallowed.
  const connectSsh = useCallback(
    (host: SshHost, targetPath?: string) => {
      // 1. Open an interactive ssh terminal tab.
      const { leafId } = newAgentTab(undefined, `ssh · ${host.alias}`);

      // Bind this leaf for remote cwd tracking BEFORE the ssh handshake: a
      // per-leaf nonce gates the OSC 7704 hook output so only the hook we inject
      // (carrying this nonce) can move the explorer. The callback re-points the
      // remote root, so a `cd` on the server follows in the tree.
      const nonce = newRemoteCwdNonce();
      remoteCwdLeafRef.current = leafId;
      bindRemoteCwd(leafId, {
        alias: host.alias,
        nonce,
        onRemoteCwd: (uri) => setRemoteRoot(uri),
      });

      void (async () => {
        await whenSessionReady(leafId);
        // Settle the prompt before typing the ssh command. On a cold local
        // shell (notably Windows PowerShell + PSReadLine) the FIRST keystroke
        // after the prompt renders is sometimes swallowed, turning `ssh` into
        // `sh` — the connection then never opens and the follow-up hook/cd run
        // locally. A throwaway Enter + a short pause lets PSReadLine finish its
        // async init so the real command's first byte isn't lost.
        writeToSession(leafId, "\r");
        await new Promise((r) => setTimeout(r, 250));
        // Open the interactive remote shell. We type `cd` as a follow-up command
        // (rather than `ssh -t … 'cd … && exec $SHELL'`) because the remote may
        // be PowerShell, fish, etc. — a bare `cd <path>` is understood by every
        // common shell, whereas a POSIX `exec "$SHELL" -l` wrapper breaks on
        // PowerShell. `cd` runs inside whatever login shell ssh launched.
        writeToSession(leafId, `${sshCommandFor(host)}\r`);
        // Install the remote precmd hook after the ssh session is up. We can't
        // detect the remote prompt precisely (no remote integration), so wait a
        // beat past the local handshake before typing the one-liner. If remote
        // cwd sync never installs (unknown shell, slow/auth-prompting login),
        // the explorer simply stays put and the user browses manually.
        const hook = buildRemoteCwdHookCommand(nonce);
        setTimeout(() => {
          if (remoteCwdLeafRef.current === leafId) {
            writeToSession(leafId, `${hook}\r`);
            if (targetPath && targetPath !== "/") {
              writeToSession(leafId, `cd ${quoteShellArg(targetPath)}\r`);
            }
          }
        }, 1200);
      })();

      // 2. In parallel, bring up an SFTP session and point the explorer at the
      //    project path (when opening a project) or the remote home dir.
      void (async () => {
        try {
          const home = await connectRemote(host.alias);
          setRemoteRoot(
            remoteUri(
              host.alias,
              targetPath && targetPath !== "/" ? targetPath : home,
            ),
          );
          persistSidebarView("explorer");
        } catch (e) {
          console.error("[terax] SFTP connect failed:", e);
          toast.error(`SFTP: could not browse ${host.alias}`, {
            description: String(e),
          });
        }
      })();
    },
    [newAgentTab, persistSidebarView],
  );

  // Auto-connect SSH when the window was launched for a remote project
  // (`?dir=ssh://alias/path`). The local terminal can't be a remote cwd, so we
  // open an interactive `ssh <alias>` tab and cd into the project path instead.
  // Fires once on mount.
  const remoteAutoConnectedRef = useRef(false);
  useEffect(() => {
    if (remoteAutoConnectedRef.current) return;
    const launch = getLaunchDir();
    if (!launch || !isRemote(launch)) return;
    const ref = parseRemote(launch);
    if (!ref) return;
    remoteAutoConnectedRef.current = true;
    connectSsh(
      {
        alias: ref.alias,
        hostname: null,
        user: null,
        port: null,
        source: "launch",
      },
      ref.path,
    );
  }, [connectSsh]);

  const openNewTab = useCallback(() => {
    // While browsing a remote workspace, a new tab should be an ssh session on
    // that host (cd'd into the current remote dir), not a local shell.
    const ref = remoteRoot ? parseRemote(remoteRoot) : null;
    if (ref) {
      connectSsh(
        {
          alias: ref.alias,
          hostname: null,
          user: null,
          port: null,
          source: "launch",
        },
        ref.path,
      );
      return;
    }
    newTab(inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab, remoteRoot, connectSsh]);

  // Leave the remote view: drop the SFTP session, unbind remote cwd tracking,
  // and restore the local root.
  const exitRemote = useCallback(() => {
    if (remoteCwdLeafRef.current !== null) {
      unbindRemoteCwd(remoteCwdLeafRef.current);
      remoteCwdLeafRef.current = null;
    }
    setRemoteRoot((curr) => {
      const ref = curr ? parseRemote(curr) : null;
      if (ref) void disconnectRemote(ref.alias);
      return null;
    });
  }, []);

  // Called from App's terminal `onLeafExit`: if the ssh leaf driving remote cwd
  // tracking exits, drop the binding so a stale nonce can't be reused by a later
  // leaf that reuses the id. Returns whether this leaf was the remote driver.
  const unbindRemoteLeaf = useCallback((leafId: number): boolean => {
    if (remoteCwdLeafRef.current !== leafId) return false;
    unbindRemoteCwd(leafId);
    remoteCwdLeafRef.current = null;
    return true;
  }, []);

  return {
    remoteRoot,
    remoteAlias,
    connectSsh,
    openNewTab,
    exitRemote,
    unbindRemoteLeaf,
  };
}
