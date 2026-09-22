import { createContext, useContext } from "react";

import type { ObstacleRect } from "@/lib/diagram/edge-routing";

/**
 * Canvas-wide highlight state shared with the custom node/edge renderers via
 * context (the same trick Supabase's SchemaGraphContext uses): selection,
 * search and live table rects propagate without rewriting node/edge data,
 * so memoized TableNode/FkEdge components only re-render when their look
 * must change.
 */
export interface DiagramUiContextValue {
  /** Node ids kept at full opacity during a selection; null = no selection. */
  relatedIds: Set<string> | null;
  /** Node ids matching the current search; null = search box empty. */
  matchIds: Set<string> | null;
  /** "×" button on a card header removes the table from the canvas. */
  onHideNode: (id: string) => void;
}

export const EMPTY_DIAGRAM_UI: DiagramUiContextValue = {
  relatedIds: null,
  matchIds: null,
  onHideNode: () => {},
};

/**
 * Obstacles live in their OWN context: they change on every drag tick, and
 * only edges need them — keeping them out of DiagramUiContext stops table
 * cards from re-rendering while the user drags.
 */
export const DiagramObstaclesContext = createContext<ObstacleRect[]>([]);

export function useDiagramObstacles(): ObstacleRect[] {
  return useContext(DiagramObstaclesContext);
}

export const DiagramUiContext = createContext<DiagramUiContextValue>(EMPTY_DIAGRAM_UI);

export function useDiagramUi(): DiagramUiContextValue {
  return useContext(DiagramUiContext);
}
