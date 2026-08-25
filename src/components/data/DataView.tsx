import { useQuery } from "@tanstack/react-query";
import { Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BlobViewerDialog } from "@/components/data/BlobViewerDialog";
import { DataGrid, type FocusedCell } from "@/components/data/DataGrid";
import { DataToolbar } from "@/components/data/DataToolbar";
import { DistinctValuesDialog } from "@/components/data/DistinctValuesDialog";
import { EmptyPlaceholder } from "@/components/layout/EmptyPlaceholder";
import {
  dataKeys,
  fetchDataPage,
  fetchFkRefValues,
  primaryKeyColumns,
  readClipboardText,
  type DataPageParams,
} from "@/lib/db-queries";
import { exportGridData } from "@/lib/export-queries";
import {
  cellDisplayText,
  cellRawText,
  estimateColumnWidth,
  isNumericType,
  parseCellValue,
  persistWidths,
  type GridColumn,
} from "@/lib/grid-columns";
import { t } from "@/lib/i18n";
import { log } from "@/stores/log";
import { notify } from "@/lib/toast";
import { openExportDialog } from "@/stores/export-dialog";
import { openImportWizard } from "@/stores/import-dialog";
import { getChangeset, useChangesetStore } from "@/stores/changesets";
import { fetchForeignKeys } from "@/lib/object-queries";
import {
  buildForwardJumpFilters,
  fkGroupsByColumn,
} from "@/lib/fk-navigation";
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
  /** Open "More values…" dialog for this column. */
  const [distinctColumn, setDistinctColumn] = useState<string | null>(null);

  /**
   * Narrow subscription: only the inserts list. Cell edits mutate
   * `updates`/`deletes` and must NOT re-render this component (the edited
   * cell re-renders itself via its own store subscription).
   */
  const inserts = useChangesetStore((s) => s.byTab[tabId]?.inserts ?? []);

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
  }, [query.data]);

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
  }, []);

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

  /** Ctrl+C — selected rows as TSV (NULL as literal "NULL"). */
  const onCopy = useCallback(() => {
    if (selectedIds.size === 0) return;
    const { inserts: pending } = getChangeset(tabId);
    const order = [...selectedIds].sort((a, b) => idOrder(a) - idOrder(b));
    const lines = order.map((id) => {
      if (id.startsWith("r")) {
        const row = rows[Number(id.slice(1))];
        return row ? row.map(cellDisplayText).join("\t") : "";
      }
      const ins = pending.find((r) => r.id === id);
      if (!ins) return "";
      return columnsMeta
        .map((col) => (ins.values[col.name] ? cellDisplayText(ins.values[col.name]) : ""))
        .join("\t");
    });
    void navigator.clipboard.writeText(lines.join("\n"));
    notify.success(`Copied ${order.length} row(s) to clipboard.`);
  }, [selectedIds, rows, tabId, columnsMeta]);

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

  /** Open the export dialog; selection exports client-side rows. */
  const onExportGrid = useCallback(() => {
    const selectedRows =
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
      />

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
            onQuickFilter={onQuickFilter}
            onMoreValues={setDistinctColumn}
            onPasteRows={onPasteRows}
            onCopyAs={onCopyAs}
            copyAsUpdateEnabled={canCopyAsUpdate}
            fkByColumn={fkByColumn}
            fkGroups={fkGroups}
            onGoToReferencedRow={onGoToReferencedRow}
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
            onViewBlob={(v) => setBlobValue(v)}
          />
          <BlobViewerDialog value={blobValue} onClose={() => setBlobValue(null)} />
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
