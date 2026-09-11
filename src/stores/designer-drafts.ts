import { create } from "zustand";

import { useTabsStore } from "@/stores/tabs";
import type { TableDdl } from "@/types/ipc";

/**
 * Unsaved table-designer drafts, kept OUT of React so switching tabs (which
 * unmounts the inactive tab's component tree) never loses edits. Keyed by
 * tab id like `stores/query-editor.ts`.
 *
 * `loadedAt` records the `dataUpdatedAt` of the DDL snapshot the draft was
 * last adopted from, so a newer server snapshot (Refresh button, apply,
 * invalidation) still overwrites the draft, but a remount that restores the
 * SAME cached snapshot cannot clobber unsaved edits.
 */

export interface DesignerDraft {
  draft: TableDdl;
  loadedAt: number;
}

interface DesignerDraftState {
  byTab: Record<string, DesignerDraft>;
  /** Write-through on every draft edit (keeps the current loadedAt). */
  setDraft: (tabId: string, draft: TableDdl) => void;
  /** Adopt a freshly fetched server snapshot. */
  adopt: (tabId: string, draft: TableDdl, loadedAt: number) => void;
  clearTab: (tabId: string) => void;
}

export const useDesignerDraftsStore = create<DesignerDraftState>((set) => ({
  byTab: {},

  setDraft: (tabId, draft) =>
    set((state) => ({
      byTab: {
        ...state.byTab,
        [tabId]: { draft, loadedAt: state.byTab[tabId]?.loadedAt ?? 0 },
      },
    })),

  adopt: (tabId, draft, loadedAt) =>
    set((state) => ({
      byTab: { ...state.byTab, [tabId]: { draft, loadedAt } },
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
  for (const id of Object.keys(useDesignerDraftsStore.getState().byTab)) {
    if (!ids.has(id)) useDesignerDraftsStore.getState().clearTab(id);
  }
});
