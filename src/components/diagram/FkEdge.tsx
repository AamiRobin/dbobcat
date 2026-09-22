import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge as FlowEdge,
  type EdgeProps,
} from "@xyflow/react";

import {
  EDGE_ROUTE_OFFSET,
  pointAlongPolyline,
  pointsToSvgPath,
  routeOrthogonalAroundObstacles,
  type Point,
} from "@/lib/diagram/edge-routing";
import { cn } from "@/lib/utils";
import { useDiagramObstacles, useDiagramUi } from "./diagram-ui-context";

/**
 * FK relationship edge, drawn child (FK owner) → parent (referenced table)
 * with a closed arrow landing on the referenced column. Routes orthogonally
 * AROUND other table cards when possible (obstacle router); falls back to a
 * plain smoothstep path when every corridor is blocked. Cardinality badges
 ("1" at the parent end, "N" at the child end) ride the rendered path;
 * composite constraints skip them (per-column cardinality is ambiguous).
 * Emphasized edges get the primary stroke + marching dashes; unrelated
 * edges fade during selection/search. Clicking shows the constraint chip.
 */

export interface FkEdgeData extends Record<string, unknown> {
  /** Constraint name. */
  name: string;
  /** Column on the child (FK owner) side. */
  fkColumn: string;
  /** Column on the parent (referenced) side. */
  refColumn: string;
  /** Child FK column is NULLable → dimmer child treatment. */
  nullableChild: boolean;
  /** Composite constraint → cardinality ambiguous (plain line, no badges). */
  composite: boolean;
  onDelete: string | null;
  onUpdate: string | null;
}

export type FkFlowEdge = FlowEdge<FkEdgeData, "fk">;

const CARDINALITY_T_SOURCE = 0.15;
const CARDINALITY_T_TARGET = 0.85;

function FkEdgeImpl({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps<FkFlowEdge>) {
  const { relatedIds, matchIds } = useDiagramUi();
  const obstacles = useDiagramObstacles();

  const routed = routeOrthogonalAroundObstacles({
    source: { x: sourceX, y: sourceY },
    target: { x: targetX, y: targetY },
    sourceSide: sourcePosition,
    targetSide: targetPosition,
    obstacles,
    endpointIds: [source, target],
    offset: EDGE_ROUTE_OFFSET,
  });

  let path: string;
  let badgePoints: Point[];
  if (routed) {
    path = pointsToSvgPath(routed);
    badgePoints = routed;
  } else {
    const [smoothPath] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      borderRadius: 8,
      offset: EDGE_ROUTE_OFFSET,
    });
    path = smoothPath;
    // Coarse approximation for badge placement along the fallback path.
    badgePoints = [
      { x: sourceX, y: sourceY },
      { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 },
      { x: targetX, y: targetY },
    ];
  }

  const sourceBadge = pointAlongPolyline(badgePoints, CARDINALITY_T_SOURCE);
  const targetBadge = pointAlongPolyline(badgePoints, CARDINALITY_T_TARGET);

  const endpointSelected = relatedIds?.has(source) === true || relatedIds?.has(target) === true;
  const emphasized = selected === true || endpointSelected;
  const dimmed =
    (relatedIds !== null && !emphasized) ||
    (matchIds !== null && !(matchIds.has(source) && matchIds.has(target)));

  const showBadges = data?.composite !== true;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={16}
        className={cn(dimmed && "opacity-20", emphasized && "rfk-edge-animated")}
        style={{
          stroke: emphasized ? "var(--primary)" : "var(--muted-foreground)",
          strokeWidth: emphasized ? 2 : 1.25,
        }}
      />
      {showBadges && !dimmed && (
        <EdgeLabelRenderer>
          <span
            className="nodrag nopan pointer-events-none absolute z-10 min-w-[1.1rem] rounded border border-border/80 bg-background/95 px-1 py-0.5 text-center font-mono text-[10px] font-semibold leading-none text-foreground shadow-sm"
            style={{ transform: `translate(-50%,-50%) translate(${sourceBadge.x}px,${sourceBadge.y}px)` }}
          >
            N
          </span>
          <span
            className="nodrag nopan pointer-events-none absolute z-10 min-w-[1.1rem] rounded border border-border/80 bg-background/95 px-1 py-0.5 text-center font-mono text-[10px] font-semibold leading-none text-foreground shadow-sm"
            style={{ transform: `translate(-50%,-50%) translate(${targetBadge.x}px,${targetBadge.y}px)` }}
          >
            1
          </span>
        </EdgeLabelRenderer>
      )}
      {selected && data && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute z-10 max-w-64 -translate-x-1/2 -translate-y-1/2 rounded-md border bg-popover px-2 py-1 font-mono text-[10px] leading-snug text-popover-foreground shadow-md"
            style={{ transform: `translate(-50%,-50%) translate(${targetBadge.x}px,${targetBadge.y}px)` }}
          >
            <div className="font-sans font-semibold">{data.name}</div>
            <div className="text-muted-foreground">
              {`${source}.${data.fkColumn} → ${target}.${data.refColumn}`}
            </div>
            {(data.onDelete || data.onUpdate) && (
              <div className="text-muted-foreground">
                {data.onDelete ? `ON DELETE ${data.onDelete}` : ""}
                {data.onDelete && data.onUpdate ? " · " : ""}
                {data.onUpdate ? `ON UPDATE ${data.onUpdate}` : ""}
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const FkEdge = memo(FkEdgeImpl);
