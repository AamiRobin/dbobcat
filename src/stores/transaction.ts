import { create } from "zustand";

import { ipc, onBackendEvent } from "@/lib/ipc";
import { useConnectionStore } from "@/stores/connection";
import { log } from "@/stores/log";
import type { IsolationLevel, TxMode, TxState, TxStateEvent } from "@/types/ipc";

/**
 * What pending user intent the tx-ask dialog must resolve before proceeding:
 * disconnecting, quitting the app or closing the window.
 */
export type TxAskReason = "disconnect" | "quit" | "window-close";

interface TransactionStore {
  /** Ledger snapshot of the active connection; null = nothing tracked. */
  tx: TxState | null;
  /** Tx-ask dialog ("commit / rollback / cancel") visibility + reason. */
  askOpen: boolean;
  askReason: TxAskReason | null;

  setTx: (tx: TxState | null) => void;
  /** Forget everything (connect/disconnect switched sessions). */
  clear: () => void;
  requestAsk: (reason: TxAskReason) => void;
  closeAsk: () => void;

  setMode: (mode: TxMode) => Promise<boolean>;
  commit: () => Promise<number | null>;
  rollback: () => Promise<number | null>;
  setIsolation: (level: IsolationLevel) => Promise<boolean>;
}

/**
 * Frontend mirror of the backend transaction ledger (Transactions Phase 1).
 * The `connection://tx` listener replaces the whole snapshot on every
 * ledger change; command wrappers are thin IPC calls against the active
 * connection. No polling — the backend pushes.
 */
export const useTransactionStore = create<TransactionStore>((set) => ({
  tx: null,
  askOpen: false,
  askReason: null,

  setTx: (tx) => set({ tx }),

  clear: () => set({ tx: null, askOpen: false, askReason: null }),

  requestAsk: (reason) => set({ askOpen: true, askReason: reason }),

  closeAsk: () => set({ askOpen: false, askReason: null }),

  setMode: async (mode) => {
    const connId = useConnectionStore.getState().connId;
    if (connId === null) return false;
    try {
      await ipc("tx_set_mode", { connId, mode });
      return true;
    } catch (err) {
      log("error", err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  commit: async () => {
    const connId = useConnectionStore.getState().connId;
    if (connId === null) return null;
    try {
      return await ipc<number>("tx_commit", { connId });
    } catch (err) {
      log("error", err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  rollback: async () => {
    const connId = useConnectionStore.getState().connId;
    if (connId === null) return null;
    try {
      return await ipc<number>("tx_rollback", { connId });
    } catch (err) {
      log("error", err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  setIsolation: async (level) => {
    const connId = useConnectionStore.getState().connId;
    if (connId === null) return false;
    try {
      await ipc("tx_set_isolation", { connId, level });
      return true;
    } catch (err) {
      log("error", err instanceof Error ? err.message : String(err));
      return false;
    }
  },
}));

/**
 * True when disconnecting should first ask what to do with the open
 * transaction (uncommitted work would be rolled back by the server).
 */
export function shouldAskOnDisconnect(state: TxState | null): boolean {
  return state !== null && state.phase !== "idle";
}

/** Same gate for app quit / window close. */
export function shouldAskOnQuit(state: TxState | null): boolean {
  return state !== null && state.phase !== "idle";
}

/**
 * Subscribe to backend ledger snapshots (`connection://tx`). Installed once
 * by App next to the connection-status listener; events for other session
 * ids are ignored (P1 keeps one active connection anyway).
 */
export function installTxStatusListener(): Promise<() => void> {
  return onBackendEvent<TxStateEvent>("connection://tx", (event) => {
    const { connId, state, message } = event;
    if (useConnectionStore.getState().connId !== connId) return;
    useTransactionStore.getState().setTx(state);
    if (message) {
      // e.g. "open transaction was rolled back by disconnect".
      log("warn", message);
    }
  });
}
