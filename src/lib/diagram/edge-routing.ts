/**
 * Orthogonal edge routing around table cards (obstacle avoidance), adapted
 * from dbx's Apache-2.0 `edge-obstacle-router` (github.com/t8y2/dbx).
 *
 * From the source/target handle points we try a fixed set of L- and
 * Z-shaped corridors, keep the shortest polyline that (a) clears every
 * other table's inflated rect and (b) does not skim the endpoint tables
 * beyond their short handle stubs. Pure geometry — no framework deps.
 */

export type Point = { x: number; y: number };

export type ObstacleRect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Handle side a route enters/exits through. */
export type Side = "left" | "right" | "top" | "bottom";

export interface RouteInput {
  source: Point;
  target: Point;
  sourceSide: Side;
  targetSide: Side;
  obstacles: ObstacleRect[];
  /** Node ids of the edge's own endpoints — never treated as obstacles. */
  endpointIds: [string, string];
  /** Outward stub length at both handles (also the corridor probe offset). */
  offset?: number;
}

export const EDGE_ROUTE_OFFSET = 20;

const AXIS_EPS = 0.5;

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= AXIS_EPS;
}

function inflate(rect: ObstacleRect, pad: number): ObstacleRect {
  return {
    id: rect.id,
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

function segmentIntersectsRect(a: Point, b: Point, rect: ObstacleRect): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const rx2 = rect.x + rect.width;
  const ry2 = rect.y + rect.height;
  if (maxX < rect.x || minX > rx2 || maxY < rect.y || minY > ry2) return false;
  if (nearlyEqual(a.x, b.x)) {
    return a.x >= rect.x && a.x <= rx2 && maxY >= rect.y && minY <= ry2;
  }
  if (nearlyEqual(a.y, b.y)) {
    return a.y >= rect.y && a.y <= ry2 && maxX >= rect.x && minX <= rx2;
  }
  return true;
}

export function pathHitsObstacles(points: Point[], obstacles: ObstacleRect[]): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    for (const rect of obstacles) {
      if (segmentIntersectsRect(points[i], points[i + 1], rect)) return true;
    }
  }
  return false;
}

function relevantObstacles(input: RouteInput, pad: number): ObstacleRect[] {
  const [srcId, tgtId] = input.endpointIds;
  return input.obstacles
    .filter((o) => o.id !== srcId && o.id !== tgtId)
    .map((o) => inflate(o, pad));
}

/** The endpoint tables' own rects (uninflated). */
export function endpointRectsFromObstacles(
  obstacles: ObstacleRect[],
  endpointIds: [string, string],
): ObstacleRect[] {
  const [srcId, tgtId] = endpointIds;
  return obstacles.filter((o) => o.id === srcId || o.id === tgtId);
}

function stubOut(point: Point, side: Side, offset: number): Point {
  if (side === "left") return { x: point.x - offset, y: point.y };
  if (side === "top") return { x: point.x, y: point.y - offset };
  if (side === "bottom") return { x: point.x, y: point.y + offset };
  return { x: point.x + offset, y: point.y };
}

/** Point just outside the target handle, before the final inbound stub. */
function stubIn(point: Point, side: Side, offset: number): Point {
  if (side === "right") return { x: point.x + offset, y: point.y };
  if (side === "top") return { x: point.x, y: point.y - offset };
  if (side === "bottom") return { x: point.x, y: point.y + offset };
  return { x: point.x - offset, y: point.y };
}

function pointOnRectBorder(p: Point, rect: ObstacleRect): boolean {
  const rx2 = rect.x + rect.width;
  const ry2 = rect.y + rect.height;
  const onVertical =
    (nearlyEqual(p.x, rect.x) || nearlyEqual(p.x, rx2)) && p.y >= rect.y - AXIS_EPS && p.y <= ry2 + AXIS_EPS;
  const onHorizontal =
    (nearlyEqual(p.y, rect.y) || nearlyEqual(p.y, ry2)) && p.x >= rect.x - AXIS_EPS && p.x <= rx2 + AXIS_EPS;
  return onVertical || onHorizontal;
}

/**
 * True when a segment runs through an endpoint table beyond the short
 * handle stub — routes that hug their own endpoint cards look broken.
 */
export function pathSkimsEndpoints(
  points: Point[],
  endpointRects: ObstacleRect[],
  stubLen = EDGE_ROUTE_OFFSET,
): boolean {
  if (endpointRects.length === 0 || points.length < 2) return false;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    for (const rect of endpointRects) {
      if (!segmentIntersectsRect(a, b, rect)) continue;
      const stubOk =
        segLen <= stubLen + AXIS_EPS && (pointOnRectBorder(a, rect) || pointOnRectBorder(b, rect));
      if (stubOk) continue;
      return true;
    }
  }
  return false;
}

