import {
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  ChevronDown,
  KeyRound,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { readClipboardText } from "@/lib/db-queries";
import {
  cellDisplayText,
  cellRawText,
  formatByteSize,
  isNumericType,
  isTemporalType,
  type GridColumn,
} from "@/lib/grid-columns";
import {
  updateKey,
  useChangesetStore,
  type InsertedRow,
} from "@/stores/changesets";
import { useTabHistory } from "@/stores/tab-history";
import { useTabsStore } from "@/stores/tabs";
import {
  buildForwardJumpFilters,
  buildReverseJumpFilters,
} from "@/lib/fk-navigation";
import type {
  FilterOp,
  FilterSpec,
  ForeignKeyMeta,
  RowValue,
} from "@/types/ipc";

/** Fixed row height keeps virtualizer math trivial and the grid dense. */
export const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 36;
const FILTER_HEIGHT = 26;

const FILTER_OPS: Array<{ value: FilterOp; label: string }> = [
  { value: "eq", label: "=" },
  { value: "not_eq", label: "≠" },
  { value: "lt", label: "<" },
  { value: "lt_e", label: "≤" },
  { value: "gt", label: ">" },
  { value: "gt_e", label: "≥" },
  { value: "like", label: "LIKE" },
  { value: "not_like", label: "NOT LIKE" },
  { value: "is_null", label: "IS NULL" },
  { value: "is_not_null", label: "IS NOT NULL" },
];

const PREDICATE_OPS: ReadonlySet<FilterOp> = new Set(["is_null", "is_not_null"]);

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface FocusedCell {
  rowId: string;
  colIndex: number;
}

export interface DataGridProps {
  tabId: string;
  /** Column metadata + pixel widths (order = display order). */
  columns: GridColumn[];
  rows: RowValue[][];
  inserts: InsertedRow[];
  selectedIds: Set<string>;
  focusedCell: FocusedCell | null;
  editingCell: FocusedCell | null;
  sortColumn: string | null;
  sortDirection: "asc" | "desc" | null;
  /** Active server-side WHERE terms (AND-combined), chip/filter-row state. */
  filters: FilterSpec[];
  isLoading: boolean;

  /**
   * Query-results mode: no filter row, no sorting, no editing/context-menu
   * mutations — pure browsing (Phase 3 reuses this grid for result sets).
   */
  readOnly?: boolean;
  /** Overlay text for an empty grid (defaults to table wording). */
  emptyLabel?: string;

  // -- Phase 9-A power gestures (all optional) ------------------------------
  /** Quick filter picked from a cell's context menu. */
  onQuickFilter?: (filter: FilterSpec) => void;
  /** "More values…" — opens the distinct-values dialog for this column. */
  onMoreValues?: (columnName: string) => void;
  /** Paste clipboard TSV rows as staged inserts. */
  onPasteRows?: () => void;
  /** Copy the current selection as SQL statements to the clipboard. */
  onCopyAs?: (format: "insert" | "replace" | "update") => void;
  /** UPDATE copy needs PK columns plus at least one editable column. */
  copyAsUpdateEnabled?: boolean;
  /** Column name → foreign key it participates in (editor dropdowns). */
  fkByColumn?: Record<string, ForeignKeyMeta>;
  /** Every FK constraint per column — powers the Go-to submenu. */
  fkGroups?: Record<string, ForeignKeyMeta[]>;
  /** Jump to the referenced row of one FK cell (forward navigation). */
  onGoToReferencedRow?: (fk: ForeignKeyMeta, cell: FocusedCell) => void;
  /** Reverse references for this table; undefined until first requested. */
  referencingFks?: ForeignKeyMeta[] | null;
  /** True while the reverse lookup is in flight. */
  referencingFksLoading?: boolean;
  /** First hint that the user opened a Go-to menu — triggers the lazy fetch. */
  onRequestReferencingFks?: () => void;
  /** Open the child table filtered to rows referencing this parent row. */
  onFindReferencingRows?: (fk: ForeignKeyMeta, cell: FocusedCell) => void;
  /** Load referenced values for one FK of this grid's table. */
  onLoadFkValues?: (fkName: string) => Promise<import("@/types/ipc").FkRefValues>;
  /** A FK row was picked; owners map values onto all affected columns. */
  onFkPick?: (
    target: { rowId: string; rowIndex: number; kind: "real" | "insert" },
    fk: ForeignKeyMeta,
    refColumns: string[],
    pickedRow: RowValue[],
  ) => void;
  /** Restrict editing to these column names (updatable query results). */
  editableColumns?: Set<string> | null;
  /** Editable grids that cannot server-filter (query results) suppress the row. */
  hideFilterRow?: boolean;

  onSelectRow: (rowId: string, modifiers: { ctrl: boolean }) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onSetFocusedCell: (cell: FocusedCell | null) => void;
  onStartEdit: (cell: FocusedCell) => void;
  onCommitEdit: (cell: FocusedCell, rawText: string) => void;
  onCancelEdit: () => void;
  onDeleteSelected: () => void;
  onToggleDeleteRow: (rowIndex: number) => void;
  onRemoveInsertRow: (rowId: string) => void;
  onSetInsertNull: (rowId: string, colName: string) => void;
  onSetCellNull: (rowIndex: number, colName: string) => void;
  onSetCellEmptyString: (rowIndex: number, colName: string) => void;
  onCopy: () => void;
  onSortClick: (columnName: string) => void;
  onFilterApply: (filter: FilterSpec) => void;
  onFilterClearColumn: (columnName: string) => void;
  /** Live width update while dragging (state only, not persisted). */
  onColumnResize: (columnName: string, width: number) => void;
  /** Persisted once the drag ends. */
  onColumnResizeCommit: (columnName: string, width: number) => void;
  onViewBlob: (value: Extract<RowValue, { t: "bytes" }>) => void;
}

// ---------------------------------------------------------------------------
// DataGrid
// ---------------------------------------------------------------------------

export function DataGrid(props: DataGridProps) {
  const {
    columns,
    rows,
    inserts,
    selectedIds,
    isLoading,
    readOnly = false,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const totalCount = rows.length + inserts.length;

  /** Fresh selection for keyboard shortcuts without rebuilding the handler. */
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const totalWidth = useMemo(
    () => columns.reduce((sum, c) => sum + c.width, 0),
    [columns],
  );

  /** Column names in display order — FK jumps map cells through it. */
  const columnNames = useMemo(
    () => columns.map((c) => c.meta.name),
    [columns],
  );

  /** Map a combined display index to row identity. */
  const itemAt = useCallback(
    (index: number): { kind: "real"; rowIndex: number; id: string } | { kind: "insert"; row: InsertedRow; id: string } => {
      if (index < rows.length) {
        return { kind: "real", rowIndex: index, id: `r${index}` };
      }
      const row = inserts[index - rows.length];
      return { kind: "insert", row, id: row.id };
    },
    [rows.length, inserts],
  );

  // -- keyboard -------------------------------------------------------------
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        props.onSelectAll();
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        props.onCopy();
        return;
      }
      if (mod && e.key.toLowerCase() === "v" && props.onPasteRows && !readOnly) {
        // Paste rows only outside cell editing; editors keep native paste.
        e.preventDefault();
        props.onPasteRows();
        return;
      }
      // Read-only grids keep navigation/copy but drop every editing shortcut.
      if (!readOnly) {
        if ((e.key === "Delete" || e.key === "Backspace") && selectedIdsRef.current.size > 0) {
          e.preventDefault();
          props.onDeleteSelected();
          return;
        }
        if (e.key === "Escape") {
          props.onCancelEdit();
          props.onClearSelection();
          return;
        }
        if (
          (e.key === "Enter" || e.key.toLowerCase() === "f2") &&
          props.focusedCell &&
          columnEditable(props.columns[props.focusedCell.colIndex], props.editableColumns)
        ) {
          e.preventDefault();
          props.onStartEdit(props.focusedCell);
          return;
        }
      }
      // Alt+ArrowLeft: pop back through the FK-jump trail (data grids only;
      // query-result grids pass a changeset key that is never on the stack).
      if (e.altKey && e.key === "ArrowLeft" && !readOnly && props.onGoToReferencedRow) {
        e.preventDefault();
        const prev = useTabHistory.getState().back(props.tabId);
        if (prev) useTabsStore.getState().setActive(prev);
        return;
      }
      // Alt+ArrowRight: jump to the referenced row of the focused FK cell
      // (first constraint wins). NULL/non-FK cells simply don't navigate.
      if (e.altKey && e.key === "ArrowRight" && !readOnly) {
        const cell = props.focusedCell;
        const col = cell ? props.columns[cell.colIndex] : undefined;
        const fk = col ? props.fkGroups?.[col.meta.name]?.[0] : undefined;
        if (cell && fk && cell.rowId.startsWith("r")) {
          e.preventDefault();
          props.onGoToReferencedRow?.(fk, cell);
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!props.focusedCell || totalCount === 0) return;
        const currentIndex = idToIndex(props.focusedCell.rowId, rows.length);
        const nextIndex = Math.min(
          totalCount - 1,
          Math.max(0, currentIndex + (e.key === "ArrowDown" ? 1 : -1)),
        );
        const item = itemAt(nextIndex);
        props.onSetFocusedCell({ rowId: item.id, colIndex: props.focusedCell.colIndex });
        props.onSelectRow(item.id, { ctrl: false });
      }
    },
    [props, readOnly, totalCount, itemAt, rows.length],
  );

  const showSkeleton = isLoading && totalCount === 0;
  const hasFilters = props.filters.length > 0;
  const showEmpty = !isLoading && !hasFilters && totalCount === 0;
  const showNoMatch = !isLoading && hasFilters && totalCount === 0;

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      role="grid"
      aria-label="Table data"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        // Clicking dead space clears selection/focus (cells stopPropagation).
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.deadZone) {
          props.onClearSelection();
          props.onSetFocusedCell(null);
        }
      }}
      className="relative min-h-0 flex-1 overflow-auto outline-none select-none"
    >
      {/* Width anchor so horizontal scrolling moves header + body together */}
      <div style={{ width: totalWidth, minWidth: "100%" }} className="relative">
        {/* ---- header ---- */}
        <div
          style={{ height: HEADER_HEIGHT }}
          className="sticky top-0 z-30 flex border-b bg-muted/70 backdrop-blur-[2px]"
        >
          {columns.map((col, i) => (
            <HeaderCell
              key={col.meta.name}
              column={col}
              columnIndex={i}
              readOnly={readOnly}
              sorted={
                !readOnly && props.sortColumn === col.meta.name
                  ? (props.sortDirection ?? null)
                  : null
              }
              onSortClick={() => props.onSortClick(col.meta.name)}
              onResizeLive={(w) => props.onColumnResize(col.meta.name, w)}
              onResizeCommit={(w) => props.onColumnResizeCommit(col.meta.name, w)}
            />
          ))}
        </div>

        {/* ---- filter row (browsing mode only) ---- */}
        {!readOnly && !props.hideFilterRow && (
          <div
            style={{ height: FILTER_HEIGHT, top: HEADER_HEIGHT }}
            className="sticky z-20 flex border-b bg-background/95 backdrop-blur-[2px]"
          >
            {columns.map((col) => (
              <FilterCell
                key={col.meta.name}
                column={col}
                active={latestTermForColumn(props.filters, col.meta.name)}
                onApply={(op, value) => props.onFilterApply({ column: col.meta.name, op, value })}
                onClearActive={() => props.onFilterClearColumn(col.meta.name)}
              />
            ))}
          </div>
        )}

        {/* ---- virtualized body ---- */}
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          data-dead-zone="true"
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const item = itemAt(vi.index);
            return item.kind === "real" ? (
              <RealRow
                key={vi.key}
                viStart={vi.start}
                rowIndex={item.rowIndex}
                rowId={item.id}
                rowData={props.rows[item.rowIndex] ?? []}
                columnNames={columnNames}
                {...props}
              />
            ) : (
              <InsertRow
                key={vi.key}
                viStart={vi.start}
                row={item.row}
                rowId={item.id}
                columnNames={columnNames}
                {...props}
              />
            );
          })}
        </div>

        {/* ---- overlays ---- */}
        {showSkeleton && (
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 animate-pulse rounded-b-md bg-muted/50"
            style={{ height: HEADER_HEIGHT + FILTER_HEIGHT + 96 }}
          />
        )}
        {(showEmpty || showNoMatch) && (
          <div className="pointer-events-none absolute inset-x-0 top-16 flex justify-center">
            <p className="rounded-md border bg-background/95 px-4 py-2 text-xs text-muted-foreground shadow-sm">
              {showNoMatch
                ? "No rows match the filter"
                : (props.emptyLabel ?? "Table has no rows")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function idToIndex(rowId: string, rowCount: number): number {
  return rowId.startsWith("r") ? Number(rowId.slice(1)) : rowCount + Number(rowId.slice(1));
}

/** Most recent filter term targeting one column (drives the inline row). */
function latestTermForColumn(
  filters: FilterSpec[],
  columnName: string,
): FilterSpec | null {
  for (let i = filters.length - 1; i >= 0; i--) {
    if (filters[i].column === columnName) return filters[i];
  }
  return null;
}

/** True when a cell of this column may enter edit mode at all. */
function columnEditable(
  column: GridColumn | undefined,
  editableColumns: Set<string> | null | undefined,
): boolean {
  if (!column) return false;
  return !editableColumns || editableColumns.has(column.meta.name);
}

// ---------------------------------------------------------------------------
// Header + filter rows
// ---------------------------------------------------------------------------

function HeaderCell({
  column,
  columnIndex: _columnIndex,
  readOnly = false,
  sorted,
  onSortClick,
  onResizeLive,
  onResizeCommit,
}: {
  column: GridColumn;
  columnIndex: number;
  readOnly?: boolean;
  sorted: "asc" | "desc" | null;
  onSortClick: () => void;
  onResizeLive: (width: number) => void;
  onResizeCommit: (width: number) => void;
}) {
  const width = column.width;
  const pk = column.meta.key === "PRI";

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const base = width;

    let frame = 0;
    let latest = base;
    const onMove = (ev: PointerEvent) => {
      latest = Math.max(60, Math.min(900, base + ev.clientX - startX));
      // Coalesce to animation frames so 1000-row grids stay smooth.
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          onResizeLive(latest);
        });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onResizeCommit(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const SortIcon =
    sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;

  return (
    <div
      style={{ width }}
      className="group/hc relative flex shrink-0 flex-col justify-center border-r px-2"
      title={`${column.meta.name} · ${column.meta.dataType}`}
    >
      <button
        type="button"
        onClick={onSortClick}
        disabled={readOnly}
        className="flex min-w-0 items-center gap-1 text-left"
      >
        {pk && (
          <KeyRound className="size-3 shrink-0 text-warning" aria-label="Primary key" />
        )}
        <span className="truncate text-[11px] font-semibold leading-tight">
          {column.meta.name}
        </span>
        <SortIcon
          className={cn(
            "size-3 shrink-0",
            sorted
              ? "text-primary"
              : "text-muted-foreground/40 opacity-0 group-hover/hc:opacity-100",
            readOnly && "hidden",
          )}
        />
      </button>
      <span className="truncate text-[9px] leading-tight text-muted-foreground/80 font-mono">
        {column.meta.dataType}
      </span>
      {/* resize handle */}
      <div
        onPointerDown={startDrag}
        className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/30 group-hover/hc:bg-border"
      />
    </div>
  );
}

function FilterCell({
  column,
  active,
  onApply,
  onClearActive,
}: {
  column: GridColumn;
  active: FilterSpec | null;
  onApply: (op: FilterOp, value: string) => void;
  onClearActive: () => void;
}) {
  const [op, setOp] = useState<FilterOp>("eq");
  const [text, setText] = useState("");
  const predicate = PREDICATE_OPS.has(op);

  // Reset drafts when this column's filter is cleared elsewhere (chip ✕).
  useEffect(() => {
    if (!active) setText("");
  }, [active]);

  const submit = () => {
    if (predicate) {
      onApply(op, "");
    } else if (active && text.trim() === "") {
      onClearActive();
    } else {
      onApply(op, text);
    }
  };

  // Quick-filter "IN" filters have no inline editor; the chip + dialog own them.
  const inFilter = active?.op === "in";

  return (
    <div
      style={{ width: column.width }}
      className={cn(
        "flex shrink-0 items-center gap-1 border-r px-1",
        active && "bg-warning/10",
      )}
    >
      <Select value={op} onValueChange={(v) => setOp(v as FilterOp)}>
        <SelectTrigger
          size="sm"
          className="h-5! w-auto shrink-0 gap-0.5 border-none bg-transparent px-1! text-[10px] text-muted-foreground shadow-none"
          aria-label={`Filter operator for ${column.meta.name}`}
        >
          {inFilter ? "IN" : FILTER_OPS.find((o) => o.value === op)?.label}
        </SelectTrigger>
        <SelectContent>
          {FILTER_OPS.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <input
        value={text}
        disabled={predicate || inFilter}
        placeholder={predicate ? "—" : inFilter ? `(${active?.values?.length ?? 0})` : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") {
            e.stopPropagation();
            if (active) onClearActive();
            setText("");
          }
        }}
        className="h-5 w-full min-w-0 rounded-sm bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/50 focus:bg-accent/50 px-1"
        aria-label={`Filter value for ${column.meta.name}`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Real (DB) rows
// ---------------------------------------------------------------------------

type RealRowProps = DataGridProps & {
  viStart: number;
  rowIndex: number;
  rowId: string;
  rowData: RowValue[];
  columnNames: string[];
};

const RealRow = memo(function RealRow({
  viStart,
  rowIndex,
  rowId,
  rowData,
  columnNames,
  tabId,
  selectedIds,
  focusedCell,
  editingCell,
  columns,
  readOnly = false,
  ...handlers
}: RealRowProps) {
  // Row-scoped subscription: only this row re-renders when its flag flips.
  const deleted = useChangesetStore(
    (s) => s.byTab[tabId]?.deletes.has(rowIndex) ?? false,
  );
  const selected = selectedIds.has(rowId);
  const focusedCol = focusedCell?.rowId === rowId ? focusedCell.colIndex : null;
  const editingCol = editingCell?.rowId === rowId ? editingCell.colIndex : null;

  return (
    <div
      style={{
        position: "absolute",
        top: viStart,
        left: 0,
        height: ROW_HEIGHT,
      }}
      className={cn(
        "flex border-b",
        selected ? "bg-accent/60" : "hover:bg-accent/25",
        deleted && "bg-destructive/10",
      )}
    >
      {columns.map((col, colIndex) => (
        <GridCell
          key={col.meta.name}
          tabId={tabId}
          column={col}
          colIndex={colIndex}
          rowId={rowId}
          rowIndex={rowIndex}
          kind="real"
          baseValue={rowData[colIndex]}
          rowData={rowData}
          columnNames={columnNames}
          selected={selected}
          deleted={deleted}
          focused={focusedCol === colIndex}
          editing={!readOnly && editingCol === colIndex}
          readOnly={readOnly}
          handlers={handlers}
        />
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Locally inserted rows
// ---------------------------------------------------------------------------

type InsertRowProps = DataGridProps & {
  viStart: number;
  row: InsertedRow;
  rowId: string;
  columnNames: string[];
};

const InsertRow = memo(function InsertRow({
  viStart,
  row,
  rowId,
  columnNames,
  tabId,
  selectedIds,
  focusedCell,
  editingCell,
  columns,
  ...handlers
}: InsertRowProps) {
  const selected = selectedIds.has(rowId);
  const focusedCol = focusedCell?.rowId === rowId ? focusedCell.colIndex : null;
  const editingCol = editingCell?.rowId === rowId ? editingCell.colIndex : null;

  return (
    <div
      style={{ position: "absolute", top: viStart, left: 0, height: ROW_HEIGHT }}
      className={cn(
        "flex border-b border-success/30 bg-success/[0.08]",
        selected && "bg-success/20",
      )}
    >
      {columns.map((col, colIndex) => (
        <GridCell
          key={col.meta.name}
          tabId={tabId}
          column={col}
          colIndex={colIndex}
          rowId={rowId}
          rowIndex={-1}
          kind="insert"
          baseValue={row.values[col.meta.name]}
          columnNames={columnNames}
          selected={selected}
          deleted={false}
          focused={focusedCol === colIndex}
          editing={editingCol === colIndex}
          readOnly={false}
          handlers={handlers}
        />
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

type CellHandlers = Omit<
  DataGridProps,
  | "tabId" | "columns" | "rows" | "inserts" | "selectedIds" | "focusedCell"
  | "editingCell" | "sortColumn" | "sortDirection" | "filters" | "isLoading"
  | "readOnly" | "emptyLabel"
  | "onSelectAll" | "onClearSelection" | "onCopy"
>;

interface GridCellProps {
  tabId: string;
  column: GridColumn;
  colIndex: number;
  rowId: string;
  rowIndex: number;
  kind: "real" | "insert";
  baseValue: RowValue | undefined;
  /** Full row values (real rows only) — FK jumps map through it. */
  rowData?: RowValue[];
  /** Column names in display order — jump filters index by it. */
  columnNames: string[];
  selected: boolean;
  deleted: boolean;
  focused: boolean;
  editing: boolean;
  /** Query-results browsing mode: no editing, no mutating context actions. */
  readOnly: boolean;
  handlers: CellHandlers;
}

function GridCell({
  tabId,
  column,
  colIndex,
  rowId,
  rowIndex,
  kind,
  baseValue,
  rowData,
  columnNames,
  deleted,
  focused,
  editing,
  readOnly,
  handlers,
}: GridCellProps) {
  const { meta } = column;

  // Targeted subscription: only THIS cell re-renders when its own edit lands.
  const key = updateKey(rowIndex, colIndex);
  const edited = useChangesetStore((s) =>
    kind === "real" && !readOnly ? s.byTab[tabId]?.updates[key] : undefined,
  );

  const value = edited ?? baseValue;

  const numeric = isNumericType(meta.dataType);
  const temporal = isTemporalType(meta.dataType);
  const isBytes = value?.t === "bytes";
  // Updatable query results mark expression columns read-only.
  const columnLocked = !columnEditable(column, handlers.editableColumns);

  const selectThis = (e: React.MouseEvent) => {
    e.stopPropagation();
    handlers.onSetFocusedCell({ rowId, colIndex });
    handlers.onSelectRow(rowId, { ctrl: e.ctrlKey || e.metaKey });
    // Clicking a BLOB cell jumps straight to the binary viewer.
    if (isBytes && value && value.t === "bytes") {
      handlers.onViewBlob(value);
    }
  };

  /** Quick-filter items built from this cell's text (NULL swaps the set). */
  const quickFilterItems = () => {
    if (!handlers.onQuickFilter && !handlers.onMoreValues) return null;
    const apply = (op: FilterOp, filterValue?: string) => {
      if (filterValue === undefined) {
        handlers.onQuickFilter?.({ column: meta.name, op, value: null });
      } else {
        handlers.onQuickFilter?.({
          column: meta.name,
          op,
          value: filterValue,
          values: [],
        });
      }
    };
    const text = cellDisplayText(value);
    const isNull = !value || value.t === "null";
    return (
      <>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger className="text-xs">
            {t("grid.quickFilter")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-56">
            {isNull ? (
              <>
                <ContextMenuItem className="text-xs" onClick={() => apply("is_null")}>
                  IS NULL
                </ContextMenuItem>
                <ContextMenuItem className="text-xs" onClick={() => apply("is_not_null")}>
                  IS NOT NULL
                </ContextMenuItem>
              </>
            ) : (
              <>
                <ContextMenuItem className="text-xs" onClick={() => apply("eq", text)}>
                  = {text}
                </ContextMenuItem>
                <ContextMenuItem className="text-xs" onClick={() => apply("not_eq", text)}>
                  &lt;&gt; {text}
                </ContextMenuItem>
                <ContextMenuItem
                  className="text-xs"
                  onClick={() => apply("like", `%${text}%`)}
                >
                  LIKE %{text}%
                </ContextMenuItem>
                <ContextMenuItem className="text-xs" onClick={() => apply("gt", text)}>
                  &gt; {text}
                </ContextMenuItem>
                <ContextMenuItem className="text-xs" onClick={() => apply("lt", text)}>
                  &lt; {text}
                </ContextMenuItem>
              </>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {handlers.onMoreValues && (
          <ContextMenuItem
            className="text-xs"
            onClick={() => handlers.onMoreValues?.(meta.name)}
          >
            {t("grid.quickFilter.moreValues")}
          </ContextMenuItem>
        )}
        {handlers.onQuickFilter && (
          <ContextMenuItem
            className="text-xs"
            onClick={() => {
              void readClipboardText().then((clip) => {
                if (clip.length > 0) apply("eq", clip);
              });
            }}
          >
            {t("grid.quickFilter.byClipboard")}
          </ContextMenuItem>
        )}
      </>
    );
  };

  /** Copy-as submenu (selection exports through the Rust clipboard sink). */
  const copyAsItems = () => {
    if (!handlers.onCopyAs || readOnly) return null;
    return (
      <ContextMenuSub>
        <ContextMenuSubTrigger className="text-xs">
          {t("grid.copyAs")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56">
          <ContextMenuItem
            className="text-xs"
            onClick={() => handlers.onCopyAs?.("insert")}
          >
            {t("grid.copyAs.insert")}
          </ContextMenuItem>
          <ContextMenuItem
            className="text-xs"
            onClick={() => handlers.onCopyAs?.("replace")}
          >
            {t("grid.copyAs.replace")}
          </ContextMenuItem>
          <ContextMenuItem
            className="text-xs"
            disabled={!handlers.copyAsUpdateEnabled}
            onClick={() => handlers.onCopyAs?.("update")}
          >
            {t("grid.copyAs.update")}
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
  };

  const cellFk =
    !readOnly &&
    !columnLocked &&
    handlers.fkByColumn?.[meta.name];

  /**
   * Hover ↗ affordance: forward jump via the column's first FK. Only real,
   * non-NULL, non-locked FK cells of editable grids render it — and only for
   * rows currently in the virtualizer window, so DOM cost stays bounded.
   */
  const showJumpGlyph =
    kind === "real" &&
    !!cellFk &&
    !!handlers.onGoToReferencedRow &&
    value !== undefined &&
    value.t !== "null";

  /**
   * Go-to submenu: one entry per FK constraint on this column (disabled with
   * a reason when the cell is NULL) plus the lazy "referencing" sub-menu.
   * Hidden when the column has no FK or navigation is unavailable.
   */
  const goToItems = () => {
    if (!handlers.onGoToReferencedRow || readOnly || kind !== "real") return null;
    const groups = handlers.fkGroups?.[meta.name];
    if (!groups || groups.length === 0) return null;
    const ambiguous = groups.length > 1;
    return (
      <ContextMenuSub>
        <ContextMenuSubTrigger className="text-xs">
          {t("grid.fk.goTo")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-64">
          {groups.map((fk) => {
            const jumpable =
              rowData !== undefined &&
              buildForwardJumpFilters(fk, rowData, columnNames) !== null;
            const label = fk.columns.length > 1
              ? t("grid.fk.goToComposite", { table: fk.refTable, count: fk.columns.length })
              : t("grid.fk.goToRef", { table: fk.refTable });
            return (
              <ContextMenuItem
                key={fk.name}
                className="text-xs"
                disabled={!jumpable}
                title={!jumpable ? t("grid.fk.nullCell") : fk.name}
                onClick={() =>
                  handlers.onGoToReferencedRow?.(fk, { rowId, colIndex })
                }
              >
                {label}
                {ambiguous && (
                  <span className="ml-1 text-muted-foreground">
                    · {t("grid.fk.constraint", { name: fk.name })}
                  </span>
                )}
              </ContextMenuItem>
            );
          })}
          {handlers.onFindReferencingRows && (
            <ContextMenuSub>
              <ContextMenuSubTrigger
                className="text-xs"
                onPointerEnter={() => handlers.onRequestReferencingFks?.()}
                onFocus={() => handlers.onRequestReferencingFks?.()}
              >
                {t("grid.fk.referencing")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-64">
                <ReferencingItems rowData={rowData} columnNames={columnNames} rowId={rowId} colIndex={colIndex} handlers={handlers} />
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
  };

  const menu = (
    <ContextMenuContent>
      <ContextMenuItem
        onClick={() => {
          const text = cellDisplayText(value);
          void navigator.clipboard.writeText(text);
        }}
      >
        Copy Cell
      </ContextMenuItem>
      {copyAsItems()}
      {isBytes && value.t === "bytes" && (
        <ContextMenuItem onClick={() => handlers.onViewBlob(value)}>
          View BLOB ({formatByteSize(value.v.length)})
        </ContextMenuItem>
      )}
      {quickFilterItems()}
      {goToItems()}
      {!readOnly && handlers.onPasteRows && (
        <ContextMenuItem className="text-xs" onClick={() => handlers.onPasteRows?.()}>
          {t("grid.pasteRows")}
        </ContextMenuItem>
      )}
      {!readOnly && !columnLocked && (
        <>
          {!meta.nullable ? (
            <ContextMenuItem disabled>Set NULL (column is NOT NULL)</ContextMenuItem>
          ) : (
            <>
              {kind === "real" ? (
                <>
                  <ContextMenuItem onClick={() => handlers.onSetCellNull(rowIndex, meta.name)}>
                    Set NULL
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => handlers.onSetCellEmptyString(rowIndex, meta.name)}
                  >
                    Set Empty String
                  </ContextMenuItem>
                </>
              ) : (
                <ContextMenuItem onClick={() => handlers.onSetInsertNull(rowId, meta.name)}>
                  Set NULL
                </ContextMenuItem>
              )}
            </>
          )}
          {kind === "real" && (
            <ContextMenuItem onClick={() => handlers.onToggleDeleteRow(rowIndex)}>
              {deleted ? "Unmark Deletion" : "Mark Row for Deletion"}
            </ContextMenuItem>
          )}
          {kind === "insert" && (
            <ContextMenuItem onClick={() => handlers.onRemoveInsertRow(rowId)}>
              Remove Inserted Row
            </ContextMenuItem>
          )}
        </>
      )}
    </ContextMenuContent>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          style={{ width: column.width }}
          onClick={selectThis}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (readOnly || columnLocked) return;
            // BLOBs open the viewer; text cells enter edit mode.
            if (isBytes && value && value.t === "bytes") {
              handlers.onViewBlob(value);
            } else {
              handlers.onStartEdit({ rowId, colIndex });
            }
          }}
          className={cn(
            "group/cell relative flex shrink-0 items-center overflow-hidden border-r px-2 text-xs",
            numeric && "justify-end font-mono tabular-nums",
            temporal && "font-mono",
            // changed-cell tint wins over row background
            edited !== undefined && "bg-warning/20",
            deleted && "text-destructive/85 line-through decoration-destructive/60",
            focused && "z-10 outline outline-1 -outline-offset-1 outline-primary",
            readOnly && "cursor-default",
          )}
        >
          <CellValue value={value} dataType={meta.dataType} />
          {showJumpGlyph && (
            <button
              type="button"
              aria-label={t("grid.fk.jumpGlyph", { table: cellFk!.refTable })}
              title={t("grid.fk.jumpGlyph", { table: cellFk!.refTable })}
              className={cn(
                "absolute inset-y-0 right-0 z-[5] flex w-5 items-center justify-center",
                "bg-background/90 text-muted-foreground hover:text-primary",
                "opacity-0 pointer-events-none group-hover/cell:opacity-100 group-hover/cell:pointer-events-auto",
              )}
              onClick={(e) => {
                e.stopPropagation();
                handlers.onGoToReferencedRow?.(cellFk!, { rowId, colIndex });
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <ArrowUpRight className="size-3.5" />
            </button>
          )}
          {editing && cellFk && handlers.onFkPick && handlers.onLoadFkValues && (
            <CellEditorWithFk
              initialValue={cellRawText(value)}
              nullable={meta.nullable}
              fk={cellFk}
              loadValues={handlers.onLoadFkValues}
              onPick={(refColumns, pickedRow) =>
                handlers.onFkPick?.(
                  { rowId, rowIndex, kind },
                  cellFk,
                  refColumns,
                  pickedRow,
                )
              }
              onCancel={handlers.onCancelEdit}
              freeTextCommit={(text) =>
                handlers.onCommitEdit({ rowId, colIndex }, text)
              }
            />
          )}
          {editing && !(cellFk && handlers.onFkPick && handlers.onLoadFkValues) && (
            <CellEditor
              initialValue={cellRawText(value)}
              onCommit={(text) =>
                handlers.onCommitEdit({ rowId, colIndex }, text)
              }
              onCancel={handlers.onCancelEdit}
            />
          )}
        </div>
      </ContextMenuTrigger>
      {menu}
    </ContextMenu>
  );
}

/**
 * Items of the "Rows referencing this row" sub-menu. Data arrives lazily —
 * the parent table's reverse-FK lookup is only fetched once the user hovers
 * into this branch (see `onRequestReferencingFks`).
 */
function ReferencingItems({
  rowData,
  columnNames,
  rowId,
  colIndex,
  handlers,
}: {
  rowData?: RowValue[];
  columnNames: string[];
  rowId: string;
  colIndex: number;
  handlers: CellHandlers;
}) {
  if (handlers.referencingFksLoading) {
    return (
      <ContextMenuItem disabled className="text-xs">
        {t("grid.fk.loadingRefs")}
      </ContextMenuItem>
    );
  }
  const refs = handlers.referencingFks;
  if (!refs || refs.length === 0) {
    return (
      <ContextMenuItem disabled className="text-xs">
        {t("grid.fk.noRefs")}
      </ContextMenuItem>
    );
  }
  return (
    <>
      {refs.map((fk) => {
        const jumpable =
          rowData !== undefined &&
          buildReverseJumpFilters(fk, rowData, columnNames) !== null;
        // "{table}.{column}"; composite FKs lead with the first column.
        const column =
          fk.columns.length > 1
            ? `${fk.columns[0]} +${fk.columns.length - 1}`
            : fk.columns[0];
        return (
          <ContextMenuItem
            key={`${fk.table ?? "?"}:${fk.name}`}
            className="text-xs"
            disabled={!jumpable}
            title={!jumpable ? t("grid.fk.nullCell") : fk.name}
            onClick={() =>
              handlers.onFindReferencingRows?.(fk, { rowId, colIndex })
            }
          >
            {t("grid.fk.referencingItem", {
              table: fk.table ?? "?",
              column,
            })}
          </ContextMenuItem>
        );
      })}
    </>
  );
}

/** Visual representation only — no logic, cheap to render. */
function CellValue({
  value,
  dataType,
}: {
  value: RowValue | undefined;
  dataType: string;
}) {
  if (!value || value.t === "null") {
    return <span className="italic text-muted-foreground/60">NULL</span>;
  }
  switch (value.t) {
    case "bytes":
      return (
        <span className="italic text-icon-blue">
          {formatByteSize(value.v.length)}{" "}
          <span className="not-italic text-muted-foreground/50">BLOB</span>
        </span>
      );
    default:
      // Truncation via CSS ellipsis; full text available through tooltip-less
      // title would cost layout — rely on the BLOB/text viewer later phases.
      return (
        <span
          className={cn(
            "truncate",
            /\bjson\b/i.test(dataType) && "font-mono text-icon-violet",
          )}
        >
          {cellDisplayText(value)}
        </span>
      );
  }
}

function CellEditor({
  initialValue,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  onCommit: (rawText: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="absolute inset-0 z-20 w-full bg-background px-2 font-mono text-xs outline outline-2 -outline-offset-1 outline-primary"
    />
  );
}

/**
 * Cell editor with an FK value dropdown (Phase 9-A): the plain input stays
 * for free-text entry; a chevron opens the top-N referenced rows. Picking
 * one routes through `onPick` so multi-column FKs fill every mapped column.
 */
function CellEditorWithFk({
  initialValue,
  nullable,
  fk,
  loadValues,
  onPick,
  freeTextCommit,
  onCancel,
}: {
  initialValue: string;
  nullable: boolean;
  fk: ForeignKeyMeta;
  loadValues: (fkName: string) => Promise<import("@/types/ipc").FkRefValues>;
  onPick: (refColumns: string[], pickedRow: RowValue[]) => void;
  freeTextCommit: (rawText: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  // Picking commits outside this editor; blur must not double-commit.
  const pickingRef = useRef(false);

  useEffect(() => {
    if (!open) {
      ref.current?.focus();
      ref.current?.select();
    }
    // A stale picking flag from a previous editor must never suppress the
    // blur-commit of a newly mounted one.
    return () => {
      pickingRef.current = false;
    };
  }, [open]);

  return (
    <div className="absolute inset-0 z-20 flex bg-background outline outline-2 -outline-offset-1 outline-primary">
      <input
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!pickingRef.current) freeTextCommit(draft);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            freeTextCommit(draft);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="h-full min-w-0 flex-1 px-2 font-mono text-xs outline-none"
      />
      <Popover open={open} onOpenChange={(next) => { pickingRef.current = next; setOpen(next); }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("grid.fk.pickValue")}
            title={`${t("grid.fk.pickValue")} — ${fk.name}`}
            className="flex h-full w-6 shrink-0 items-center justify-center border-l bg-muted/60 text-muted-foreground hover:bg-accent hover:text-foreground"
            onMouseDown={() => {
              pickingRef.current = true;
            }}
          >
            {open ? <Spinner className="size-3" /> : <ChevronDown className="size-3.5" />}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
          <FkValueList
            fk={fk}
            loadValues={loadValues}
            nullable={nullable}
            onPick={(refColumns, row) => {
              pickingRef.current = false;
              setOpen(false);
              onPick(refColumns, row);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Lazy list of referenced values for one FK (top-N, ordered by key). */
function FkValueList({
  fk,
  loadValues,
  nullable,
  onPick,
}: {
  fk: ForeignKeyMeta;
  loadValues: (fkName: string) => Promise<import("@/types/ipc").FkRefValues>;
  nullable: boolean;
  onPick: (refColumns: string[], pickedRow: RowValue[]) => void;
}) {
  const values = useQuery({
    queryKey: ["fk-ref-values", fk.name],
    queryFn: () => loadValues(fk.name),
  });

  if (values.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 p-3 text-xs text-muted-foreground">
        <Spinner className="size-3" /> …
      </div>
    );
  }
  if (values.isError || !values.data) {
    return (
      <p className="max-w-64 truncate p-3 text-xs text-destructive">
        {values.error instanceof Error ? values.error.message : "error"}
      </p>
    );
  }

  const { columns, rows } = values.data;
  return (
    <div className="max-h-64 overflow-auto">
      <div className="sticky top-0 z-10 border-b bg-muted/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("grid.fk.pickValue")}
      </div>
      {nullable && (
        <button
          type="button"
          className="flex w-full items-center gap-2 border-b px-2 py-1.5 text-left text-xs italic text-muted-foreground hover:bg-accent/60"
          onClick={() => onPick(columns, columns.map(() => ({ t: "null" }) as RowValue))}
        >
          {t("grid.fk.setNull")}
        </button>
      )}
      {rows.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">{t("grid.fk.empty")}</p>
      ) : (
        rows.map((row, i) => (
          <button
            key={i}
            type="button"
            className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs font-mono hover:bg-accent/60"
            onClick={() => onPick(columns, row)}
          >
            <span className="truncate">
              {row.map((v) => cellDisplayText(v)).join(" · ")}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
