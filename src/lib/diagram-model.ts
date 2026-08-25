import type { ColumnMeta, ForeignKeyMeta, TableMeta } from "@/types/ipc";

/**
 * Pure diagram model (Phase 11): turns batch schema data into the node/edge
 * graph the canvas renders. No layout math here — see diagram-layout.ts.
 *
 * Notation: crow's foot at the CHILD ("many") end of every edge. Filled
 * foot = mandatory child column, outline foot = nullable child column,
 * plain line = composite constraint (per-column cardinality ambiguous).
 */

/** Card geometry shared by the renderer, the layouter and the exporter. */
export const CARD_WIDTH = 200;
export const ROW_HEIGHT = 20;
export const CARD_HEADER_HEIGHT = 26;
export const CARD_FOOTER_HEIGHT = 18;
/** Rows shown before the "+N more" footer kicks in. */
export const MAX_CARD_ROWS = 24;
/** Above this many tables the default flips to keys-only (readability). */
export const COLLAPSE_THRESHOLD = 40;

export interface DiagramNode {
  /** Table name — unique within one database's diagram. */
  id: string;
  table: TableMeta;
  columns: ColumnMeta[];
  totalColumns: number;
  pkNames: string[];
  /** Child-side FK column names (anchor dots on rows). */
  fkColumns: Set<string>;
}

export interface DiagramEdge {
  id: string;
  /** Constraint name (hover label). */
  name: string;
  /** Parent ("one") side — the referenced table. */
  source: string;
  /** Child ("many") side — the FK owner. */
  target: string;
  sourceColumn: string;
  targetColumn: string;
  /** Child FK column is NULLable → outline crow's foot instead of filled. */
  nullableChild: boolean;
  /** Composite constraint → simple line end (ambiguous cardinality). */
  composite: boolean;
  onUpdate: string | null;
  onDelete: string | null;
}

export interface DiagramModel {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** FKs skipped because they reference another database. */
  crossDbCount: number;
}

/**
 * Build the model. `columnsByTable` may be missing entries for tables whose
 * description failed — those render as header-only cards. `currentDb` scopes
 * edge inclusion: FKs referencing another database are skipped and counted.
 */
export function buildDiagramModel(
  tables: TableMeta[],
  columnsByTable: Record<string, ColumnMeta[]>,
  fks: ForeignKeyMeta[],
  currentDb?: string,
): DiagramModel {
  // Tables only — views are excluded from the Phase 1 scope.
  const sorted = [...tables]
    .filter((t) => t.kind === "table")
    .sort((a, b) => a.name.localeCompare(b.name));

  const nodesById = new Map<string, DiagramNode>();
  for (const table of sorted) {
    const columns = columnsByTable[table.name] ?? [];
    nodesById.set(table.name, {
      id: table.name,
      table,
      columns,
      totalColumns: columns.length,
      pkNames: columns.filter((c) => c.key === "PRI").map((c) => c.name),
      fkColumns: new Set<string>(),
    });
  }

  const edges: DiagramEdge[] = [];
  let crossDbCount = 0;

  for (const fk of fks) {
    const child = fk.table ?? null;
    if (!child || !fk.refTable) continue;
    // Cross-database references are out of scope but counted for the strip.
    // (`refDb === null` means "same database" per the wire contract.)
    if (fk.refDb && fk.refDb !== currentDb) {
      crossDbCount += 1;
      continue;
    }
    if (!nodesById.has(child) || !nodesById.has(fk.refTable)) continue;

    edges.push({
      id: `${child}\u0000${fk.name}`,
      name: fk.name,
      source: fk.refTable,
      target: child,
      sourceColumn: fk.refColumns[0] ?? "",
      targetColumn: fk.columns[0] ?? "",
      nullableChild: isChildNullable(nodesById.get(child), fk.columns[0] ?? ""),
      composite: fk.columns.length > 1,
      onUpdate: fk.onUpdate ?? null,
      onDelete: fk.onDelete ?? null,
    });
  }

  // Child-side FK anchors (dots on matching rows).
  for (const edge of edges) {
    nodesById.get(edge.target)?.fkColumns.add(edge.targetColumn);
  }

  return {
    nodes: [...nodesById.values()],
    edges,
    crossDbCount,
  };
}

function isChildNullable(child: DiagramNode | undefined, columnName: string): boolean {
  if (!child) return true;
  const col = child.columns.find((c) => c.name === columnName);
  return col ? col.nullable : true;
}

// ---------------------------------------------------------------------------
// Row visibility (keys-only mode + row cap)
// ---------------------------------------------------------------------------

export interface NodeRows {
  rows: ColumnMeta[];
  /** Rows hidden behind the "+N more" footer. */
  hiddenCount: number;
}

/** Rows of one card under the current keys-only flag, capped at MAX_CARD_ROWS. */
export function visibleRows(node: DiagramNode, keysOnly: boolean): NodeRows {
  let candidates = node.columns;
  if (keysOnly) {
    const keys = node.pkNames.length > 0 ? new Set(node.pkNames) : new Set<string>();
    for (const name of node.fkColumns) keys.add(name);
    const filtered = node.columns.filter((c) => keys.has(c.name));
    // A table without any key columns keeps its full list (never an empty card).
    if (filtered.length > 0) candidates = filtered;
  }
  return {
    rows: candidates.slice(0, MAX_CARD_ROWS),
    hiddenCount: Math.max(0, candidates.length - MAX_CARD_ROWS),
  };
}

/** Full rendered height of a card (layout + hit-testing use this). */
export function cardHeight(node: DiagramNode, keysOnly: boolean, collapsed: boolean): number {
  if (collapsed) return CARD_HEADER_HEIGHT;
  const rowCount =
    keysOnly ? visibleRows(node, true).rows.length : Math.min(node.totalColumns, MAX_CARD_ROWS);
  const hasMore =
    keysOnly
      ? visibleRows(node, true).hiddenCount > 0
      : node.totalColumns > MAX_CARD_ROWS;
  return (
    CARD_HEADER_HEIGHT +
    rowCount * ROW_HEIGHT +
    (hasMore ? CARD_FOOTER_HEIGHT : 0)
  );
}
