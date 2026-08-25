import dagre from "@dagrejs/dagre";

import { CARD_WIDTH, type DiagramEdge, cardHeight } from "./diagram-model";
import type { DiagramNode } from "./diagram-model";

/**
 * Pure layout (Phase 11). Primary path is dagre with `rankdir: "TB"`
 * (parents above children — DBeaver-like reading order); the grid fallback
 * covers degenerate graphs (no edges) and any dagre failure. All functions
 * are deterministic for a given input ordering.
 */

export interface Point {
  x: number;
  y: number;
}

/** Top-left positions per node id plus the overall content bounding box. */
export interface LayoutResult {
  positions: Record<string, Point>;
  width: number;
  height: number;
}

const RANK_SEP = 70; // vertical gap between ranks (parent→child distance)
const NODE_SEP = 40; // horizontal gap within a rank
const MARGIN = 24;

/**
 * Dagre layout (TB). Node positions come back as CENTERS and are converted
 * to top-left coordinates.
 */
export function layoutDiagram(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  heights: Record<string, number>,
): LayoutResult {
  if (nodes.length === 0) {
    return { positions: {}, width: 0, height: 0 };
  }
  try {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({
      rankdir: "TB",
      nodesep: NODE_SEP,
      ranksep: RANK_SEP,
      marginx: MARGIN,
      marginy: MARGIN,
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const node of nodes) {
      const h = heights[node.id] ?? cardHeight(node, false, false);
      g.setNode(node.id, { width: CARD_WIDTH, height: h });
    }
    // Parallel edges between the same pair collapse to ONE layout edge —
    // dagre routes them identically anyway.
    const seen = new Set<string>();
    for (const edge of edges) {
      if (seen.has(`${edge.source}\u0000${edge.target}`)) continue;
      seen.add(`${edge.source}\u0000${edge.target}`);
      if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
        g.setEdge(edge.source, edge.target);
      }
    }

    dagre.layout(g);

    const positions: Record<string, Point> = {};
    let width = 0;
    let height = 0;
    for (const node of nodes) {
      const laid = g.node(node.id);
      if (!laid || typeof laid.x !== "number") continue;
      const h = heights[node.id] ?? cardHeight(node, false, false);
      positions[node.id] = { x: laid.x - CARD_WIDTH / 2, y: laid.y - h / 2 };
      width = Math.max(width, laid.x + CARD_WIDTH / 2 + MARGIN);
      height = Math.max(height, laid.y + h / 2 + MARGIN);
    }
    if (Object.keys(positions).length !== nodes.length) {
      return gridFallbackLayout(nodes, heights);
    }
    return { positions, width, height };
  } catch {
    return gridFallbackLayout(nodes, heights);
  }
}

/** Deterministic column-major grid used when dagre cannot run. */
export function gridFallbackLayout(
  nodes: DiagramNode[],
  heights: Record<string, number>,
): LayoutResult {
  const positions: Record<string, Point> = {};
  const perColumn = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  let maxColumnHeight = 0;
  nodes.forEach((node, i) => {
    const col = Math.floor(i / perColumn);
    const row = i % perColumn;
    const h = heights[node.id] ?? cardHeight(node, false, false);
    positions[node.id] = {
      x: MARGIN + col * (CARD_WIDTH + NODE_SEP),
      y: MARGIN + row * (h + RANK_SEP),
    };
    maxColumnHeight = Math.max(maxColumnHeight, (row + 1) * (h + RANK_SEP));
  });
  const columns = Math.ceil(nodes.length / perColumn);
  return {
    positions,
    width: MARGIN * 2 + columns * (CARD_WIDTH + NODE_SEP),
    height: MARGIN + maxColumnHeight,
  };
}

/**
 * Merge saved (persisted) drag positions over a fresh layout. Nodes without
 * a saved position keep their computed spot.
 */
export function applySavedPositions(
  computed: Record<string, Point>,
  saved: Record<string, Point> | null | undefined,
): Record<string, Point> {
  if (!saved) return { ...computed };
  const merged: Record<string, Point> = {};
  for (const [id, point] of Object.entries(computed)) {
    const s = saved[id];
    merged[id] =
      s && Number.isFinite(s.x) && Number.isFinite(s.y) ? { ...s } : point;
  }
  return merged;
}
