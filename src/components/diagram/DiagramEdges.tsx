import { memo } from "react";

import type { DiagramEdge } from "@/lib/diagram-model";
import type { EdgeGeometry } from "@/lib/diagram-edge-paths";
import { cn } from "@/lib/utils";

/**
 * Edge layer: bezier paths with crow's-foot markers at the child end plus
 * a hover label chip (constraint name · ON DELETE/UPDATE actions) near the
 * midpoint. Hover highlighting is CSS-driven — no per-frame JS.
 */

function actionText(edge: DiagramEdge): string {
  const parts = [edge.onDelete, edge.onUpdate].filter(Boolean) as string[];
  const detail = parts.length > 0 ? ` · ${parts.join(" / ")}` : "";
  return `${edge.name}${detail}`;
}

export interface DiagramEdgesProps {
  edges: DiagramEdge[];
  geometries: Map<string, EdgeGeometry>;
  /** Node ids adjacent to the hovered element; all others dim. */
  highlightIds: Set<string> | null;
  /** Node ids matching the search box; non-matching edges fade further. */
  matchIds: Set<string> | null;
  /** Node ids in the focus set; non-incident edges nearly vanish. */
  focusIds: Set<string> | null;
  selectedId: string | null;
  onHoverEdge: (edge: DiagramEdge | null) => void;
}

export const DiagramEdges = memo(function DiagramEdges({
  edges,
  geometries,
  highlightIds,
  matchIds,
  focusIds,
  selectedId,
  onHoverEdge,
}: DiagramEdgesProps) {
  return (
    <g>
      {edges.map((edge) => {
        const geo = geometries.get(edge.id);
        if (!geo) return null;
        const emphasized =
          highlightIds !== null && (highlightIds.has(edge.source) || highlightIds.has(edge.target));
        const selected = selectedId === edge.id;
        const hoverDimmed =
          highlightIds !== null && !highlightIds.has(edge.source) && !highlightIds.has(edge.target);
        const matchDimmed =
          matchIds !== null && !matchIds.has(edge.source) && !matchIds.has(edge.target);
        const focusDimmed =
          focusIds !== null && !focusIds.has(edge.source) && !focusIds.has(edge.target);
        // Strongest filter wins: focus nearly hides, search fades, hover dims.
        // Literal classes only — a dynamic `opacity-${n}` would never be
        // picked up by Tailwind's source scan.
        const opacityClass = focusDimmed
          ? "opacity-15"
          : matchDimmed
            ? "opacity-30"
            : hoverDimmed
              ? "opacity-40"
              : "opacity-100";
        return (
          <g
            key={edge.id}
            className={cn("transition-opacity", opacityClass)}
            onMouseEnter={() => onHoverEdge(edge)}
            onMouseLeave={() => onHoverEdge(null)}
          >
            {/* Wide invisible hit path so thin curves stay hoverable */}
            <path d={geo.d} fill="none" stroke="transparent" strokeWidth={10} />
            <path
              d={geo.d}
              fill="none"
              strokeWidth={emphasized || selected ? 2 : 1.25}
              className={cn(emphasized || selected ? "stroke-primary" : "stroke-border")}
            />
            {geo.oneTick && (
              <path
                d={geo.oneTick}
                fill="none"
                strokeWidth={1.25}
                className={cn(emphasized || selected ? "stroke-primary" : "stroke-border")}
              />
            )}
            {geo.foot && (
              <path
                d={geo.foot}
                fill={geo.filled ? "var(--border)" : "none"}
                strokeWidth={1.25}
                className={cn(emphasized || selected ? "stroke-primary" : "stroke-border")}
                style={emphasized && geo.filled ? { fill: "var(--primary)" } : undefined}
              />
            )}
          </g>
        );
      })}
    </g>
  );
});

/** Hover chip rendered above the edge layer. */
export function EdgeLabelChip({
  edge,
  geometry,
}: {
  edge: DiagramEdge;
  geometry: EdgeGeometry;
}) {
  const text = actionText(edge);
  const width = text.length * 5.8 + 16;
  const x = geometry.labelPoint.x - width / 2;
  const y = geometry.labelPoint.y - 24;
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect
        x={x}
        y={y}
        width={width}
        height={18}
        rx={4}
        className="fill-popover stroke-border"
      />
      <text
        x={geometry.labelPoint.x}
        y={y + 12.5}
        fontSize={9.5}
        textAnchor="middle"
        className="fill-popover-foreground"
      >
        {text}
      </text>
    </g>
  );
}