/**
 * Candidate orthogonal polylines from the outward stub to the inward stub;
 * returns the shortest that clears non-endpoint obstacles and does not skim
 * the endpoint tables. Null when every corridor is blocked (caller falls
 * back to a plain smoothstep path).
 */
export function routeOrthogonalAroundObstacles(input: RouteInput): Point[] | null {
  const offset = input.offset ?? EDGE_ROUTE_OFFSET;
  const obstacles = relevantObstacles(input, 6);
  const endpoints = endpointRectsFromObstacles(input.obstacles, input.endpointIds);
  const { source: s, target: t } = input;
  const so = stubOut(s, input.sourceSide, offset);
  const si = stubIn(t, input.targetSide, offset);

  const corridors: Point[][] = [
    [so, { x: si.x, y: so.y }, si],
    [so, { x: so.x, y: si.y }, si],
    [so, { x: so.x + offset, y: so.y }, { x: so.x + offset, y: si.y }, si],
    [so, { x: so.x - offset, y: so.y }, { x: so.x - offset, y: si.y }, si],
    [so, { x: so.x, y: so.y + offset }, { x: si.x, y: so.y + offset }, si],
    [so, { x: so.x, y: so.y - offset }, { x: si.x, y: so.y - offset }, si],
    [so, { x: si.x + offset, y: so.y }, { x: si.x + offset, y: si.y }, si],
    [so, { x: si.x - offset, y: so.y }, { x: si.x - offset, y: si.y }, si],
    [so, { x: so.x, y: Math.min(so.y, si.y) - offset }, { x: si.x, y: Math.min(so.y, si.y) - offset }, si],
    [so, { x: so.x, y: Math.max(so.y, si.y) + offset }, { x: si.x, y: Math.max(so.y, si.y) + offset }, si],
    [so, { x: Math.min(so.x, si.x) - offset, y: so.y }, { x: Math.min(so.x, si.x) - offset, y: si.y }, si],
    [so, { x: Math.max(so.x, si.x) + offset, y: so.y }, { x: Math.max(so.x, si.x) + offset, y: si.y }, si],
  ];

  let best: Point[] | null = null;
  let bestLen = Infinity;
  for (const corridor of corridors) {
    const cleaned = collapseColinearPoints(dedupePoints([s, ...corridor, t]));
    if (cleaned.length < 2) continue;
    if (pathHitsObstacles(cleaned, obstacles)) continue;
    if (pathSkimsEndpoints(cleaned, endpoints, offset)) continue;
    const len = polylineLength(cleaned);
    if (len < bestLen) {
      bestLen = len;
      best = cleaned;
    }
  }
  return best;
}

export function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

export function dedupePoints(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || !nearlyEqual(last.x, p.x) || !nearlyEqual(last.y, p.y)) {
      out.push({ x: p.x, y: p.y });
    }
  }
  return out;
}

/** Collapse consecutive collinear points on axis-aligned polylines. */
export function collapseColinearPoints(points: Point[]): Point[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const out: Point[] = [{ ...points[0] }];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    const colinearH = nearlyEqual(prev.y, cur.y) && nearlyEqual(cur.y, next.y);
    const colinearV = nearlyEqual(prev.x, cur.x) && nearlyEqual(cur.x, next.x);
    if (colinearH || colinearV) continue;
    out.push({ ...cur });
  }
  out.push({ ...points[points.length - 1] });
  return dedupePoints(out);
}

export function pointsToSvgPath(points: Point[]): string {
  if (points.length === 0) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

/**
 * Point at fraction `t` (0..1) along the polyline by arc length. Used to
 * place the cardinality badges near each end.
 */
export function pointAlongPolyline(points: Point[], t: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0] };
  const clamped = Math.min(1, Math.max(0, t));
  let total = 0;
  const segs: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const d = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    segs.push(d);
    total += d;
  }
  if (total === 0) return { ...points[0] };
  let remain = total * clamped;
  for (let i = 0; i < segs.length; i++) {
    if (remain <= segs[i]) {
      const ratio = segs[i] === 0 ? 0 : remain / segs[i];
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * ratio,
        y: points[i].y + (points[i + 1].y - points[i].y) * ratio,
      };
    }
    remain -= segs[i];
  }
  return { ...points[points.length - 1] };
}
