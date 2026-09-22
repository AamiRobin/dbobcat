import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getViewportForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { Network } from "lucide-react";

import "@xyflow/react/dist/style.css";

import { cn } from "@/lib/utils";
import type { ColumnMeta } from "@/types/ipc";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { DiagramLegend } from "@/components/diagram/DiagramLegend";
import { DiagramToolbar } from "@/components/diagram/DiagramToolbar";
import { FkEdge, type FkFlowEdge } from "@/components/diagram/FkEdge";
import { TableNode, type TableFlowNode, type TableNodeData } from "@/components/diagram/TableNode";
import { DiagramUiContext, DiagramObstaclesContext, type DiagramUiContextValue } from "@/components/diagram/diagram-ui-context";
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
import { tablesToSql } from "@/lib/diagram-ddl";
import {
  captureDiagramToDataUrl,
  copyPngToClipboard,
  dataUrlToBlob,
  dataUrlToBytes,
  diagramFileFilters,
  resolveDiagramBackground,
  writeExportFile,
  writeExportFileOverwrite,
} from "@/lib/diagram-export";
import {
  COLLAPSE_THRESHOLD,
  CARD_WIDTH,
  buildDiagramModel,
  cardHeight,
  visibleRows,
} from "@/lib/diagram-model";
import type { ObstacleRect } from "@/lib/diagram/edge-routing";
import { layoutDiagram } from "@/lib/diagram-layout";
import {
  DIAGRAM_STALE_TIME,
  diaKeys,
  fetchDiagramForeignKeysWithFallback,
  fetchDiagramColumnsWithFallback,
} from "@/lib/diagram-queries";
import { pickSavePath } from "@/lib/export-queries";
import { ipc } from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { notify } from "@/lib/toast";
import { log } from "@/stores/log";
import { useConnectionStore } from "@/stores/connection";
import { EMPTY_DIAGRAM_TAB, useDiagramStore, type DiagramPoint } from "@/stores/diagram";
import { useUiStore } from "@/stores/ui";
import { openDesignerTab } from "@/stores/tabs";
import type { Tab } from "@/stores/tabs";

/**
 * ER diagram tab, Supabase-visualizer style: batch schema load → pure model
 * → dagre layout → React Flow canvas with per-column edge anchors, minimap
 * and animated edges. Pan/zoom/selection live inside React Flow; positions,
 * hidden tables and keys-only persist per session+db under
 * `diagram.<sessionId>.<db>` (debounced 500ms).
 */

interface PersistedDiagram {
  positions?: Record<string, DiagramPoint>;
  hidden?: string[];
  keysOnly?: boolean;
  /** Store `layoutVersion` the snapshot was written from (ordering guard). */
  layoutVersion?: number;
}

