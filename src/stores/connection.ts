import { create } from "zustand";

import { ipc, onBackendEvent } from "@/lib/ipc";
import { log } from "@/stores/log";
import type { ConnInfo, ConnStatusEvent, DbType, ServerInfo } from "@/types/ipc";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * Transport health of the active connection (Phase 9-B keep-alive /
 * silent reconnect). Kept separate from `status` so the tree and tabs stay
 * mounted (with their cached data) while the backend redials.
 */
export type LinkState = "ok" | "reconnecting" | "lost";

/** Display snapshot of the active session (for status bar / logs). */
export interface ActiveSession {
  sessionId: string;
  name: string;
  /** `user@host:port` of the real MySQL endpoint. */
  endpoint: string;
  /** Palette color dot accent from the session manager. */
  color?: string | null;
}

interface ConnectionState {
  status: ConnectionStatus;
  link: LinkState;
  connId: number | null;
  serverInfo: ServerInfo | null;
  session: ActiveSession | null;
  error: string | null;

  connectSession: (session: {
    id: string;
    name: string;
    dbType: DbType;
    host: string;
    port: number;
    user: string;
    color?: string | null;
  }) => Promise<boolean>;
  disconnect: () => Promise<void>;
}

/**
 * Single active connection (P1). The Rust ConnectionManager supports many,
 * but the UI limits itself to one session — connecting while a connection
 * is open implicitly disconnects it first.
 */
export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: "disconnected",
  link: "ok",
  connId: null,
  serverInfo: null,
  session: null,
  error: null,

  connectSession: async (session) => {
    // One active connection at a time — drop the previous one first.
    const previousId = get().connId;
    if (previousId !== null) {
      await get().disconnect();
      // disconnect() awaits IPC; another action may have raced us and
      // (re)connected in between. Bail instead of clobbering its connId.
      if (get().connId !== null) return false;
    }

    set({ status: "connecting", link: "ok", error: null });
    const started = performance.now();
    try {
      const info = await ipc<ConnInfo>("session_connect", { sessionId: session.id });
      const elapsedMs = Math.round(performance.now() - started);
      set({
        status: "connected",
        link: "ok",
        connId: info.connId,
        serverInfo: info.serverInfo,
        session: {
          sessionId: session.id,
          name: session.name,
          endpoint: `${session.user}@${session.host}:${session.port}`,
          color: session.color ?? null,
        },
      });
      log(
        "success",
        `Connected to ${info.serverInfo.product} ${info.serverInfo.version} on ${session.host}:${session.port} — ${elapsedMs}ms`,
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        status: "error",
        link: "ok",
        connId: null,
        serverInfo: null,
        session: null,
        error: message,
      });
      log("error", `Connection failed: ${message}`);
      return false;
    }
  },

  disconnect: async () => {
    const connId = get().connId;
    if (connId === null) {
      set({ status: "disconnected", link: "ok", connId: null, serverInfo: null, session: null });
      return;
    }
    try {
      await ipc("session_disconnect", { connId });
      log("info", `Disconnected (#${connId}).`);
    } catch (err) {
      // The backend may already have dropped it; surface but keep going.
      log("warn", `Disconnect reported: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      set({
        status: "disconnected",
        link: "ok",
        connId: null,
        serverInfo: null,
        session: null,
        error: null,
      });
    }
  },
}));

/**
 * Subscribe to backend link-state transitions (`connection://status`).
 * Installed once by App. On "lost"/"reconnecting" the message log notes it
 * and the status-bar dot turns red/amber; on "reconnected" every cached
 * query for that connection is invalidated so tree/schema/data refetch on
 * their next use.
 */
export function installConnStatusListener(): Promise<() => void> {
  // onBackendEvent resolves to the REAL unlisten handle — return that
  // promise directly so callers can actually clean up.
  return onBackendEvent<ConnStatusEvent>("connection://status", (event) => {
    const { connId, status, message } = event;
    if (useConnectionStore.getState().connId !== connId) return;

    switch (status) {
      case "reconnecting":
        useConnectionStore.setState({ link: "reconnecting" });
        log("warn", `Connection lost (${message ?? "unknown error"}) — reconnecting…`);
        break;
      case "reconnected":
        useConnectionStore.setState({ link: "ok" });
        log("success", "Connection re-established.");
        void import("@/lib/query-client").then(({ queryClient }) =>
          queryClient.invalidateQueries({
            predicate: (query) => query.queryKey.includes(connId),
          }),
        );
        break;
      case "lost":
        useConnectionStore.setState({ link: "lost" });
        log("error", `Connection lost: ${message ?? "reconnect attempts exhausted"}.`);
        break;
    }
  });
}
