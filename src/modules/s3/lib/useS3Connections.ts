import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { S3Connection, S3Credentials } from "./types";

type State = {
  connections: S3Connection[];
  loading: boolean;
  error: string | null;
};

/**
 * Loads saved S3 connections from the backend on mount and exposes mutators.
 *
 * Errors are surfaced (not thrown) so the panel/dialog can render an inline
 * message. `save`/`remove` write through to Rust and then reload so the list
 * always reflects backend state rather than an optimistic local guess — the
 * lists are small, so the extra round-trip is cheap and keeps the source of
 * truth on the backend.
 */
export function useS3Connections() {
  const [state, setState] = useState<State>({
    connections: [],
    loading: true,
    error: null,
  });

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const connections = await invoke<S3Connection[]>("s3_list_connections");
      setState({ connections, loading: false, error: null });
    } catch (e) {
      setState({ connections: [], loading: false, error: String(e) });
    }
  }, []);

  // Tauri converts the JS camelCase arg names to Rust snake_case, so we pass
  // `conn`, `accessKeyId`, `secretAccessKey`, `sessionToken` as-is.
  const save = useCallback(
    async (conn: S3Connection, creds: S3Credentials) => {
      await invoke<void>("s3_save_connection", {
        conn,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      });
      await reload();
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await invoke<void>("s3_delete_connection", { id });
      await reload();
    },
    [reload],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload, save, remove };
}
