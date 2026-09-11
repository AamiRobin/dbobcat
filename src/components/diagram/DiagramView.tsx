import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Network } from "lucide-react";

import type { ColumnMeta } from "@/types/ipc";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { DiagramCanvas } from "@/components/diagram/DiagramCanvas";
import { DiagramToolbar } from "@/components/diagram/DiagramToolbar";
import { EmptyPlaceholder } from "@/components/layout/EmptyPlaceholder";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { dbKeys, fetchTables, TREE_STALE_TIME } from "@/lib/db-queries";
import {
  diagramFileFilters,
  copyPngToClipboard,
  resolveDiagramTokens,
  serializeModelToSvgString,
  svgContentSize,
  svgToPngBlob,
  writeExportFile,
} from "@/lib/diagram-export";
import { ipc } from "@/lib/ipc";
import { computeEdgeGeometry, type CardBox, type EdgeGeometry } from "@/lib/diagram-edge-paths";
import {
  COLLAPSE_THRESHOLD,
  buildDiagramModel,
  cardHeight,
  visibleRows,
  type DiagramEdge,
} from "@/lib/diagram-model";
import { layoutDiagram } from "@/lib/diagram-layout";
import {
  DIAGRAM_STALE_TIME,
  diaKeys,
  fetchDiagramForeignKeysWithFallback,
  fetchDiagramColumnsWithFallback,
} from "@/lib/diagram-queries";
import { pickSavePath } from "@/lib/export-queries";
import { t } from "@/lib/i18n";
import { notify } from "@/lib/toast";
import { log } from "@/stores/log";
import { useConnectionStore } from "@/stores/connection";
import { EMPTY_DIAGRAM_TAB, useDiagramStore } from "@/stores/diagram";
import { openDesignerTab } from "@/stores/tabs";
import type { Tab } from "@/stores/tabs";

/**
 * ER diagram tab (Phase 1): batch schema load → pure model → dagre layout →
 * hand-rolled SVG canvas. View state (viewport/selection/positions/collapse
 * sets) lives in the per-tab zustand store; positions and hidden tables
 * persist per session+db under `diagram.<sessionId>.<db>` (debounced 500ms).
 */

interface PersistedDiagram {
  positions?: Record<string, { x: number; y: number }>;
  hidden?: string[];
  keysOnly?: boolean;
  collapsed?: Record<string, true>;
  /** Store `layoutVersion` the snapshot was written from (ordering guard). */
  layoutVersion?: number;
}

export function DiagramView({ tab }: { tab: Tab }) {
  const connId = typeof tab.meta.connId === "number" ? tab.meta.connId : null;
  const db = typeof tab.meta.db === "string" ? tab.meta.db : null;

  if (connId === null || db === null) {
    return (
      <EmptyPlaceholder
        icon={Network}
        title={t("er.error.title")}
        hint="This diagram tab is missing its connection context."
      />
    );
  }
  return <DiagramViewInner tabId={tab.id} connId={connId} db={db} />;
}

