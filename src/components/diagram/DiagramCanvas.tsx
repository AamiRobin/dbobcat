import { useCallback, useEffect, useRef, useState } from "react";

import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CardBox, EdgeGeometry } from "@/lib/diagram-edge-paths";
import { CARD_WIDTH } from "@/lib/diagram-model";
import type { DiagramEdge } from "@/lib/diagram-model";
import type { DiagramNode } from "@/lib/diagram-model";
import {
  clampZoom,
  EMPTY_DIAGRAM_TAB,
  useDiagramStore,
  type DiagramPoint,
  type DiagramViewport,
} from "@/stores/diagram";
import { t } from "@/lib/i18n";

import { DiagramEdges, EdgeLabelChip } from "./DiagramEdges";
import { TableCard } from "./TableCard";

/**
 * Interactive SVG viewport: wheel pans, Ctrl/Cmd+wheel zooms at the cursor
 * (clamped 5%–400%), background drag pans, double-click on the background
 * fits (~150ms animation), Esc clears the selection. Cards drag in world
 * coordinates; hover highlighting is CSS opacity on groups.
 */

const FIT_ANIMATION_MS = 150;
const FIT_PADDING = 40;

interface DragState {
  kind: "pan" | "card";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  nodeId?: string;
}

export interface DiagramCanvasProps {
  tabId: string;
  nodes: DiagramNode[];
  boxes: Record<string, CardBox>;
  edges: DiagramEdge[];
  geometries: Map<string, EdgeGeometry>;
  rowsByNode: Record<string, { rows: DiagramNode["columns"]; hiddenCount: number }>;
  collapsedIds: Set<string>;
  selectedId: string | null;
  hoveredId: string | null;
  /** Nodes/edges adjacent to the hovered element; everything else dims. */
  neighborIds: Set<string> | null;
  /** Nodes matching the live search; everything else fades. */
  matchIds: Set<string> | null;
  /** Focus set (anchor + FK neighbours); everything else nearly vanishes. */
  focusIds: Set<string> | null;
  /** The focus-mode anchor table, for the banner + ring. */
  focusedId: string | null;
  contentSize: { width: number; height: number };
  hoveredEdge: DiagramEdge | null;
  /** Edge matching the current selection (pinned label chip). */
  selectedEdge: DiagramEdge | null;
  onSelect: (id: string | null) => void;
  onFocusChange: (id: string | null) => void;
  onHoverCard: (id: string | null) => void;
  onHoverEdge: (edge: DiagramEdge | null) => void;
  onToggleCollapse: (id: string) => void;
  onHide: (id: string) => void;
  onOpenDesigner: (id: string) => void;
  /** Registers the fit callback so the toolbar/double-click can trigger it. */
  registerFit: (fn: ((animate?: boolean) => void) | null) => void;
  /** Registers zoom-to-node-set (search Enter). */
  registerFitTo: (fn: ((ids: string[]) => void) | null) => void;
}

