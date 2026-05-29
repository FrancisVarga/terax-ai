import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

/**
 * One connectable SSH host alias parsed from `~/.ssh/config` by the backend
 * `ssh_list_hosts` command. Mirrors the Rust `SshHost` struct field-for-field
 * (serde snake_case → these names).
 */
export type SshHost = {
  alias: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
  source: string;
};

type State = {
  hosts: SshHost[];
  loading: boolean;
  error: string | null;
};

/**
 * Loads SSH hosts from the user's config on mount and exposes a `reload` for
 * the panel's refresh button. Errors are surfaced (not thrown) so the panel can
 * render an inline message — a missing `~/.ssh/config` is *not* an error, the
 * backend returns an empty list for that case.
 */
export function useSshHosts() {
  const [state, setState] = useState<State>({
    hosts: [],
    loading: true,
    error: null,
  });

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const hosts = await invoke<SshHost[]>("ssh_list_hosts");
      setState({ hosts, loading: false, error: null });
    } catch (e) {
      setState({ hosts: [], loading: false, error: String(e) });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}

/**
 * Build the `ssh` command line for a host. We connect by the config **alias**
 * so the user's `~/.ssh/config` (IdentityFile, ProxyJump, ForwardAgent, port,
 * etc.) is resolved by the ssh client itself rather than us trying to
 * reconstruct it from parsed fields. Aliases can't contain whitespace, but we
 * still single-quote anything outside the safe set as defense-in-depth.
 */
export function sshCommandFor(host: SshHost): string {
  const safe = /^[A-Za-z0-9._@-]+$/.test(host.alias)
    ? host.alias
    : `'${host.alias.replace(/'/g, "'\\''")}'`;
  return `ssh ${safe}`;
}

/** Human-readable target line shown under the alias (e.g. `user@host:2222`). */
export function describeHost(host: SshHost): string | null {
  const base = host.hostname ?? null;
  if (!base && !host.user && !host.port) return null;
  const userPart = host.user ? `${host.user}@` : "";
  const hostPart = base ?? host.alias;
  const portPart = host.port && host.port !== 22 ? `:${host.port}` : "";
  return `${userPart}${hostPart}${portPart}`;
}
