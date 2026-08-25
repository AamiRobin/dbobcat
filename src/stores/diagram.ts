import { create } from "zustand";

import { useTabsStore } from "@/stores/tabs";

/**
 * Per-diagram-tab view state, kept OUT of React so switching tabs (only the
 * active tab is mounted) never loses pan/zoom or drag positions. Keyed by
 * tab id like `stores/query-editor.ts`.
 */

export interface DiagramViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface DiagramPoint {
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;

export interface DiagramTabState {
  /** SVG-space → screen transform: screen = world * zoom + offset. */
  viewport: DiagramViewport;
  selection: string | null;
  hoverId: string | null;
  /** Collapsed card ids (header-only rendering). */
  collapsed: Record<string, true>;
  /** Hidden table ids ("×" on a card); restorable via the status chip. */
  hidden: string[];
  /** Manual drag positions overriding the computed layout. */
  positions: Record<string, DiagramPoint>;
  keysOnly: boolean;
  /** Bump to force a fresh dagre run (Relayout). */
  layoutNonce: number;
}

export const EMPTY_DIAGRAM_TAB: DiagramTabState = {
  viewport: { x: 0, y: 0, zoom: 1 },
  selection: null,
  hoverId: null,
  collapsed: {},
  hidden: [],
  positions: {},
  keysOnly: false,
  layoutNonce: 0,
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

/** Clamp helper shared by canvas interactions. */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}