function DiagramViewInner({ tabId, connId, db }: { tabId: string; connId: number; db: string }) {
  const queryClient = useQueryClient();
  const sessionId = useConnectionStore((s) => s.session?.sessionId ?? null);
  const dia = useDiagramStore((s) => s.byTab[tabId]) ?? EMPTY_DIAGRAM_TAB;
  const patch = useDiagramStore((s) => s.patch);

  // -- data -------------------------------------------------------------------
  const tablesQuery = useQuery({
    queryKey: dbKeys.tables(connId, db),
    queryFn: () => fetchTables(connId, db),
    staleTime: TREE_STALE_TIME,
  });
  const columnsQuery = useQuery({
    queryKey: diaKeys.columns(connId, db),
    queryFn: () => fetchDiagramColumnsWithFallback(connId, db),
    staleTime: DIAGRAM_STALE_TIME,
  });
  const fksQuery = useQuery({
    queryKey: diaKeys.foreignKeys(connId, db),
    queryFn: () => fetchDiagramForeignKeysWithFallback(connId, db),
    staleTime: DIAGRAM_STALE_TIME,
  });

  // -- store hydration + persistence -------------------------------------------
  const hydrated = useRef(false);
  const persistedKeysOnly = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void ipc<PersistedDiagram | null>("app_settings_get", {
      key: `diagram.${sessionId}.${db}`,
    })
      .then((value) => {
        if (cancelled) return;
        if (value) {
          persistedKeysOnly.current = value.keysOnly;
          // Ordering guard: a persisted snapshot older than the live store
          // (edits made within the persist debounce before switching away)
          // must not overwrite fresher in-memory positions. Version-less
          // legacy blobs only hydrate tabs with no state yet.
          const current = useDiagramStore.getState().byTab[tabId];
          const isFresh =
            typeof value.layoutVersion === "number"
              ? value.layoutVersion > (current?.layoutVersion ?? 0)
              : current === undefined;
          if (isFresh) {
            patch(tabId, {
              ...(value.positions ? { positions: value.positions } : {}),
              ...(value.hidden ? { hidden: value.hidden } : {}),
              ...(value.collapsed ? { collapsed: value.collapsed } : {}),
            });
          }
        }
      })
      .catch((err) => console.warn("could not load diagram layout:", err))
      .finally(() => {
        if (!cancelled) hydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, db, tabId]);

  // Large schemas start keys-only unless the user already picked a mode.
  const keysInitialized = useRef(false);
  const tableCount = tablesQuery.data?.length ?? 0;
  useEffect(() => {
    if (keysInitialized.current || !hydrated.current) return;
    keysInitialized.current = true;
    if (typeof persistedKeysOnly.current === "boolean") {
      patch(tabId, { keysOnly: persistedKeysOnly.current });
    } else if (tableCount >= COLLAPSE_THRESHOLD) {
      patch(tabId, { keysOnly: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated.current, tableCount, tabId]);

  useEffect(() => {
    if (!hydrated.current || !sessionId) return;
    const timer = setTimeout(() => {
      const payload: PersistedDiagram = {
        positions: dia.positions,
        hidden: dia.hidden,
        keysOnly: dia.keysOnly,
        collapsed: dia.collapsed,
        layoutVersion: dia.layoutVersion,
      };
      void ipc("app_settings_set", {
        key: `diagram.${sessionId}.${db}`,
        value: payload,
      }).catch((err) => console.warn("could not persist diagram layout:", err));
    }, 500);
    return () => clearTimeout(timer);
  }, [sessionId, db, dia.positions, dia.hidden, dia.keysOnly, dia.collapsed]);

  // -- model --------------------------------------------------------------------
  const model = useMemo(() => {
    const columnsByTable: Record<string, ColumnMeta[]> = {};
    for (const entry of columnsQuery.data ?? []) {
      columnsByTable[entry.table] = entry.columns;
    }
    return buildDiagramModel(tablesQuery.data ?? [], columnsByTable, fksQuery.data ?? [], db);
  }, [tablesQuery.data, columnsQuery.data, fksQuery.data, db]);

  const hiddenSet = useMemo(() => new Set(dia.hidden), [dia.hidden]);
  const visibleNodes = useMemo(
    () => model.nodes.filter((n) => !hiddenSet.has(n.id)),
    [model.nodes, hiddenSet],
  );
  const visibleEdges = useMemo(
    () => model.edges.filter((e) => !hiddenSet.has(e.source) && !hiddenSet.has(e.target)),
    [model.edges, hiddenSet],
  );

  const collapsedIds = useMemo(() => new Set(Object.keys(dia.collapsed)), [dia.collapsed]);
  const keysOnly = dia.keysOnly;

  const rowsByNode = useMemo(() => {
    const map: Record<string, ReturnType<typeof visibleRows>> = {};
    for (const node of visibleNodes) map[node.id] = visibleRows(node, keysOnly);
    return map;
  }, [visibleNodes, keysOnly]);

  const heights = useMemo(() => {
    const map: Record<string, number> = {};
    for (const node of visibleNodes) {
      map[node.id] = cardHeight(node, keysOnly, collapsedIds.has(node.id));
    }
    return map;
  }, [visibleNodes, keysOnly, collapsedIds]);

  const layout = useMemo(
    () => layoutDiagram(visibleNodes, visibleEdges, heights),
    // layoutNonce forces a fresh dagre run (Relayout clears saved drags).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleNodes, visibleEdges, heights, dia.layoutNonce],
  );

  const boxes = useMemo(() => {
    const result: Record<string, CardBox> = {};
    for (const node of visibleNodes) {
      const pos = dia.positions[node.id] ?? layout.positions[node.id] ?? { x: 0, y: 0 };
      result[node.id] = {
        x: pos.x,
        y: pos.y,
        height: heights[node.id],
        rowIndex: collapsedIds.has(node.id)
          ? null
          : Object.fromEntries((rowsByNode[node.id]?.rows ?? []).map((c, i) => [c.name, i])),
      };
    }
    return result;
  }, [visibleNodes, dia.positions, layout.positions, heights, collapsedIds, rowsByNode]);

  const geometries = useMemo(() => {
    const map = new Map<string, EdgeGeometry>();
    for (const edge of visibleEdges) {
      const geo = computeEdgeGeometry(edge, boxes);
      if (geo) map.set(edge.id, geo);
    }
    return map;
  }, [visibleEdges, boxes]);

  const contentSize = useMemo(() => svgContentSize(visibleNodes, boxes, 24), [visibleNodes, boxes]);

  // -- interaction state ----------------------------------------------------------
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<DiagramEdge | null>(null);
  const [search, setSearch] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const fitRef = useRef<((animate?: boolean) => void) | null>(null);
  const fitToRef = useRef<((ids: string[]) => void) | null>(null);

  // Auto-fit once the first non-empty layout lands.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || visibleNodes.length === 0 || contentSize.width <= 0) return;
    fitted.current = true;
    const id = requestAnimationFrame(() => fitRef.current?.(false));
    return () => cancelAnimationFrame(id);
  }, [visibleNodes.length, contentSize.width]);

  const neighborIds = useMemo(() => {
    if (!hoveredNode && !hoveredEdge) return null;
    const ids = new Set<string>();
    for (const edge of visibleEdges) {
      if (
        edge === hoveredEdge ||
        (hoveredNode !== null && (edge.source === hoveredNode || edge.target === hoveredNode))
      ) {
        ids.add(edge.source);
        ids.add(edge.target);
      }
    }
    if (hoveredNode !== null) ids.add(hoveredNode);
    return ids;
  }, [hoveredNode, hoveredEdge, visibleEdges]);

  // -- search-in-diagram: table/column/type names; matches stay, rest fades --
  const matchIds = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const ids = new Set<string>();
    for (const node of visibleNodes) {
      if (node.id.toLowerCase().includes(q)) {
        ids.add(node.id);
        continue;
      }
      if (
        node.columns.some(
          (c) => c.name.toLowerCase().includes(q) || c.dataType.toLowerCase().includes(q),
        )
      ) {
        ids.add(node.id);
      }
    }
    return ids;
  }, [search, visibleNodes]);

  // -- focus mode: the anchor table plus its direct FK neighbours ---------------
  const focusIds = useMemo(() => {
    if (focusId === null) return null;
    const ids = new Set<string>([focusId]);
    for (const edge of visibleEdges) {
      if (edge.source === focusId) ids.add(edge.target);
      if (edge.target === focusId) ids.add(edge.source);
    }
    return ids;
  }, [focusId, visibleEdges]);

  const selectedEdge = useMemo(
    () => (dia.selection ? visibleEdges.find((e) => e.id === dia.selection) ?? null : null),
    [dia.selection, visibleEdges],
  );

  // -- actions ----------------------------------------------------------------------
  const relayout = () => patch(tabId, { positions: {}, layoutNonce: dia.layoutNonce + 1 });
  const collapseAll = () =>
    patch(tabId, {
      collapsed: Object.fromEntries(visibleNodes.map((n) => [n.id, true as const])),
    });
  const expandAll = () => patch(tabId, { collapsed: {} });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: diaKeys.all(connId) });
    void queryClient.invalidateQueries({ queryKey: dbKeys.tables(connId, db) });
  };

  // -- export -----------------------------------------------------------------------
  const [busyExport, setBusyExport] = useState(false);
  const [overwriteTarget, setOverwriteTarget] = useState<{
    path: string;
    kind: "png" | "svg";
  } | null>(null);

  async function generateBytes(kind: "png" | "svg"): Promise<Uint8Array> {
    const tokens = resolveDiagramTokens();
    const svgString = serializeModelToSvgString({
      nodes: visibleNodes,
      boxes,
      edges: [...geometries.values()],
      tokens,
      keysOnly,
      collapsed: collapsedIds,
    });
    if (kind === "svg") {
      return new TextEncoder().encode(svgString);
    }
    const blob = await svgToPngBlob(svgString, 2, tokens.background);
    if (!blob) throw new Error("could not rasterize the diagram");
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function runExport(kind: "png" | "svg", overwritePath?: string): Promise<void> {
    setBusyExport(true);
    try {
      const bytes = await generateBytes(kind);
      let targetPath: string | undefined = overwritePath;
      if (!targetPath) {
        const chosen = await pickSavePath(`${db}_er.${kind}`, diagramFileFilters(kind));
        if (!chosen) return;
        targetPath = chosen;
      }
      const path = targetPath;
      try {
        const written = await writeExportFile(path, bytes);
        log("success", `Diagram exported — ${written} bytes → ${path}`);
        notify.success("er.toast.exported", { file: path });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("file exists:")) {
          setOverwriteTarget({ path, kind });
        } else {
          throw err;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify.error(`Export failed: ${message}`);
    } finally {
      setBusyExport(false);
    }
  }

  async function copyImage(): Promise<void> {
    try {
      setBusyExport(true);
      const tokens = resolveDiagramTokens();
      const blob = await svgToPngBlob(
        serializeModelToSvgString({
          nodes: visibleNodes,
          boxes,
          edges: [...geometries.values()],
          tokens,
          keysOnly,
          collapsed: collapsedIds,
        }),
        2,
        tokens.background,
      );
      if (!blob) {
        notify.warning("er.toast.copyUnavailable");
        return;
      }
      const ok = await copyPngToClipboard(blob);
      if (ok) {
        notify.success("er.toast.copiedImage");
      } else {
        notify.warning("er.toast.copyUnavailable");
      }
    } catch (err) {
      notify.error("er.toast.copyFailed", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyExport(false);
    }
  }

  // -- render states -----------------------------------------------------------------
  const loading = tablesQuery.isPending || columnsQuery.isPending || fksQuery.isPending;
  const error = tablesQuery.error ?? columnsQuery.error ?? fksQuery.error;

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <div className="h-8 shrink-0 border-b" />
        <div className="grid flex-1 grid-cols-3 content-start gap-4 p-6">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-40 w-[200px]" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Empty className="h-full select-none">
        <EmptyHeader>
          <EmptyMedia>
            <Network className="size-8 text-muted-foreground/40" strokeWidth={1.5} />
          </EmptyMedia>
          <EmptyTitle>{t("er.error.title")}</EmptyTitle>
          <EmptyDescription>
            {error instanceof Error ? error.message : String(error)}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={refresh}>
            {t("er.error.retry")}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (model.nodes.length === 0) {
    return (
      <EmptyPlaceholder
        icon={Network}
        title={t("er.empty.noTables.title")}
        hint={t("er.empty.noTables.hint")}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DiagramToolbar
        zoom={dia.viewport.zoom}
        keysOnly={keysOnly}
        busy={busyExport}
        onKeysOnlyChange={(next) => patch(tabId, { keysOnly: next })}
        onFit={() => fitRef.current?.(false)}
        onRelayout={relayout}
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          if (value === "") setFocusId(null);
        }}
        matchLabel={
          matchIds !== null && search.trim() !== ""
            ? `${matchIds.size}/${visibleNodes.length}`
            : null
        }
        onSearchZoom={() => {
          if (matchIds !== null) fitToRef.current?.([...matchIds]);
        }}
        onCollapseAll={collapseAll}
        onExpandAll={expandAll}
        onExportPng={() => void runExport("png")}
        onExportSvg={() => void runExport("svg")}
        onCopyImage={() => void copyImage()}
        onRefresh={refresh}
      />

      {model.edges.length === 0 && (
        <div className="border-b bg-warning/10 px-3 py-1.5 text-center text-xs text-warning-foreground">
          {t("er.empty.noFks")}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <DiagramCanvas
          tabId={tabId}
          nodes={visibleNodes}
          boxes={boxes}
          edges={visibleEdges}
          geometries={geometries}
          rowsByNode={rowsByNode}
          collapsedIds={collapsedIds}
          selectedId={dia.selection}
          hoveredId={hoveredNode}
          neighborIds={neighborIds}
          matchIds={matchIds}
          focusIds={focusIds}
          focusedId={focusId}
          contentSize={contentSize}
          hoveredEdge={hoveredEdge}
          selectedEdge={selectedEdge}
          onSelect={(id) => patch(tabId, { selection: id })}
          onFocusChange={(id) => setFocusId(id)}
          onHoverCard={setHoveredNode}
          onHoverEdge={setHoveredEdge}
          onToggleCollapse={(id) => {
            const next = { ...dia.collapsed };
            if (next[id]) delete next[id];
            else next[id] = true;
            patch(tabId, { collapsed: next });
          }}
          onHide={(id) =>
            patch(tabId, {
              hidden: [...dia.hidden, id],
              selection: dia.selection === id ? null : dia.selection,
            })
          }
          onOpenDesigner={(id) => openDesignerTab(connId, db, id)}
          registerFit={(fn) => {
            fitRef.current = fn;
          }}
          registerFitTo={(fn) => {
            fitToRef.current = fn;
          }}
        />
      </div>

      {/* Status strip */}
      <div className="flex h-7 shrink-0 items-center gap-3 border-t bg-muted/40 px-3 text-xs text-muted-foreground">
        <span>
          {t("er.status.tables", { t: visibleNodes.length, r: visibleEdges.length })}
        </span>
        {model.crossDbCount > 0 && (
          <span>{t("er.status.crossDb", { count: model.crossDbCount })}</span>
        )}
        {dia.hidden.length > 0 && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            onClick={() => patch(tabId, { hidden: [] })}
          >
            {t("er.status.hidden", { count: dia.hidden.length })}
          </button>
        )}
      </div>

      <ConfirmDialog
        open={overwriteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setOverwriteTarget(null);
        }}
        title={t("er.export.existsTitle")}
        description={t("er.export.existsBody", { file: overwriteTarget?.path ?? "" })}
        confirmLabel={t("er.export.overwrite")}
        destructive
        busy={busyExport}
        onConfirm={() => {
          const target = overwriteTarget;
          setOverwriteTarget(null);
          if (target) void runExport(target.kind, target.path);
        }}
      />
    </div>
  );
}