const EXPORT_MAX_DIM = 6000;
/** Two frames give React Flow a tick to mount nodes + measure handles. */
const nextFrames = (count: number): Promise<void> =>
  new Promise((resolve) => {
    let left = count;
    const tick = () => (left-- <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

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
  return (
    <ReactFlowProvider>
      <DiagramViewInner tabId={tab.id} connId={connId} db={db} />
    </ReactFlowProvider>
  );
}

function DiagramViewInner({ tabId, connId, db }: { tabId: string; connId: number; db: string }) {
  const queryClient = useQueryClient();
  const theme = useUiStore((s) => s.theme);
  const sessionId = useConnectionStore((s) => s.session?.sessionId ?? null);
  const dia = useDiagramStore((s) => s.byTab[tabId]) ?? EMPTY_DIAGRAM_TAB;
  const patch = useDiagramStore((s) => s.patch);

  const { fitView, getNodes } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<TableFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FkFlowEdge>([]);

  // SVG marker defs take a concrete paint, not a var() reference.
  const markerColor = useMemo(() => {
    if (typeof document === "undefined") return "#8e8e8e";
    return (
      getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground").trim() ||
      "#8e8e8e"
    );
  }, [theme]);

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
        layoutVersion: dia.layoutVersion,
      };
      void ipc("app_settings_set", {
        key: `diagram.${sessionId}.${db}`,
        value: payload,
      }).catch((err) => console.warn("could not persist diagram layout:", err));
    }, 500);
    return () => clearTimeout(timer);
  }, [sessionId, db, dia.positions, dia.hidden, dia.keysOnly]);

  // -- model --------------------------------------------------------------------
  const keysOnly = dia.keysOnly;
  const model = useMemo(() => {
    const columnsByTable: Record<string, ColumnMeta[]> = {};
    for (const entry of columnsQuery.data ?? []) {
      columnsByTable[entry.table] = entry.columns;
    }
    return buildDiagramModel(tablesQuery.data ?? [], columnsByTable, fksQuery.data ?? [], db);
  }, [tablesQuery.data, columnsQuery.data, fksQuery.data, db]);

  const hiddenSet = useMemo(() => new Set(dia.hidden), [dia.hidden]);
  const visible = useMemo(
    () => ({
      nodes: model.nodes.filter((n) => !hiddenSet.has(n.id)),
      edges: model.edges.filter((e) => !hiddenSet.has(e.source) && !hiddenSet.has(e.target)),
    }),
    [model, hiddenSet],
  );

  const heights = useMemo(() => {
    const map: Record<string, number> = {};
    for (const node of visible.nodes) map[node.id] = cardHeight(node, keysOnly);
    return map;
  }, [visible.nodes, keysOnly]);

  const baseLayout = useMemo(
    () => layoutDiagram(visible.nodes, visible.edges, heights),
    [visible.nodes, visible.edges, heights],
  );

  // Node data is memoized separately from positions so dragging never
  // re-creates it (keeps the TableNode memo comparator effective).
  const dataByNode = useMemo(() => {
    const map: Record<string, TableNodeData> = {};
    for (const node of visible.nodes) {
      const { rows, hiddenCount } = visibleRows(node, keysOnly);
      map[node.id] = { table: node, rows, hiddenCount };
    }
    return map;
  }, [visible.nodes, keysOnly]);

  // Edges whose anchor columns are not rendered (beyond the row cap) are
  // skipped — React Flow cannot attach them to a missing handle. Edges are
  // drawn child (FK owner) → parent (referenced) so the arrow marker lands
  // on the referenced column, matching classic ER tooling.
  const rfEdges = useMemo(() => {
    const rowNames: Record<string, Set<string>> = {};
    for (const node of visible.nodes) {
      rowNames[node.id] = new Set(dataByNode[node.id]?.rows.map((c) => c.name));
    }
    return visible.edges
      .filter(
        (e) => rowNames[e.source]?.has(e.sourceColumn) && rowNames[e.target]?.has(e.targetColumn),
      )
      .map<FkFlowEdge>((e) => ({
        // The model id embeds a NUL separator; NUL is illegal in serialized
        // XML attributes and breaks html-to-image's SVG export in WebKit.
        id: e.id.replace("\u0000", "::"),
        source: e.target,
        target: e.source,
        sourceHandle: e.targetColumn,
        targetHandle: e.sourceColumn,
        type: "fk",
        deletable: false,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: markerColor,
        },
        data: {
          name: e.name,
          fkColumn: e.targetColumn,
          refColumn: e.sourceColumn,
          nullableChild: e.nullableChild,
          composite: e.composite,
          onDelete: e.onDelete,
          onUpdate: e.onUpdate,
        },
      }));
  }, [visible.nodes, visible.edges, dataByNode, markerColor]);

  // Live table-card rects (flow coordinates) feed the edge obstacle router.
  // `measured` comes from React Flow's DOM measurement; unmeasured nodes use
  // the layout constants until the first render settles.
  const obstacles = useMemo<ObstacleRect[]>(
    () =>
      nodes.map((n) => ({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        width: n.measured?.width ?? CARD_WIDTH,
        height: n.measured?.height ?? 120,
      })),
    [nodes],
  );

  // Live drag positions (kept out of the rebuild inputs; written on drag stop).
  const livePositions = useRef<Record<string, DiagramPoint>>({});

  useEffect(() => {
    const nextNodes = visible.nodes.map<TableFlowNode>((n) => ({
      id: n.id,
      type: "table",
      position:
        livePositions.current[n.id] ?? dia.positions[n.id] ?? baseLayout.positions[n.id] ?? { x: 0, y: 0 },
      data: dataByNode[n.id],
      deletable: false,
    }));
    setNodes(nextNodes);
    setEdges(rfEdges);
  }, [visible.nodes, dataByNode, baseLayout, dia.positions, rfEdges, setNodes, setEdges]);

  useEffect(() => {
    const map: Record<string, DiagramPoint> = {};
    for (const n of nodes) map[n.id] = { x: n.position.x, y: n.position.y };
    livePositions.current = map;
  }, [nodes]);

  // Fit once the first non-empty node set lands (Supabase's first-load fitView).
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || nodes.length === 0) return;
    fitted.current = true;
    const timer = setTimeout(() => {
      void fitView({ padding: 0.15, maxZoom: 1 });
    }, 30);
    return () => clearTimeout(timer);
  }, [nodes.length, fitView]);

  // -- selection / search highlight ------------------------------------------------
  const [relatedIds, setRelatedIds] = useState<Set<string> | null>(null);
  const [search, setSearch] = useState("");

  const matchIds = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const ids = new Set<string>();
    for (const node of visible.nodes) {
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
  }, [search, visible.nodes]);

  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams<TableFlowNode, FkFlowEdge>) => {
      const nodeIds = params.nodes.map((n) => n.id);
      const edgeIds = new Set(params.edges.map((e) => e.id));
      if (nodeIds.length === 0 && edgeIds.size === 0) {
        setRelatedIds(null);
        return;
      }
      const related = new Set<string>(nodeIds);
      for (const edge of visible.edges) {
        if (
          edgeIds.has(edge.id) ||
          nodeIds.includes(edge.source) ||
          nodeIds.includes(edge.target)
        ) {
          related.add(edge.source);
          related.add(edge.target);
        }
      }
      setRelatedIds(related);
    },
    [visible.edges],
  );

  // Esc clears the canvas selection (dialog-bound Esc handled upstream).
  const clearSelection = useCallback(() => {
    setNodes((nds) =>
      nds.some((n) => n.selected) ? nds.map((n) => ({ ...n, selected: false })) : nds,
    );
    setEdges((eds) =>
      eds.some((ed) => ed.selected) ? eds.map((ed) => ({ ...ed, selected: false })) : eds,
    );
  }, [setNodes, setEdges]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection]);

  const uiContext = useMemo<DiagramUiContextValue>(
    () => ({
      relatedIds,
      matchIds,
      onHideNode: (id) => patch(tabId, { hidden: [...dia.hidden, id] }),
    }),
    [relatedIds, matchIds, patch, tabId, dia.hidden],
  );

  // -- actions ----------------------------------------------------------------------
  const relayout = useCallback(() => {
    livePositions.current = {};
    patch(tabId, { positions: {} });
  }, [patch, tabId]);

  const persistPositions = useCallback(() => {
    const map: Record<string, DiagramPoint> = {};
    for (const n of getNodes()) map[n.id] = { x: n.position.x, y: n.position.y };
    livePositions.current = map;
    patch(tabId, { positions: map });
  }, [getNodes, patch, tabId]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: diaKeys.all(connId) });
    void queryClient.invalidateQueries({ queryKey: dbKeys.tables(connId, db) });
  }, [queryClient, connId, db]);

  const zoomToMatches = useCallback(() => {
    if (matchIds === null || matchIds.size === 0) return;
    void fitView({
      nodes: [...matchIds].map((id) => ({ id })),
      padding: 0.2,
      maxZoom: 1,
      duration: 300,
    });
  }, [matchIds, fitView]);

  const fitToView = useCallback(() => {
    void fitView({ padding: 0.15, maxZoom: 1, duration: 200 });
  }, [fitView]);

  // -- export -----------------------------------------------------------------------
  /** While true, `onlyRenderVisibleElements` is off so offscreen nodes mount. */
  const [exporting, setExporting] = useState(false);
  const [busyExport, setBusyExport] = useState(false);
  const [overwriteTarget, setOverwriteTarget] = useState<{
    path: string;
    kind: "png" | "svg";
  } | null>(null);

  const buildCapture = useCallback(async () => {
    const element = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!element) throw new Error("diagram is not ready");
    const bounds = getNodesBounds(getNodes());
    if (!(bounds.width > 0 && bounds.height > 0)) throw new Error("nothing to export");
    const pad = 32;
    const width = Math.min(EXPORT_MAX_DIM, Math.ceil(bounds.width + pad * 2));
    const height = Math.min(EXPORT_MAX_DIM, Math.ceil(bounds.height + pad * 2));
    const viewport = getViewportForBounds(bounds, width, height, 0.1, 2, pad);
    return {
      element,
      width,
      height,
      viewport,
      background: resolveDiagramBackground(),
    };
  }, [getNodes]);

  async function runExport(kind: "png" | "svg", overwritePath?: string, overwrite = false) {
    setBusyExport(true);
    setExporting(true);
    try {
      await nextFrames(2);
      const capture = await buildCapture();
      const dataUrl = await captureDiagramToDataUrl(kind, capture);
      const bytes = dataUrlToBytes(dataUrl);
      let targetPath: string | undefined = overwritePath;
      if (!targetPath) {
        const chosen = await pickSavePath(`${db}_er.${kind}`, diagramFileFilters(kind));
        if (!chosen) return;
        targetPath = chosen;
      }
      const path = targetPath;
      try {
        const written = overwrite
          ? await writeExportFileOverwrite(path, bytes)
          : await writeExportFile(path, bytes);
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
      setExporting(false);
    }
  }

  async function copyImage() {
    setBusyExport(true);
    setExporting(true);
    try {
      await nextFrames(2);
      const capture = await buildCapture();
      const dataUrl = await captureDiagramToDataUrl("png", capture);
      const ok = await copyPngToClipboard(dataUrlToBlob(dataUrl));
      if (ok) notify.success("er.toast.copiedImage");
      else notify.warning("er.toast.copyUnavailable");
    } catch (err) {
      notify.error("er.toast.copyFailed", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyExport(false);
      setExporting(false);
    }
  }

  async function copySql() {
    const text = tablesToSql(visible.nodes, visible.edges);
    if (!text) {
      notify.warning("er.toast.copySqlEmpty");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      notify.success("er.toast.copiedSql");
    } catch (err) {
      notify.error("er.toast.copyFailed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -- render states -----------------------------------------------------------------
  const loading = tablesQuery.isPending || columnsQuery.isPending || fksQuery.isPending;
  const error = tablesQuery.error ?? columnsQuery.error ?? fksQuery.error;

  const nodeTypes = useMemo(() => ({ table: TableNode }), []);
  const edgeTypes = useMemo(() => ({ fk: FkEdge }), []);

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <div className="h-8 shrink-0 border-b" />
        <div className="grid flex-1 grid-cols-3 content-start gap-4 p-6">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-40 w-[240px]" />
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
        keysOnly={keysOnly}
        busy={busyExport}
        onKeysOnlyChange={(next) => patch(tabId, { keysOnly: next })}
        onFit={fitToView}
        onRelayout={relayout}
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          // Searching overrides selection dimming — a stale selection would
          // keep its neighborhood lit (and everything else dark) regardless
          // of the matches.
          if (value.trim() !== "") clearSelection();
        }}
        matchLabel={
          matchIds !== null && search.trim() !== "" ? `${matchIds.size}/${visible.nodes.length}` : null
        }
        onSearchZoom={zoomToMatches}
        onExportPng={() => void runExport("png")}
        onExportSvg={() => void runExport("svg")}
        onCopyImage={() => void copyImage()}
        onCopySql={() => void copySql()}
        onRefresh={refresh}
      />

      {model.edges.length === 0 && (
        <div className="border-b bg-warning/10 px-3 py-1.5 text-center text-xs text-warning-foreground">
          {t("er.empty.noFks")}
        </div>
      )}

      <div className={cn("min-h-0 flex-1", exporting && "er-capture-clip")}>
        <DiagramUiContext.Provider value={uiContext}>
          <DiagramObstaclesContext.Provider value={obstacles}>
          <ReactFlow<TableFlowNode, FkFlowEdge>
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={{ type: "fk", deletable: false }}
            colorMode={theme}
            minZoom={0.1}
            maxZoom={1.8}
            nodesConnectable={false}
            deleteKeyCode={null}
            // MIT allows removing the credit; xyflow asks subscribers to pay
            // for the privilege but a maintainer has confirmed hiding it is
            // fine for any app (xyflow#2961). Revisit if we ever go commercial.
            proOptions={{ hideAttribution: true }}
            onlyRenderVisibleElements={!exporting}
            onNodeDragStop={persistPositions}
            onSelectionChange={onSelectionChange}
            onNodeDoubleClick={(_event, node) => openDesignerTab(connId, db, node.id)}
          >
            <Background
              gap={16}
              size={1.1}
              color="var(--muted-foreground)"
              className="opacity-[0.16]"
              variant={BackgroundVariant.Dots}
            />
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              // Near-black nodes (Supabase's value) vanish on the dark
              // minimap panel — flip to a light gray in dark mode.
              nodeColor={theme === "dark" ? "var(--muted-foreground)" : "#111318"}
              nodeBorderRadius={2}
              maskColor={theme === "dark" ? "rgb(17 19 24 / 0.8)" : "rgb(237 237 237 / 0.8)"}
              className="rounded-md border shadow-sm"
            />
            <Controls showInteractive={false} position="bottom-left" />
            <DiagramLegend />
          </ReactFlow>
          </DiagramObstaclesContext.Provider>
        </DiagramUiContext.Provider>
      </div>

      {/* Status strip */}
      <div className="flex h-7 shrink-0 items-center gap-3 border-t bg-muted/40 px-3 text-xs text-muted-foreground">
        <span>
          {t("er.status.tables", { t: visible.nodes.length, r: visible.edges.length })}
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
          if (target) void runExport(target.kind, target.path, true);
        }}
      />
    </div>
  );
}
