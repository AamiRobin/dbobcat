import { memo } from "react";

import {
  CARD_FOOTER_HEIGHT,
  CARD_HEADER_HEIGHT,
  CARD_WIDTH,
  ROW_HEIGHT,
  type DiagramNode,
  type NodeRows,
} from "@/lib/diagram-model";
import { cn } from "@/lib/utils";

/**
 * One SVG table card: header (chevron / name / hide ×), column rows with
 * PK key glyphs + PRI badge, FK anchor dots and right-aligned mono types,
 * plus the "+N more" overflow footer. Pure rendering — interaction is
 * delegated through callbacks so the canvas owns pan/drag state machines.
 */

const CHAR_PX = 5.6;

function truncate(text: string, maxWidthPx: number): string {
  if (text.length * CHAR_PX <= maxWidthPx) return text;
  return `${text.slice(0, Math.max(1, Math.floor(maxWidthPx / CHAR_PX) - 1))}…`;
}

export interface TableCardProps {
  node: DiagramNode;
  rows: NodeRows;
  collapsed: boolean;
  selected: boolean;
  dimmed: boolean;
  /** Drag/press start (pointerdown anywhere outside the buttons). */
  onPress: (nodeId: string, event: React.PointerEvent) => void;
  onSelect: (nodeId: string) => void;
  onHover: (nodeId: string | null) => void;
  onToggleCollapse: (nodeId: string) => void;
  onHide: (nodeId: string) => void;
  onOpenDesigner: (nodeId: string) => void;
}

export const TableCard = memo(function TableCard({
  node,
  rows,
  collapsed,
  selected,
  dimmed,
  onPress,
  onSelect,
  onHover,
  onToggleCollapse,
  onHide,
  onOpenDesigner,
}: TableCardProps) {
  const hasMore = !collapsed && rows.hiddenCount > 0;
  const bodyHeight = collapsed
    ? CARD_HEADER_HEIGHT
    : CARD_HEADER_HEIGHT +
      rows.rows.length * ROW_HEIGHT +
      (hasMore ? CARD_FOOTER_HEIGHT : 0);

  return (
    <g
      className={cn(
        "group cursor-default",
        dimmed ? "opacity-40 transition-opacity" : "opacity-100 transition-opacity",
      )}
      onPointerDown={(e) => onPress(node.id, e)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node.id);
      }}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpenDesigner(node.id);
      }}
    >
      <rect
        data-card={node.id}
        width={CARD_WIDTH}
        height={bodyHeight}
        rx={6}
        className="fill-card stroke-border"
        strokeWidth={selected ? 1.75 : 1}
        stroke={selected ? "var(--primary)" : undefined}
      />

      {/* Header */}
      <rect
        width={CARD_WIDTH}
        height={CARD_HEADER_HEIGHT}
        rx={6}
        className="fill-muted/70"
        style={{ pointerEvents: "none" }}
      />
      {/* Collapse chevron */}
      <g
        className="cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          onToggleCollapse(node.id);
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <rect x={2} y={2} width={20} height={CARD_HEADER_HEIGHT - 4} rx={4} className="fill-transparent" />
        <path
          d={collapsed ? "M 9 8 L 14 13 L 9 18" : "M 7 10 L 12 15 L 17 10"}
          fill="none"
          className="stroke-muted-foreground"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <text
        x={26}
        y={17}
        fontSize={11}
        fontWeight={600}
        className="fill-card-foreground"
        style={{ pointerEvents: "none" }}
      >
        {truncate(node.id, CARD_WIDTH - 44)}
      </text>
      {/* Hide × */}
      <g
        className="cursor-pointer opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onHide(node.id);
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <rect
          x={CARD_WIDTH - 22}
          y={3}
          width={19}
          height={CARD_HEADER_HEIGHT - 6}
          rx={4}
          className="fill-transparent"
        />
        <path
          d={`M ${CARD_WIDTH - 16} 9 L ${CARD_WIDTH - 9} 17 M ${CARD_WIDTH - 9} 9 L ${CARD_WIDTH - 16} 17`}
          className="stroke-muted-foreground"
          strokeWidth={1.25}
          strokeLinecap="round"
        />
      </g>

      {!collapsed && (
        <>
          <line
            x1={0}
            y1={CARD_HEADER_HEIGHT}
            x2={CARD_WIDTH}
            y2={CARD_HEADER_HEIGHT}
            className="stroke-border"
            style={{ pointerEvents: "none" }}
          />
          {rows.rows.map((col, i) => {
            const y = CARD_HEADER_HEIGHT + i * ROW_HEIGHT;
            const isPk = col.key === "PRI";
            const isFk = node.fkColumns.has(col.name);
            return (
              <g key={col.name} style={{ pointerEvents: "none" }}>
                {isPk ? (
                  <>
                    <path
                      d={`M ${11} ${y + 11} l 3.5 -4 l 3.5 4 Z`}
                      className="fill-primary"
                    />
                    <path
                      d={`M ${11} ${y + 11} h 7`}
                      className="stroke-primary"
                      strokeWidth={1.25}
                    />
                  </>
                ) : isFk ? (
                  <circle
                    cx={14}
                    cy={y + ROW_HEIGHT / 2}
                    r={3}
                    className="fill-card stroke-muted-foreground"
                    strokeWidth={1.25}
                  />
                ) : null}
                <text
                  x={isPk || isFk ? 24 : 12}
                  y={y + 13.5}
                  fontSize={10}
                  fontWeight={isPk ? 600 : 400}
                  className="fill-card-foreground"
                >
                  {truncate(col.name, CARD_WIDTH - (isPk || isFk ? 108 : 96))}
                </text>
                {isPk && (
                  <text
                    x={CARD_WIDTH - 84}
                    y={y + 13}
                    fontSize={7.5}
                    fontWeight={700}
                    textAnchor="end"
                    className="fill-primary"
                  >
                    PRI
                  </text>
                )}
                <text
                  x={CARD_WIDTH - 8}
                  y={y + 13.5}
                  fontSize={9}
                  textAnchor="end"
                  fontFamily="ui-monospace, Menlo, monospace"
                  className="fill-muted-foreground"
                >
                  {truncate(col.dataType, isPk ? 66 : 78)}
                </text>
              </g>
            );
          })}
          {hasMore && (
            <g style={{ pointerEvents: "none" }}>
              <line
                x1={0}
                y1={bodyHeight - CARD_FOOTER_HEIGHT}
                x2={CARD_WIDTH}
                y2={bodyHeight - CARD_FOOTER_HEIGHT}
                className="stroke-border"
              />
              <text
                x={CARD_WIDTH / 2}
                y={bodyHeight - CARD_FOOTER_HEIGHT + 13}
                fontSize={9}
                textAnchor="middle"
                className="fill-muted-foreground"
              >
                +{rows.hiddenCount} more
              </text>
            </g>
          )}
        </>
      )}
    </g>
  );
});
