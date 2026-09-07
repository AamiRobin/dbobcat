import { useQuery } from "@tanstack/react-query";
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Search,
  Table2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BlobViewerDialog } from "@/components/data/BlobViewerDialog";
import { Button } from "@/components/ui/button";
import { DataGrid, type FocusedCell } from "@/components/data/DataGrid";
import { DataToolbar } from "@/components/data/DataToolbar";
import { DistinctValuesDialog } from "@/components/data/DistinctValuesDialog";
import { EmptyPlaceholder } from "@/components/layout/EmptyPlaceholder";
import { Separator } from "@/components/ui/separator";
import {
  dataKeys,
  fetchDataPage,
  fetchFkRefValues,
  primaryKeyColumns,
  readBlobFile,
  readClipboardText,
  writeBlobFile,
  type DataPageParams,
} from "@/lib/db-queries";
import { base64ToBytes } from "@/lib/blob-view";
import {
  exportGridData,
  pickOpenPath,
  pickSavePath,
} from "@/lib/export-queries";
import {
  cellDisplayText,
  cellRawText,
  estimateColumnWidth,
  findCellMatches,
  isNumericType,
  loadPersistedHidden,
  loadPersistedOrder,
  parseCellValue,
  persistHidden,
  persistOrder,
  persistWidths,
  reorderColumnNames,
  replaceInCell,
  type GridColumn,
} from "@/lib/grid-columns";
import { t } from "@/lib/i18n";
import { log } from "@/stores/log";
import { notify } from "@/lib/toast";
import { openExportDialog } from "@/stores/export-dialog";
import { openImportWizard } from "@/stores/import-dialog";
import {
  updateKey,
  EMPTY_CHANGESET,
  getChangeset,
  useChangesetStore,
} from "@/stores/changesets";
import {
  buildForwardJumpFilters,
  buildReverseJumpFilters,
  fkGroupsByColumn,
} from "@/lib/fk-navigation";
import { fetchForeignKeys, fetchReferencingForeignKeys, objKeys } from "@/lib/object-queries";
import { openDataTable } from "@/stores/tabs";
import { parseTsvRows, tsvCellToRowValue } from "@/lib/tsv-paste";
import type { Tab } from "@/stores/tabs";
import { useUiStore } from "@/stores/ui";
import type {
  ColumnMeta,
  FilterSpec,
  ForeignKeyMeta,
  RowValue,
  SortSpec,
} from "@/types/ipc";

/** A fetched page tagged with the params that produced it (staleness guard). */
interface PageResult {
  columns: ColumnMeta[];
  rows: RowValue[][];
  totalRowsEstimate?: number | null;
  elapsedMs: number;
  hasMore: boolean;
  params: DataPageParams;
}

const DEFAULT_PAGE_SIZE = 1000;

export function DataView({ tab }: { tab: Tab }) {
  const meta = tab.meta as {
    connId?: unknown;
    db?: unknown;
    table?: unknown;
    initialFilters?: unknown;
    filterEpoch?: unknown;
  };
  if (
    typeof meta.connId !== "number" ||
    typeof meta.db !== "string" ||
    typeof meta.table !== "string"
  ) {
    return (
      <EmptyPlaceholder
        icon={Table2}
        title="No table selected"
        hint='Open a data grid via a table’s "Open Data" context menu in the tree.'
      />
    );
  }
  return (
    // The epoch suffix remounts the view when a jump re-seeds the SAME tab
    // with new initialFilters (openDataTable bumps it); pending changesets
    // live in a module store keyed by tab id and survive the remount.
    <DataViewInner
      key={`${tab.id}:${meta.filterEpoch ?? 0}`}
      tabId={tab.id}
      connId={meta.connId}
      db={meta.db}
      table={meta.table}
      initialFilters={
        isFilterSpecArray(meta.initialFilters) ? meta.initialFilters : []
      }
    />
  );
}

function isFilterSpec(value: unknown): value is FilterSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FilterSpec).column === "string" &&
    typeof (value as FilterSpec).op === "string"
  );
}

function isFilterSpecArray(value: unknown): value is FilterSpec[] {
  return Array.isArray(value) && value.every(isFilterSpec);
}

