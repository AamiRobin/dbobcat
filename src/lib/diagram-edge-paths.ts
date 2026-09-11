import { CARD_HEADER_HEIGHT, CARD_WIDTH, ROW_HEIGHT } from "./diagram-model";
import type { DiagramEdge } from "./diagram-model";

/**
 * Pure edge geometry (Phase 11): row-aware anchor points on card borders,
 * a smoothed cubic bezier between them, and the crow's-foot marker drawn
 * AT the child ("many") end. All math is plain functions so tests can pin
 * exact path strings.
 */

export interface Point {
  x: number;
  y: number;
}

/** Rendered box of one card. `rowIndex` is null when collapsed. */
export interface CardBox {
  x: number;
  y: number;
  height: number;
  /** Column name → visible row index (drives row-aware anchors). */
  rowIndex: Record<string, number> | null;
}

/** Center of the FK column's row, or the card middle when unavailable. */
function rowAnchorY(box: CardBox, columnName: string): number {
  const idx = box.rowIndex ? box.rowIndex[columnName] : undefined;
  if (idx === undefined) {
    return box.y + box.height / 2;
  }
  return box.y + CARD_HEADER_HEIGHT + idx * ROW_HEIGHT + ROW_HEIGHT / 2;
}

const FOOT_DEPTH = 7;
const FOOT_HALF_WIDTH = 5;

const TICK_DEPTH = 7;
const TICK_HALF_WIDTH = 5;

/**
 * Crow's-foot prongs at `tip` (on the card border), opening AWAY from the
 * card along `-angle`. Returns the polyline "M p1 L tip L p2"; renderers
 * fill it (mandatory child) or stroke it (nullable child).
 */
export function crowFootPath(tip: Point, angle: number): string {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  // Backward (outward from the card) and perpendicular unit vectors.
  const bx = -dx;
  const by = -dy;
  const px = -dy;
  const py = dx;
  const p1 = {
    x: tip.x + bx * FOOT_DEPTH + px * FOOT_HALF_WIDTH,
    y: tip.y + by * FOOT_DEPTH + py * FOOT_HALF_WIDTH,
  };
  const p2 = {
    x: tip.x + bx * FOOT_DEPTH - px * FOOT_HALF_WIDTH,
    y: tip.y + by * FOOT_DEPTH - py * FOOT_HALF_WIDTH,
  };
  const fmt = (n: number) => n.toFixed(2);
  return `M ${fmt(p1.x)} ${fmt(p1.y)} L ${fmt(tip.x)} ${fmt(tip.y)} L ${fmt(p2.x)} ${fmt(p2.y)}`;
}

/**
 * "One" marker at the parent end: a short perpendicular tick sitting
 * TICK_DEPTH into the edge, completing the crow's-foot notation pair
 * (tick = exactly one, foot = many). `angle` is the edge's outgoing
 * tangent at the parent anchor (pointing away from the parent card).
 */
export function oneTickPath(anchor: Point, angle: number): string {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const px = -dy;
  const py = dx;
  const cx = anchor.x + dx * TICK_DEPTH;
  const cy = anchor.y + dy * TICK_DEPTH;
  const fmt = (n: number) => n.toFixed(2);
  return (
    `M ${fmt(cx + px * TICK_HALF_WIDTH)} ${fmt(cy + py * TICK_HALF_WIDTH)} ` +
    `L ${fmt(cx - px * TICK_HALF_WIDTH)} ${fmt(cy - py * TICK_HALF_WIDTH)}`
  );
}

export interface EdgeGeometry {
  /** Cubic bezier from parent anchor to child anchor. */
  d: string;
  /** Crow's-foot prongs at the child end (null → plain line end). */
  foot: string | null;
  /** "Exactly one" tick at the parent end (null for composite edges). */
  oneTick: string | null;
  /** Fill the foot (mandatory child) vs stroke it (nullable child). */
  filled: boolean;
  /** Midpoint approximation — hover-label chip anchor. */
  labelPoint: Point;
}

/**
 * Compute one edge's geometry. Horizontal separation dominates side choice
 * (cards connect left↔right); otherwise top↔bottom. Anchors snap to the FK/
 * referenced column's row when that row is visible.
 */
export function computeEdgeGeometry(
  edge: DiagramEdge,
  boxes: Record<string, CardBox>,
): EdgeGeometry | null {
  const source = boxes[edge.source];
  const target = boxes[edge.target];
  if (!source || !target) return null;

  const scx = source.x + CARD_WIDTH / 2;
  const scy = source.y + source.height / 2;
  const tcx = target.x + CARD_WIDTH / 2;
  const tcy = target.y + target.height / 2;
  if (scx === tcx && scy === tcy) return null; // fully overlapping cards

  const horizontal = Math.abs(tcx - scx) >= Math.abs(tcy - scy);

  let from: Point;
  let to: Point;
  if (horizontal) {
    const sourceRight = scx <= tcx;
    from = {
      x: sourceRight ? source.x + CARD_WIDTH : source.x,
      y: clampToCard(rowAnchorY(source, edge.sourceColumn), source),
    };
    to = {
      x: sourceRight ? target.x : target.x + CARD_WIDTH,
      y: clampToCard(rowAnchorY(target, edge.targetColumn), target),
    };
    if (to.x === from.x) return null; // fully overlapping cards — skip
  } else {
    const sourceAbove = scy <= tcy;
    from = {
      x: scx,
      y: sourceAbove ? source.y + source.height : source.y,
    };
    to = {
      x: tcx,
      y: sourceAbove ? target.y : target.y + target.height,
    };
    if (to.y === from.y) return null;
  }

  // Manual drags can leave a 2-3px gap between cards; a 7px-deep tick
  // would land inside the child card, so skip it when the run is short.
  const edgeLength = Math.hypot(to.x - from.x, to.y - from.y);
  const showTick = !edge.composite && edgeLength >= 2 * TICK_DEPTH;

  // Smoothed bezier: control points biased along the dominant axis so the
  // curve leaves/enters borders perpendicular-ish.
  const cx1 = from.x + (to.x - from.x) * 0.45;
  const cy1 = from.y + (horizontal ? 0 : (to.y - from.y) * 0.45);
  const cx2 = to.x - (to.x - from.x) * 0.45;
  const cy2 = to.y - (horizontal ? 0 : (to.y - from.y) * 0.45);
  const fmt = (n: number) => Number(n.toFixed(2));
  const d = `M ${fmt(from.x)} ${fmt(from.y)} C ${fmt(cx1)} ${fmt(cy1)}, ${fmt(cx2)} ${fmt(cy2)}, ${fmt(to.x)} ${fmt(to.y)}`;

  // Incoming tangent direction at the child end (control point → anchor).
  const angle = horizontal
    ? Math.atan2(0, to.x - cx2)
    : Math.atan2(to.y - cy2, 0);
  // Outgoing tangent at the parent end (anchor → first control point).
  const parentAngle = horizontal
    ? Math.atan2(0, cx1 - from.x)
    : Math.atan2(cy1 - from.y, 0);

  return {
    d,
    foot:
      edge.composite || !edge.targetColumn
        ? null
        : crowFootPath(to, angle),
    oneTick: showTick ? oneTickPath(from, parentAngle) : null,
    filled: !edge.nullableChild && !edge.composite,
    labelPoint: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
  };
}

function clampToCard(y: number, box: CardBox): number {
  const min = box.y + CARD_HEADER_HEIGHT / 2;
  const max = box.y + Math.max(box.height - 2, min + 1);
  return Math.min(Math.max(y, min), max);
}
