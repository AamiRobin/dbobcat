import { ipc } from "@/lib/ipc";
import type { ExplainStatement, HistoryEntry, QueryOutcome } from "@/types/ipc";

/**
 * Query-editor server state (Phase 3): script execution + history.
 * Schema completion reuses the tree caches from `db-queries.ts`.
 */

export const historyKeys = {
  all: ["query-history"] as const,
};

export const HISTORY_STALE_TIME = 15_000;

/** Execute a multi-statement script; one outcome per statement/result set. */
export async function runScript(
  connId: number,
  sql: string,
  stopOnError: boolean,
  connName: string,
): Promise<QueryOutcome[]> {
  return ipc<QueryOutcome[]>("query_run_script", {
    connId,
    sql,
    stopOnError,
    connName,
  });
}

/**
 * EXPLAIN every statement of the script (dialect-aware; `analyze` runs
 * EXPLAIN ANALYZE where the engine supports it).
 */
export async function explainScript(
  connId: number,
  sql: string,
  analyze: boolean,
): Promise<ExplainStatement[]> {
  return ipc<ExplainStatement[]>("query_explain", { connId, sql, analyze });
}

export async function fetchHistory(): Promise<HistoryEntry[]> {
  return ipc<HistoryEntry[]>("query_history_list");
}

export async function clearHistory(): Promise<void> {
  return ipc<void>("query_history_clear");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Compact relative timestamp for the history menu ("just now", "5m ago"). */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/** Single-line preview of a stored query for menu rows. */
export function snippet(sql: string, maxChars = 80): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars)}…`;
}

/** Human elapsed time: sub-second shows ms, otherwise seconds. */
export function formatElapsed(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(3)} s`;
}