function DataViewInner({
  tabId,
  connId,
  db,
  table,
  initialFilters = [],
}: {
  tabId: string;
  connId: number;
  db: string;
  table: string;
  /** Seeded from tab meta (FK jumps, find-text jump-to-row). */
  initialFilters?: FilterSpec[];
}) {
  // -- paging / view state --------------------------------------------------
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [offset, setOffset] = useState(0);
  const [orderBy, setOrderBy] = useState<SortSpec[]>([]);
  const [filters, setFilters] = useState<FilterSpec[]>(initialFilters);
  const [nonce, setNonce] = useState(0);
  const [pages, setPages] = useState<PageResult[]>([]);
  const [widthOverrides, setWidthOverrides] = useState<Record<string, number>>({});
  const widthOverridesRef = useRef<Record<string, number>>({});
  widthOverridesRef.current = widthOverrides;

  // -- selection / editing --------------------------------------------------
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(null);
  const [editingCell, setEditingCell] = useState<FocusedCell | null>(null);
  const [blobValue, setBlobValue] =
    useState<Extract<RowValue, { t: "bytes" }> | null>(null);
  /** Which cell the viewer was opened from — staging loaded bytes back. */
  const blobCellRef = useRef<{
    rowId: string;
    rowIndex: number;
    colIndex: number;
    kind: "real" | "insert";
  } | null>(null);
  const [blobSaving, setBlobSaving] = useState(false);
  const [blobLoading, setBlobLoading] = useState(false);
  /** Open "More values…" dialog for this column. */
  const [distinctColumn, setDistinctColumn] = useState<string | null>(null);

  /**
   * Narrow subscription: only the inserts list. Cell edits mutate
   * `updates`/`deletes` and must NOT re-render this component (the edited
   * cell re-renders itself via its own store subscription).
   */
  const inserts = useChangesetStore(
    // Stable reference: a fresh `?? []` here would loop useSyncExternalStore.
    (s) => s.byTab[tabId]?.inserts ?? EMPTY_CHANGESET.inserts,
  );

  // -- data -----------------------------------------------------------------
  const params: DataPageParams = useMemo(
    () => ({ connId, db, table, pageSize, offset, orderBy, filters }),
    [connId, db, table, pageSize, offset, orderBy, filters],
  );
  const inputsRef = useRef(params);
  inputsRef.current = params;

  const query = useQuery({
    queryKey: dataKeys.page(params),
    queryFn: async () => {
      const res = await fetchDataPage(params);
      return { ...res, params };
    },
  });

  // Accumulate pages ("Load more"), replacing on page 0 and ignoring any
  // response that no longer matches the current view parameters.
  // dataUpdatedAt is required alongside data: structural sharing keeps the
  // same data reference when nothing changed, which would skip a data-only
  // dependency and leave a hard-reloaded grid empty.
  useEffect(() => {
    const d = query.data;
    if (!d) return;
    const current = inputsRef.current;
    if (d.params.offset !== 0 && !sameParams(d.params, current)) return;
    setPages((prev) => {
      if (d.params.offset === 0) return [d];
      if (prev.some((p) => p.params.offset === d.params.offset)) return prev;
      return [...prev, d].sort((a, b) => a.params.offset - b.params.offset);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, query.dataUpdatedAt]);

  // Identity changes wipe accumulated pages immediately (avoid mixed schemas).
  useEffect(() => {
    setPages([]);
    setOffset(0);
    setSelectedIds(new Set());
    setFocusedCell(null);
    setEditingCell(null);
  }, [db, table]);

  useEffect(() => {
    setPages([]);
    setOffset(0);
    setSelectedIds(new Set());
  }, [pageSize, orderBy, filters, nonce]);

  // -- derived --------------------------------------------------------------
  const latest = pages[pages.length - 1];
  const columnsMeta = latest?.columns ?? [];
  const rows = useMemo(() => pages.flatMap((p) => p.rows), [pages]);
  const hasMore = latest?.hasMore ?? false;
  const totalEstimate = latest?.totalRowsEstimate ?? null;
  const elapsedMs = latest?.elapsedMs ?? null;

  const columns: GridColumn[] = useMemo(
    () =>
      columnsMeta.map((m) => ({
        meta: m,
        width: widthOverrides[m.name] ?? estimateColumnWidth(m),
      })),
    [columnsMeta, widthOverrides],
  );

  const pkNames = useMemo(
    () => primaryKeyColumns(columnsMeta).map((c) => c.name),
    [columnsMeta],
  );
  const pkColumns: string[] | null = pkNames.length > 0 ? pkNames : null;

  /** Column names in grid order — the coordinate system for FK jumps. */
  const columnNames = useMemo(() => columnsMeta.map((c) => c.name), [columnsMeta]);

  // Foreign keys touching this table → per-column dropdown metadata.
  const foreignKeys = useQuery({
    queryKey: ["data-fk-map", connId, db, table],
    queryFn: () => fetchForeignKeys(connId, db, table),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const fkGroups = useMemo(
    () => fkGroupsByColumn(foreignKeys.data ?? [], new Set(columnNames)),
    [foreignKeys.data, columnNames],
  );
  // First-wins view for the cell editor dropdowns (one FK per column).
  const fkByColumn = useMemo(() => {
    const map: Record<string, ForeignKeyMeta> = {};
    for (const col of Object.keys(fkGroups)) {
      const fk = fkGroups[col][0];
      if (fk) map[col] = fk;
    }
    return map;
  }, [fkGroups]);

  // Reverse references: fetched only once a Go-to submenu first asks for
  // them, then cached for the connection's lifetime (featherweight default).
  const [refsRequested, setRefsRequested] = useState(false);
  const onRequestReferencingFks = useCallback(() => setRefsRequested(true), []);
  const referencingFks = useQuery({
    queryKey: objKeys.referencingFks(connId, db, table),
    queryFn: () => fetchReferencingForeignKeys(connId, db, table),
    enabled: refsRequested,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Warn once per table about PK-less editing (full-row matching).
  useEffect(() => {
    if (columnsMeta.length > 0 && pkColumns === null) {
      log(
        "warn",
        `${table} has no primary key — UPDATE/DELETE statements will match whole rows.`,
      );
    }
  }, [columnsMeta.length, pkColumns, table]);

  // Status bar integration; cleared when this tab unmounts.
  const setDataStats = useUiStore((s) => s.setDataStats);
  const clearDataStats = useUiStore((s) => s.clearDataStats);
  useEffect(() => {
    if (!query.isPending || rows.length > 0) {
      setDataStats({ rowsLoaded: rows.length, totalRowsEstimate: totalEstimate, elapsedMs });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, totalEstimate, elapsedMs]);
  useEffect(() => () => clearDataStats(), [clearDataStats]);

  // -- actions --------------------------------------------------------------
  const hardReload = useCallback(() => {
    setOffset(0);
    setNonce((n) => n + 1);
    // Same params keep the query key (and cached data) unchanged, so clearing
    // local pages alone would never refetch — force the round-trip.
    void query.refetch();
  }, [query]);

  const onSortClick = useCallback(
    (column: string) => {
      setOrderBy(([cur]) => {
        if (!cur || cur.column !== column) return [{ column, direction: "asc" }];
        if (cur.direction === "asc") return [{ column, direction: "desc" }];
        return [];
      });
    },
    [],
  );

  /**
   * Filter-row apply: replaces this column's term when one exists, else
   * appends — other columns' terms stay untouched.
   */
  const onFilterApply = useCallback((f: FilterSpec) => {
    setFilters((prev) =>
      prev.some((term) => term.column === f.column)
        ? prev.map((term) => (term.column === f.column ? f : term))
        : [...prev, f],
    );
  }, []);
  const onFilterClearColumn = useCallback((column: string) => {
    setFilters((prev) => prev.filter((term) => term.column !== column));
  }, []);

  /** Jump to the referenced row of a FK cell through a seeded open. */
  const onGoToReferencedRow = useCallback(
    (fk: ForeignKeyMeta, cell: FocusedCell) => {
      if (!cell.rowId.startsWith("r")) return;
      const row = rows[Number(cell.rowId.slice(1))];
      if (!row) return;
      const jump = buildForwardJumpFilters(fk, row, columnNames);
      if (!jump) return;
      openDataTable(connId, fk.refDb ?? db, fk.refTable, jump);
    },
    [columnNames, connId, db, rows],
  );

  /**
   * Reverse jump: filter the CHILD table down to rows referencing this
   * parent row. The reverse lookup is scoped to the current database, so the
   * child opens in `db` (cross-schema children are out of scope in 10-B).
   */
  const onFindReferencingRows = useCallback(
    (fk: ForeignKeyMeta, cell: FocusedCell) => {
      if (!cell.rowId.startsWith("r")) return;
      const row = rows[Number(cell.rowId.slice(1))];
      if (!row) return;
      const jump = buildReverseJumpFilters(fk, row, columnNames);
      if (!jump) return;
      openDataTable(connId, db, fk.table ?? table, jump);
    },
    [columnNames, connId, db, rows, table],
  );

  const onSelectRow = useCallback((rowId: string, mods: { ctrl: boolean }) => {
    setSelectedIds((prev) => {
      if (mods.ctrl) {
        const next = new Set(prev);
        if (next.has(rowId)) next.delete(rowId);
        else next.add(rowId);
        return next;
      }
      if (prev.size === 1 && prev.has(rowId)) return prev;
      return new Set([rowId]);
    });
  }, []);

  const onSelectAll = useCallback(() => {
    const { inserts: pending } = getChangeset(tabId);
    setSelectedIds((prev) => {
      if (prev.size === rows.length + pending.length) return prev;
      const next = new Set<string>();
      for (let i = 0; i < rows.length; i++) next.add(`r${i}`);
      for (const ins of pending) next.add(ins.id);
      return next;
    });
  }, [rows.length, tabId]);

  const onClearSelection = useCallback(() => setSelectedIds((p) => (p.size ? new Set() : p)), []);

  // -- hidden columns (display only; persisted per table) --------------------

  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(
    () => new Set(loadPersistedHidden(db, table)),
  );

  const onToggleColumnVisibility = useCallback(
    (name: string, visible: boolean) => {
      setHiddenColumns((prev) => {
        const next = new Set(prev);
        if (visible) next.delete(name);
        else next.add(name);
        persistHidden(db, table, [...next]);
        return next;
      });
    },
    [db, table],
  );

  // -- column display order (header drag & drop; persisted per table) -------

  const [columnOrder, setColumnOrder] = useState<string[]>(() =>
    loadPersistedOrder(db, table),
  );

  /** Drop one column before another; persists the new display order. */
  const onColumnReorder = useCallback(
    (fromName: string, toName: string) => {
      setColumnOrder((prev) => {
        const order = reorderColumnNames(
          columns.map((c) => c.meta.name),
          prev,
        );
        const from = order.indexOf(fromName);
        const to = order.indexOf(toName);
        if (from < 0 || to < 0) return prev;
        order.splice(to, 0, order.splice(from, 1)[0]);
        persistOrder(db, table, order);
        return order;
      });
    },
    [columns, db, table],
  );

  const displayColumns = useMemo(
    () =>
      reorderColumnNames(
        columns.map((c) => c.meta.name),
        columnOrder,
      ).map(
        (name) => columns.find((c) => c.meta.name === name) as GridColumn,
      ),
    [columns, columnOrder],
  );

  const onDeleteSelected = useCallback(() => {
    const cs = getChangeset(tabId);
    for (const id of selectedIds) {
      if (id.startsWith("r")) {
        const rowIndex = Number(id.slice(1));
        if (!cs.deletes.has(rowIndex)) {
          useChangesetStore.getState().toggleDeleteRow(tabId, rowIndex);
        }
      } else {
        useChangesetStore.getState().removeInsertRow(tabId, id);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  }, [selectedIds, tabId]);

  /** Ctrl+C — selected rows as TSV (NULL as literal "NULL"), visible columns only. */
  const onCopy = useCallback(() => {
    if (selectedIds.size === 0) return;
    const { inserts: pending } = getChangeset(tabId);
    const visibleIndexes = columns
      .map((c, i) => (hiddenColumns.has(c.meta.name) ? null : i))
      .filter((i): i is number => i !== null);
    const visibleCols = visibleIndexes.map((i) => columnsMeta[i]);
    const order = [...selectedIds].sort((a, b) => idOrder(a) - idOrder(b));
    const lines = order.map((id) => {
      if (id.startsWith("r")) {
        const row = rows[Number(id.slice(1))];
        return row ? visibleIndexes.map((i) => cellDisplayText(row[i])).join("\t") : "";
      }
      const ins = pending.find((r) => r.id === id);
      if (!ins) return "";
      return visibleCols
        .map((col) => (ins.values[col.name] ? cellDisplayText(ins.values[col.name]) : ""))
        .join("\t");
    });
    void navigator.clipboard.writeText(lines.join("\n"));
    notify.success(`Copied ${order.length} row(s) to clipboard.`);
  }, [selectedIds, rows, tabId, columns, columnsMeta, hiddenColumns]);

  /**
   * Commit an edited cell: convert the raw text using the column's type
   * family, route into the changeset (insert vs update) and drop edits that
   * revert to the original value.
   */
  const onCommitEdit = useCallback(
    (cell: FocusedCell, rawText: string) => {
      setEditingCell(null);
      const col = columns[cell.colIndex];
      if (!col) return;
      const value = parseCellValue(rawText, isNumericType(col.meta.dataType));

      if (cell.rowId.startsWith("n")) {
        useChangesetStore.getState().setInsertValue(tabId, cell.rowId, col.meta.name, value);
        return;
      }

      const rowIndex = Number(cell.rowId.slice(1));
      const original = rows[rowIndex]?.[cell.colIndex];
      if (original && sameScalar(original, value)) {
        useChangesetStore.getState().removeUpdate(tabId, rowIndex, cell.colIndex);
      } else {
        useChangesetStore.getState().setUpdate(tabId, rowIndex, cell.colIndex, value);
      }
    },
    [columns, rows, tabId],
  );

  /**
   * A referenced row was picked in the FK dropdown: map it onto every grid
   * column participating in that FK (single- and multi-column alike).
   */
  const onFkPick = useCallback(
    (
      target: { rowId: string; rowIndex: number; kind: "real" | "insert" },
      fk: ForeignKeyMeta,
      refColumns: string[],
      pickedRow: RowValue[],
    ) => {
      setEditingCell(null);
      const store = useChangesetStore.getState();
      fk.columns.forEach((colName, i) => {
        const colIndex = columnsMeta.findIndex((c) => c.name === colName);
        const refIdx = refColumns.indexOf(fk.refColumns[i]);
        if (colIndex < 0 || refIdx < 0) return;
        const value = pickedRow[refIdx] ?? { t: "null" as const };
        if (target.kind === "insert") {
          store.setInsertValue(tabId, target.rowId, colName, value);
          return;
        }
        const original = rows[target.rowIndex]?.[colIndex];
        if (original && sameScalar(original, value)) {
          store.removeUpdate(tabId, target.rowIndex, colIndex);
        } else {
          store.setUpdate(tabId, target.rowIndex, colIndex, value);
        }
      });
    },
    [columnsMeta, rows, tabId],
  );

  /** Loader handed to the grid for FK dropdown fetches. */
  const onLoadFkValues = useCallback(
    (fkName: string) => fetchFkRefValues(connId, db, table, fkName, 100),
    [connId, db, table],
  );

  const onCancelEdit = useCallback(() => setEditingCell(null), []);

  const onStartEdit = useCallback((cell: FocusedCell) => {
    setFocusedCell(cell);
    setEditingCell(cell);
  }, []);

  const onSetCellNull = useCallback(
    (rowIndex: number, colName: string) => {
      const colIndex = columnsMeta.findIndex((c) => c.name === colName);
      if (colIndex >= 0) {
        useChangesetStore.getState().setUpdate(tabId, rowIndex, colIndex, { t: "null" });
      }
    },
    [columnsMeta, tabId],
  );

  const onSetCellEmptyString = useCallback(
    (rowIndex: number, colName: string) => {
      const colIndex = columnsMeta.findIndex((c) => c.name === colName);
      if (colIndex >= 0) {
        useChangesetStore.getState().setUpdate(tabId, rowIndex, colIndex, { t: "str", v: "" });
      }
    },
    [columnsMeta, tabId],
  );

  const onAddRow = useCallback(() => {
    useChangesetStore.getState().addInsertRow(tabId);
  }, [tabId]);

  /** Heidi-style "Duplicate row": stage a pre-filled insert below the grid. */
  const onDuplicateRow = useCallback(
    (rowIndex: number) => {
      const row = rows[rowIndex];
      if (!row) return;
      const values: Record<string, RowValue> = {};
      columnsMeta.forEach((col, i) => {
        // Auto-increment columns are assigned by the server on post.
        if ((col.extra ?? "").includes("auto_increment")) return;
        const v = row[i];
        if (v) values[col.name] = v;
      });
      const id = useChangesetStore.getState().addInsertRow(tabId, values);
      setSelectedIds(new Set([id]));
      const firstVisible = columns.findIndex((c) => !hiddenColumns.has(c.meta.name));
      if (firstVisible >= 0) setFocusedCell({ rowId: id, colIndex: firstVisible });
    },
    [columns, columnsMeta, hiddenColumns, rows, tabId],
  );

  const onUndo = useCallback(() => {
    useChangesetStore.getState().undo(tabId);
  }, [tabId]);

  /** Open the export dialog; selection exports client-side rows. */
  const onExportGrid = useCallback(() => {    const selectedRows =
      selectedIds.size > 0
        ? [...selectedIds]
            .sort((a, b) => idOrder(a) - idOrder(b))
            .map((id) => (id.startsWith("r") ? rows[Number(id.slice(1))] : null))
            .filter((r): r is RowValue[] => Array.isArray(r))
        : null;
    openExportDialog({
      kind: "grid",
      connId,
      db,
      table,
      columns: selectedRows ? columnsMeta.map((c) => c.name) : undefined,
      rows: selectedRows ?? undefined,
    });
  }, [columnsMeta, connId, db, rows, selectedIds, table]);

  const onImportTable = useCallback(() => {
    openImportWizard({ connId, db, table });
  }, [connId, db, table]);

  // -- BLOB file transfer (Save to file… / Load from file…) ------------------

  const onSaveBlobToFile = useCallback(
    async (bytes: number[]) => {
      const cell = blobCellRef.current;
      const colName = cell ? (columnsMeta[cell.colIndex]?.name ?? "blob") : "blob";
      try {
        setBlobSaving(true);
        const path = await pickSavePath(`${table}_${colName}.bin`, [
          { name: "Binary files", extensions: ["bin"] },
          { name: "All files", extensions: ["*"] },
        ]);
        if (!path) return;
        const written = await writeBlobFile(path, bytes);
        notify.success(`Saved ${written} byte(s) to ${path}`);
        log("success", `${table}.${colName}: ${written} byte(s) written to file.`);
      } catch (err) {
        notify.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBlobSaving(false);
      }
    },
    [columnsMeta, table],
  );

  const onLoadBlobFromFile = useCallback(async () => {
    const cell = blobCellRef.current;
    if (!cell) return;
    try {
      setBlobLoading(true);
      const path = await pickOpenPath([{ name: "All files", extensions: ["*"] }]);
      if (!path) return;
      const dataB64 = await readBlobFile(path);
      const bytes = base64ToBytes(dataB64);
      const value: RowValue = { t: "bytes", v: bytes };
      if (cell.kind === "insert") {
        const colName = columnsMeta[cell.colIndex]?.name;
        if (!colName) return;
        useChangesetStore.getState().setInsertValue(tabId, cell.rowId, colName, value);
      } else {
        useChangesetStore.getState().setUpdate(tabId, cell.rowIndex, cell.colIndex, value);
      }
      setBlobValue(value);
      notify.success(`Loaded ${bytes.length} byte(s) from ${path} — post changes to apply.`);
      log("info", `${table}: staged ${bytes.length} byte(s) from file into cell.`);
    } catch (err) {
      notify.error(`Load failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBlobLoading(false);
    }
  }, [columnsMeta, tabId, table]);

  // -- find / replace in grid ------------------------------------------------

  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [matchIdx, setMatchIdx] = useState(0);
  const [scrollToRow, setScrollToRow] = useState<{ rowIndex: number; nonce: number } | null>(null);

  const openFind = useCallback(() => setFindOpen(true), []);
  const closeFind = useCallback(() => setFindOpen(false), []);

  // Pending updates overlay: find/replace operates on what the grid SHOWS.
  const pendingUpdates = useChangesetStore((s) => s.byTab[tabId]?.updates);
  const effectiveRows = useMemo(
    () =>
      rows.map((row, i) =>
        pendingUpdates
          ? row.map((cell, j) => pendingUpdates[updateKey(i, j)] ?? cell)
          : row,
      ),
    [rows, pendingUpdates],
  );
  const visibleIndexes = useMemo(
    () =>
      columns
        .map((c, i) => (hiddenColumns.has(c.meta.name) ? -1 : i))
        .filter((i) => i >= 0),
    [columns, hiddenColumns],
  );
  const matches = useMemo(
    () => findCellMatches(effectiveRows, visibleIndexes, findText, findCaseSensitive),
    [effectiveRows, visibleIndexes, findText, findCaseSensitive],
  );

  const goToMatch = useCallback(
    (index: number) => {
      if (matches.length === 0) return;
      const wrapped = ((index % matches.length) + matches.length) % matches.length;
      setMatchIdx(wrapped);
      const m = matches[wrapped];
      setFocusedCell({ rowId: `r${m.rowIndex}`, colIndex: m.colIndex });
      setSelectedIds(new Set([`r${m.rowIndex}`]));
      setScrollToRow({ rowIndex: m.rowIndex, nonce: Date.now() });
    },
    [matches],
  );

  const replaceCurrent = useCallback(() => {
    const m = matches[matchIdx];
    if (!m) return;
    const col = columnsMeta[m.colIndex];
    const next = replaceInCell(
      effectiveRows[m.rowIndex],
      m.colIndex,
      col,
      findText,
      replaceText,
      findCaseSensitive,
    );
    if (next) {
      useChangesetStore.getState().setUpdate(tabId, m.rowIndex, m.colIndex, next);
    }
    goToMatch(matchIdx + 1);
  }, [matches, matchIdx, effectiveRows, columnsMeta, findText, replaceText, findCaseSensitive, tabId, goToMatch]);

  const replaceAll = useCallback(() => {
    if (matches.length === 0) return;
    let applied = 0;
    for (const m of matches) {
      const col = columnsMeta[m.colIndex];
      const next = replaceInCell(
        effectiveRows[m.rowIndex],
        m.colIndex,
        col,
        findText,
        replaceText,
        findCaseSensitive,
      );
      if (next) {
        useChangesetStore.getState().setUpdate(tabId, m.rowIndex, m.colIndex, next);
        applied += 1;
      }
    }
    if (applied > 0) {
      notify.success(`Replaced ${applied} cell(s) — post changes to apply.`);
    } else {
      notify.info("Nothing to replace.");
    }
  }, [matches, effectiveRows, columnsMeta, findText, replaceText, findCaseSensitive, tabId]);

  // -- Phase 9-A: quick filters / copy-as / paste rows ----------------------

  /** Selected real rows (client-side) in selection order. */
  const selectedRows = useCallback((): RowValue[][] | null => {
    if (selectedIds.size === 0) return null;
    return [...selectedIds]
      .sort((a, b) => idOrder(a) - idOrder(b))
      .flatMap((id) => {
        if (!id.startsWith("r")) return [];
        const row = rows[Number(id.slice(1))];
        return row ? [row] : [];
      });
  }, [selectedIds, rows]);

  /** Copy the current selection as INSERT/REPLACE/UPDATE statements. */
  const onCopyAs = useCallback(
    (format: "insert" | "replace" | "update") => {
      const selRows = selectedRows();
      if (!selRows || selRows.length === 0) {
        notify.info("Select row(s) to copy as SQL.");
        return;
      }
      exportGridData({
        connId,
        db,
        table,
        selectionColumns: columnsMeta.map((c) => c.name),
        selectionRows: selRows,
        format:
          format === "insert"
            ? "sql_inserts"
            : format === "replace"
              ? "sql_replaces"
              : "sql_updates",
        destination: { kind: "clipboard" },
        options:
          format === "update" ? { pkColumns: pkColumns ?? [] } : {},
        overwrite: false,
      })
        .then((result) =>
          notify.success(`Copied ${result.rows} row(s) as SQL to clipboard.`),
        )
        .catch((err) =>
          notify.error(
            `Copy as SQL failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    },
    [columnsMeta, connId, db, pkColumns, rows, selectedRows, table],
  );

  /** UPDATE copy is offered only when a PK and another column are visible. */
  const canCopyAsUpdate =
    pkColumns !== null &&
    pkColumns.length > 0 &&
    columnsMeta.length > pkColumns.length;

  /**
   * Paste clipboard TSV rows as staged inserts. Column count must match the
   * grid; cells coerce exactly like inline edits ("NULL" → NULL, numbers
   * parsed, everything else text).
   */
  const onPasteRows = useCallback(() => {
    void readClipboardText()
      .then((text) => {
        const parsed = parseTsvRows(text);
        if (parsed.length === 0) {
          notify.info("Clipboard has no rows to paste.");
          return;
        }
        if (parsed[0].length !== columnsMeta.length) {
          notify.error(
            t("grid.pasted.mismatch", {
              clipboardCols: parsed[0].length,
              gridCols: columnsMeta.length,
            }),
          );
          return;
        }
        const store = useChangesetStore.getState();
        for (const cells of parsed) {
          const id = store.addInsertRow(tabId);
          cells.forEach((raw, i) => {
            const colName = columnsMeta[i]?.name;
            if (colName) {
              store.setInsertValue(tabId, id, colName, tsvCellToRowValue(raw));
            }
          });
        }
        notify.success(t("grid.pasted.rows", { count: parsed.length }));
      })
      .catch((err) =>
        notify.error(
          `Paste failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }, [columnsMeta, tabId]);

  /**
   * Quick filter from the cell context menu REPLACES every active term
   * (Heidi semantics: a quick filter is a fresh question, not an addition).
   */
  const onQuickFilter = useCallback(
    (f: FilterSpec) => {
      setFilters([f]);
    },
    [],
  );

  // -- render ---------------------------------------------------------------
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DataToolbar
        tabId={tabId}
        connId={connId}
        db={db}
        table={table}
        columns={columnsMeta}
        rows={rows}
        pkColumns={pkColumns}
        pageSize={pageSize}
        hasMore={hasMore}
        isFetching={query.isFetching}
        selectionCount={selectedIds.size}
        filters={filters}
        orderBy={orderBy}
        onPageSizeChange={(size) => setPageSize(size)}
        onLoadMore={() => setOffset((o) => o + pageSize)}
        onRefresh={hardReload}
        onAddRow={onAddRow}
        onDeleteSelected={onDeleteSelected}
        onClearFilter={() => setFilters([])}
        onClearFilterTerm={(index) =>
          setFilters((prev) => prev.filter((_, i) => i !== index))
        }
        onHardReload={hardReload}
        onExportGrid={onExportGrid}
        onImportTable={onImportTable}
        hiddenColumns={hiddenColumns}
        onToggleColumnVisibility={onToggleColumnVisibility}
        onUndo={onUndo}
      />

      {findOpen && (
        <GridFindBar
          findText={findText}
          replaceText={replaceText}
          caseSensitive={findCaseSensitive}
          matchCount={matches.length}
          matchIndex={matchIdx}
          canReplace
          onFindText={(v) => {
            setFindText(v);
            setMatchIdx(0);
          }}
          onReplaceText={setReplaceText}
          onCaseSensitive={setFindCaseSensitive}
          onNext={() => goToMatch(matchIdx + 1)}
          onPrev={() => goToMatch(matchIdx - 1)}
          onReplace={replaceCurrent}
          onReplaceAll={replaceAll}
          onClose={closeFind}
        />
      )}

      {columnsMeta.length === 0 && query.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-muted-foreground">Loading table…</p>
        </div>
      ) : columnsMeta.length === 0 && !query.isPending ? (
        <EmptyPlaceholder
          icon={Table2}
          title={query.isError ? "Could not load table" : "No columns"}
          hint={
            query.isError
              ? (query.error as Error)?.message
              : "The table exists but reports no columns."
          }
        />
      ) : (
        <>
          <DataGrid
            tabId={tabId}
            columns={columns}
            rows={rows}
            inserts={inserts}
            selectedIds={selectedIds}
            focusedCell={focusedCell}
            editingCell={editingCell}
            sortColumn={orderBy[0]?.column ?? null}
            sortDirection={orderBy[0]?.direction ?? null}
            filters={filters}
            isLoading={query.isLoading}
            onSelectRow={onSelectRow}
            onSelectAll={onSelectAll}
            onClearSelection={onClearSelection}
            onSetFocusedCell={setFocusedCell}
            onStartEdit={onStartEdit}
            onCommitEdit={onCommitEdit}
            onCancelEdit={onCancelEdit}
            onDeleteSelected={onDeleteSelected}
            onToggleDeleteRow={(rowIndex) =>
              useChangesetStore.getState().toggleDeleteRow(tabId, rowIndex)
            }
            onRemoveInsertRow={(rowId) =>
              useChangesetStore.getState().removeInsertRow(tabId, rowId)
            }
            onSetInsertNull={(rowId, colName) =>
              useChangesetStore.getState().setInsertValue(tabId, rowId, colName, { t: "null" })
            }
            onSetCellNull={onSetCellNull}
            onSetCellEmptyString={onSetCellEmptyString}
            onCopy={onCopy}
            onSortClick={onSortClick}
            onFilterApply={onFilterApply}
            onFilterClearColumn={onFilterClearColumn}
            hiddenColumns={hiddenColumns}
            onDuplicateRow={onDuplicateRow}
            onUndo={onUndo}
            scrollToRow={scrollToRow}
            onOpenFind={openFind}
            displayColumns={displayColumns}
            onColumnReorder={onColumnReorder}
            onQuickFilter={onQuickFilter}
            onMoreValues={setDistinctColumn}
            onPasteRows={onPasteRows}
            onCopyAs={onCopyAs}
            copyAsUpdateEnabled={canCopyAsUpdate}
            fkByColumn={fkByColumn}
            fkGroups={fkGroups}
            onGoToReferencedRow={onGoToReferencedRow}
            referencingFks={refsRequested ? (referencingFks.data ?? null) : undefined}
            referencingFksLoading={referencingFks.isPending && refsRequested}
            onRequestReferencingFks={onRequestReferencingFks}
            onFindReferencingRows={onFindReferencingRows}
            onLoadFkValues={onLoadFkValues}
            onFkPick={onFkPick}
            onColumnResize={(name, width) => {
              widthOverridesRef.current = { ...widthOverridesRef.current, [name]: width };
              setWidthOverrides((prev) => ({ ...prev, [name]: width }));
            }}
            onColumnResizeCommit={(name, width) => {
              // Merge against the authoritative ref so concurrent commits
              // can't clobber each other with a stale closure snapshot.
              const merged = { ...widthOverridesRef.current, [name]: width };
              widthOverridesRef.current = merged;
              setWidthOverrides(merged);
              persistWidths(db, table, merged);
            }}
            onViewBlob={(v, cell) => {
              blobCellRef.current = cell;
              setBlobValue(v);
            }}
          />
          <BlobViewerDialog
            value={blobValue}
            onClose={() => setBlobValue(null)}
            onSaveToFile={onSaveBlobToFile}
            onLoadFromFile={onLoadBlobFromFile}
            saving={blobSaving}
            loading={blobLoading}
          />
          {distinctColumn !== null && (
            <DistinctValuesDialog
              connId={connId}
              db={db}
              table={table}
              column={distinctColumn}
              onClose={() => setDistinctColumn(null)}
              onApply={(values) =>
                onFilterApply({ column: distinctColumn, op: "in", values, value: null })
              }
            />
          )}
        </>
      )}
    </div>
  );
}

/** Selection sort order: real rows by index, then inserted rows. */
function idOrder(id: string): number {
  return id.startsWith("r") ? Number(id.slice(1)) : 1_000_000 + Number(id.slice(1));
}

function sameParams(a: DataPageParams, b: DataPageParams): boolean {
  return (
    a.db === b.db &&
    a.table === b.table &&
    a.pageSize === b.pageSize &&
    a.offset === b.offset &&
    JSON.stringify(a.orderBy) === JSON.stringify(b.orderBy) &&
    JSON.stringify(a.filters) === JSON.stringify(b.filters)
  );
}

/** Structural equality between two scalar RowValues (for edit-revert). */
function sameScalar(a: RowValue, b: RowValue): boolean {
  if (a.t !== b.t) return false;
  if (a.t === "null" && b.t === "null") return true;
  return cellRawText(a) === cellRawText(b);
}
/** Slim find/replace bar for the data grid (Ctrl+F), Heidi-style. */
function GridFindBar({
  findText,
  replaceText,
  caseSensitive,
  matchCount,
  matchIndex,
  canReplace,
  onFindText,
  onReplaceText,
  onCaseSensitive,
  onNext,
  onPrev,
  onReplace,
  onReplaceAll,
  onClose,
}: {
  findText: string;
  replaceText: string;
  caseSensitive: boolean;
  matchCount: number;
  matchIndex: number;
  canReplace: boolean;
  onFindText: (v: string) => void;
  onReplaceText: (v: string) => void;
  onCaseSensitive: (v: boolean) => void;
  onNext: () => void;
  onPrev: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}) {
  const hasQuery = findText !== "";
  const hasMatch = matchCount > 0;
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b bg-muted/30 px-2">
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        autoFocus
        value={findText}
        placeholder="Find in grid…"
        onChange={(e) => onFindText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        className="h-6 w-52 rounded-md border bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      <span className="w-20 shrink-0 text-center text-[11px] text-muted-foreground">
        {!hasQuery ? "" : hasMatch ? `${matchIndex + 1} of ${matchCount}` : "no match"}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        disabled={!hasMatch}
        onClick={onPrev}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        disabled={!hasMatch}
        onClick={onNext}
      >
        <ChevronDown />
      </Button>
      <Button
        variant={caseSensitive ? "secondary" : "ghost"}
        size="icon-xs"
        aria-label="Match case"
        aria-pressed={caseSensitive}
        onClick={() => onCaseSensitive(!caseSensitive)}
      >
        <CaseSensitive className="size-4" />
      </Button>

      <Separator orientation="vertical" className="mx-1 h-5!" />

      <input
        value={replaceText}
        placeholder="Replace with…"
        onChange={(e) => onReplaceText(e.target.value)}
        className="h-6 w-52 rounded-md border bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      <Button
        variant="ghost"
        size="xs"
        disabled={!canReplace || !hasMatch}
        onClick={onReplace}
      >
        Replace
      </Button>
      <Button
        variant="ghost"
        size="xs"
        disabled={!canReplace || !hasMatch}
        onClick={onReplaceAll}
      >
        Replace all
      </Button>

      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close find bar"
        className="ml-auto"
        onClick={onClose}
      >
        <X />
      </Button>
    </div>
  );
}
