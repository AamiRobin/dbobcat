import { create } from "zustand";

import type { ExplainStatement, QueryOutcome } from "@/types/ipc";
import { useTabsStore, type Tab } from "@/stores/tabs";

/**
 * Per-query-tab editor state, kept OUT of React so switching tabs (which
 * unmounts the inactive tab's component tree) never loses SQL text or the
 * last run's results. Keyed by tab id like `stores/changesets.ts`.
 */

export interface QueryTabState {
  sql: string;
  /** Outcomes of the last run; null until the first execution. */
  outcomes: QueryOutcome[] | null;
  /** True while a script is executing on this tab. */
  running: boolean;
  /** Frontend wall-clock duration of the last run (includes IPC overhead). */
  totalMs: number | null;
  /** Database context for schema autocompletion (no session USE is issued). */
  db: string | null;
  /** Increments on every completed run — used to reset result-tab focus. */
  runNonce: number;
  /** Heidi default: first error aborts the rest of the script. */
  stopOnError: boolean;
  /** The exact script text of the last run (for message summaries). */
  executedSql: string | null;
  /** Phase 9-B: right-hand helpers panel (columns/snippets/reference). */
  helpersOpen: boolean;
  /** EXPLAIN output of the last explain request; null until first use. */
  plan: ExplainStatement[] | null;
  /** True while an EXPLAIN request is in flight. */
  planLoading: boolean;
  /** True when the last plan ran with ANALYZE (badge in the plan tab). */
  planAnalyze: boolean;
  /** Increments on every completed explain — focuses the plan tab. */
  planNonce: number;
}

export const EMPTY_QUERY_TAB: QueryTabState = {
  sql: "",
  outcomes: null,
  running: false,
  totalMs: null,
  db: null,
  runNonce: 0,
  stopOnError: true,
  executedSql: null,
  helpersOpen: false,
  plan: null,
  planLoading: false,
  planAnalyze: false,
  planNonce: 0,
};

interface QueryEditorState {
  byTab: Record<string, QueryTabState>;
  /** Read-and-patch in one updater — never read a stale snapshot then set. */
  patch: (tabId: string, partial: Partial<QueryTabState>) => void;
  stateFor: (tabId: string) => QueryTabState;
  clearTab: (tabId: string) => void;
}

export const useQueryEditorStore = create<QueryEditorState>((set, get) => ({
  byTab: {},

  patch: (tabId, partial) =>
    set((state) => ({
      byTab: {
        ...state.byTab,
        [tabId]: {
          ...(state.byTab[tabId] ?? EMPTY_QUERY_TAB),
          ...partial,
        },
      },
    })),

  stateFor: (tabId) => get().byTab[tabId] ?? EMPTY_QUERY_TAB,

  clearTab: (tabId) =>
    set((state) => {
      if (!(tabId in state.byTab)) return state;
      const next = { ...state.byTab };
      delete next[tabId];
      return { byTab: next };
    }),
}));

// Keep the store tidy: drop state for tabs once they are closed.
useTabsStore.subscribe((next, prev) => {
  if (next.tabs.length >= prev.tabs.length) return;
  const ids = new Set(next.tabs.map((t) => t.id));
  for (const id of Object.keys(useQueryEditorStore.getState().byTab)) {
    if (!ids.has(id)) {
      useQueryEditorStore.getState().clearTab(id);
    }
  }
});

/**
 * Open a fresh query tab whose editor starts with `sql` (palette history
 * reuse). Seeding through the store BEFORE the tab mounts works because
 * QueryView reads `sql` from here on first render — no post-mount patching,
 * no extra tab-meta plumbing.
 */
export function openQueryTabWithSql(sql: string): Tab {
  const tab = useTabsStore.getState().openTab("query");
  useQueryEditorStore.getState().patch(tab.id, { sql });
  return tab;
}
