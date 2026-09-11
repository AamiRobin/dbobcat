import { create } from "zustand";

import { useTabsStore } from "@/stores/tabs";

/**
 * Unsaved object-editor SQL (views/routines/triggers/events), kept OUT of
 * React so switching tabs (which unmounts the inactive tab's component
 * tree) never loses typed edits. Keyed by tab id like `stores/query-editor.ts`.
 *
 * `loadedAt` records the `dataUpdatedAt` of the SHOW CREATE snapshot the
 * buffer was last adopted from: newer snapshots overwrite the buffer, but a
 * remount that restores the SAME cached snapshot cannot clobber edits.
 */

export interface ObjectEditorDraft {
  sql: string;
  loadedAt: number;
}

interface ObjectEditorDraftState {
  byTab: Record<string, ObjectEditorDraft>;
  /** Write-through on every buffer edit (keeps the current loadedAt). */
  setSql: (tabId: string, sql: string) => void;
  /** Adopt a freshly fetched server snapshot. */
  adopt: (tabId: string, sql: string, loadedAt: number) => void;
  clearTab: (tabId: string) => void;
}

export const useObjectEditorDraftsStore = create<ObjectEditorDraftState>((set) => ({
  byTab: {},

  setSql: (tabId, sql) =>
    set((state) => ({
      byTab: {
        ...state.byTab,
        [tabId]: { sql, loadedAt: state.byTab[tabId]?.loadedAt ?? 0 },
      },
    })),

  adopt: (tabId, sql, loadedAt) =>
    set((state) => ({
      byTab: { ...state.byTab, [tabId]: { sql, loadedAt } },
    })),

  clearTab: (tabId) =>
    set((state) => {
      if (!(tabId in state.byTab)) return state;
      const next = { ...state.byTab };
      delete next[tabId];
      return { byTab: next };
    }),
}));

// Keep the store tidy: drop drafts once their tab is closed.
useTabsStore.subscribe((next, prev) => {
  if (next.tabs.length >= prev.tabs.length) return;
  const ids = new Set(next.tabs.map((t) => t.id));
  for (const id of Object.keys(useObjectEditorDraftsStore.getState().byTab)) {
    if (!ids.has(id)) useObjectEditorDraftsStore.getState().clearTab(id);
  }
});