export function DiagramCanvas({
  tabId,
  nodes,
  boxes,
  edges,
  geometries,
  rowsByNode,
  collapsedIds,
  selectedId,
  hoveredId,
  neighborIds,
  matchIds,
  focusIds,
  focusedId,
  contentSize,
  hoveredEdge,
  selectedEdge,
  onSelect,
  onFocusChange,
  onHoverCard,
  onHoverEdge,
  onToggleCollapse,
  onHide,
  onOpenDesigner,
  registerFit,
  registerFitTo,
}: DiagramCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, setSize] = useState({ width: 0, height: 0 });
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);

  const patch = useDiagramStore((s) => s.patch);
  // Stable fallback: a fresh object here would loop useSyncExternalStore.
  const viewport = useDiagramStore(
    (s) => s.byTab[tabId]?.viewport ?? EMPTY_DIAGRAM_TAB.viewport,
  );

  // Track container size for fit math (ResizeObserver survives resizes).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Center content inside the viewport, optionally animated. */
  const fitView = useCallback(
    (animate = false) => {
      const el = containerRef.current;
      if (!el || contentSize.width <= 0 || contentSize.height <= 0) return;
      const rect = el.getBoundingClientRect();
      const zoom = clampZoom(
        Math.min(
          (rect.width - FIT_PADDING * 2) / contentSize.width,
          (rect.height - FIT_PADDING * 2) / contentSize.height,
          2,
        ),
      );
      const target: DiagramViewport = {
        zoom,
        x: (rect.width - contentSize.width * zoom) / 2,
        y: (rect.height - contentSize.height * zoom) / 2,
      };
      if (!animate) {
        patch(tabId, { viewport: target });
        return;
      }
      // ~150ms eased lerp from the current viewport.
      const start = useDiagramStore.getState().stateFor(tabId).viewport;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      const startedAt = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - startedAt) / FIT_ANIMATION_MS);
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        patch(tabId, {
          viewport: {
            x: start.x + (target.x - start.x) * eased,
            y: start.y + (target.y - start.y) * eased,
            zoom: start.zoom + (target.zoom - start.zoom) * eased,
          },
        });
        if (t < 1) rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [contentSize.width, contentSize.height, patch, tabId],
  );

  useEffect(() => {
    registerFit(fitView);
    return () => registerFit(null);
  }, [registerFit, fitView]);

  /**
   * Zoom to the union box of the given node ids (search hits). Falls back
   * to the whole-content fit when nothing matches.
   */
  const fitToNodes = useCallback(
    (ids: string[]) => {
      const points = ids
        .map((id) => boxes[id])
        .filter((b): b is CardBox => b !== undefined);
      if (points.length === 0) {
        fitView(true);
        return;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const b of points) {
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + CARD_WIDTH);
        maxY = Math.max(maxY, b.y + b.height);
      }
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const width = maxX - minX;
      const height = maxY - minY;
      const zoom = clampZoom(
        Math.min(
          (rect.width - FIT_PADDING * 2) / width,
          (rect.height - FIT_PADDING * 2) / height,
          1.5,
        ),
      );
      useDiagramStore.getState().patch(tabId, {
        viewport: {
          zoom,
          x: (rect.width - width * zoom) / 2 - minX * zoom,
          y: (rect.height - height * zoom) / 2 - minY * zoom,
        },
      });
    },
    [boxes, fitView, tabId],
  );

  useEffect(() => {
    registerFitTo(fitToNodes);
    return () => registerFitTo(null);
  }, [registerFitTo, fitToNodes]);

  // Non-passive wheel handler: plain wheel pans, Ctrl/Cmd+wheel zooms at cursor.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const state = useDiagramStore.getState().stateFor(tabId);
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const nextZoom = clampZoom(state.viewport.zoom * factor);
        // Keep the world point under the cursor fixed.
        const px = e.clientX - rect.left - state.viewport.x;
        const py = e.clientY - rect.top - state.viewport.y;
        const ratio = nextZoom / state.viewport.zoom;
        useDiagramStore.getState().patch(tabId, {
          viewport: {
            zoom: nextZoom,
            x: e.clientX - rect.left - px * ratio,
            y: e.clientY - rect.top - py * ratio,
          },
        });
      } else {
        useDiagramStore.getState().patch(tabId, {
          viewport: {
            ...state.viewport,
            x: state.viewport.x - e.deltaX,
            y: state.viewport.y - e.deltaY,
          },
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [tabId]);

  function beginDrag(event: React.PointerEvent, kind: "pan" | "card", nodeId?: string) {
    const store = useDiagramStore.getState().stateFor(tabId);
    const origin =
      kind === "card" && nodeId
        ? (store.positions[nodeId] ?? boxes[nodeId] ?? { x: 0, y: 0 })
        : store.viewport;
    dragRef.current = {
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: origin.x,
      originY: origin.y,
      nodeId,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const zoom = useDiagramStore.getState().stateFor(tabId).viewport.zoom;
    const scale = drag.kind === "card" ? zoom : 1;
    const dx = (event.clientX - drag.startClientX) / scale;
    const dy = (event.clientY - drag.startClientY) / scale;
    if (drag.kind === "pan") {
      patch(tabId, {
        viewport: { ...(useDiagramStore.getState().stateFor(tabId).viewport), x: drag.originX + dx, y: drag.originY + dy },
      });
    } else if (drag.nodeId) {
      const point: DiagramPoint = { x: drag.originX + dx, y: drag.originY + dy };
      patch(tabId, {
        positions: { ...(useDiagramStore.getState().stateFor(tabId).positions), [drag.nodeId]: point },
      });
    }
  }

  function endPointer() {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "pan") {
      // Background click clears focus first, then the selection.
      if (focusedId !== null) onFocusChange(null);
      onSelect(null);
    }
    dragRef.current = null;
  }

  // Esc clears focus first, then the selection, while this canvas is
  // mounted — unless a dialog (export confirm, command palette, …) is
  // open: its Esc handling must not also wipe the diagram underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[role="dialog"], [role="alertdialog"]')) return;
      if (focusedId !== null) onFocusChange(null);
      else onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelect, onFocusChange, focusedId]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-background">
      <svg
        className="block h-full w-full touch-none select-none outline-none"
        role="application"
        aria-label="ER diagram canvas"
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerDown={(e) => {
          // Middle button pans from anywhere (cards included).
          if (e.button === 1) beginDrag(e, "pan");
        }}
      >
        {/* Hit area so background pan/double-click-fire everywhere */}
        <rect
          x={-100000}
          y={-100000}
          width={200000}
          height={200000}
          className="fill-background"
          onPointerDown={(e) => {
            if (e.button === 0) beginDrag(e, "pan");
          }}
          onDoubleClick={() => fitView(true)}
        />
        <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.zoom})`}>
          <DiagramEdges
            edges={edges}
            geometries={geometries}
            highlightIds={hoveredId ? neighborIds : null}
            matchIds={matchIds}
            focusIds={focusIds}
            selectedId={selectedId}
            onHoverEdge={onHoverEdge}
          />
          {nodes.map((node) => {
            const box = boxes[node.id];
            if (!box) return null;
            const hoverDimmed =
              hoveredId !== null &&
              hoveredId !== node.id &&
              !(neighborIds?.has(node.id) ?? false);
            const matchDimmed = matchIds !== null && !matchIds.has(node.id);
            const focusDimmed = focusIds !== null && !focusIds.has(node.id);
            return (
              <g key={node.id} transform={`translate(${box.x},${box.y})`}>
                <TableCard
                  node={node}
                  rows={rowsByNode[node.id]}
                  collapsed={collapsedIds.has(node.id)}
                  selected={selectedId === node.id}
                  focused={focusedId === node.id}
                  dimmed={hoverDimmed || matchDimmed || focusDimmed}
                  onPress={(id, ev) => {
                    ev.stopPropagation();
                    beginDrag(ev, "card", id);
                  }}
                  onSelect={onSelect}
                  onHover={onHoverCard}
                  onToggleCollapse={onToggleCollapse}
                  onHide={onHide}
                  onOpenDesigner={onOpenDesigner}
                  onIsolate={onFocusChange}
                />
              </g>
            );
          })}
          {(hoveredEdge ?? selectedEdge) && geometries.get((hoveredEdge ?? selectedEdge)!.id) && (
            <EdgeLabelChip
              edge={(hoveredEdge ?? selectedEdge)!}
              geometry={geometries.get((hoveredEdge ?? selectedEdge)!.id)!}
            />
          )}
        </g>
      </svg>

      {focusedId !== null && (
        <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-md border bg-popover/95 px-2 py-1 text-xs shadow-sm">
          <span className="max-w-48 truncate font-medium">{focusedId}</span>
          <span className="text-muted-foreground">
            {t("er.focus.banner", { n: (focusIds?.size ?? 1) - 1 })}
          </span>
          <Button variant="ghost" size="icon-xs" onClick={() => onFocusChange(null)} aria-label={t("er.focus.exit")}>
            <X />
          </Button>
        </div>
      )}
    </div>
  );
}
