import { create } from "zustand";

export type LogLevel = "info" | "success" | "warn" | "error";

export interface LogEntry {
  id: string;
  /** Epoch ms; rendered as HH:MM:SS. */
  ts: number;
  level: LogLevel;
  message: string;
  /**
   * Executed SQL carried by the entry (full SQL logging, HeidiSQL parity).
   * When present the message log renders a re-run affordance.
   */
  sql?: string;
}

interface LogState {
  logs: LogEntry[];
  pushLog: (level: LogLevel, message: string, sql?: string) => void;
  clearLogs: () => void;
}

/** Ring buffer cap so a long session can't grow memory unbounded. */
const MAX_LOG_ENTRIES = 1000;

let logSeq = 0;

export const useLogStore = create<LogState>((set) => ({
  logs: [],

  pushLog: (level, message, sql) =>
    set((s) => ({
      logs: [
        ...s.logs.slice(-(MAX_LOG_ENTRIES - 1)),
        { id: `log-${++logSeq}`, ts: Date.now(), level, message, sql },
      ],
    })),

  clearLogs: () => set({ logs: [] }),
}));

/**
 * Imperative logging helper, usable from stores/services outside React
 * (e.g. after an IPC round-trip). Components should read
 * `useLogStore(s => s.logs)`.
 */
export function log(level: LogLevel, message: string, sql?: string): void {
  useLogStore.getState().pushLog(level, message, sql);
}
