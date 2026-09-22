import { create } from "zustand";

import { useTabsStore } from "@/stores/tabs";

/**
 * Per-diagram-tab view state, kept OUT of React so switching tabs (only the
 * active tab is mounted) never loses drag positions or view toggles. Keyed
 * by tab id like `stores/query-editor.ts`. Pan/zoom/selection live inside
 * React Flow; only what persists across tab switches and app restarts is
 * stored here (positions, hidden tables, keys-only).
 */

export interface DiagramPoint {
  x: number;
  y: number;
}

export interface DiagramTabState {
  /** Manual drag positions overriding the computed layout. */
  positions: Record<string, DiagramPoint>;
  /** Hidden table ids ("×" on a card); restorable via the status chip. */
  hidden: string[];
  keysOnly: boolean;
  /**
   * Monotonic-ish stamp (Date.now() at the last patch) used to order the
   * live layout against the persisted snapshot: hydration must not apply a
   * persisted layout older than unsaved in-memory edits (the 500ms persist
   * debounce may not have flushed before a tab switch).
   */
  layoutVersion: number;
}

export const EMPTY_DIAGRAM_TAB: DiagramTabState = {
  positions: {},
  hidden: [],
  keysOnly: false,
  layoutVersion: 0,
};

interface DiagramState {
  byTab: Record<string, DiagramTabState>;
  patch: (tabId: string, partial: Partial<DiagramTabState>) => void;
  stateFor: (tabId: string) => DiagramTabState;
  clearTab: (tabId: string) => void;
}

export const useDiagramStore = create<DiagramState>((set, get) => ({
  byTab: {},

  patch: (tabId, partial) =>
    set((state) => ({
      byTab: {
        ...state.byTab,
        [tabId]: {
          ...(state.byTab[tabId] ?? EMPTY_DIAGRAM_TAB),
          ...partial,
          layoutVersion: Date.now(),
        },
      },
    })),

  stateFor: (tabId) => get().byTab[tabId] ?? EMPTY_DIAGRAM_TAB,

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
  for (const id of Object.keys(useDiagramStore.getState().byTab)) {
    if (!ids.has(id)) {
      useDiagramStore.getState().clearTab(id);
    }
  }
});
