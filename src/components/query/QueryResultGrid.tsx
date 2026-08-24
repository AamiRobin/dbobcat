import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { RedoDot, Undo2 } from "lucide-react";

import { BlobViewerDialog } from "@/components/data/BlobViewerDialog";
import { DataGrid, type FocusedCell } from "@/components/data/DataGrid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  applyDataChanges,
  fetchColumns,
  primaryKeyColumns,
} from "@/lib/db-queries";
import {
  cellDisplayText,
  cellRawText,
  estimateColumnWidth,
  isNumericType,
  parseCellValue,
  type GridColumn,
} from "@/lib/grid-columns";
import { detectQueryTable } from "@/lib/query-table-detect";
import { formatElapsed } from "@/lib/query-queries";
import { t } from "@/lib/i18n";
import { log } from "@/stores/log";
import { notify } from "@/lib/toast";
import {
  buildPostPlan,
  changesetCount,
  getChangeset,
  queryChangesetKey,
  useChangesetStore,
} from "@/stores/changesets";
import { cn } from "@/lib/utils";
import type { ApplyChangesResult, ColumnMeta, QueryOutcome, RowValue } from "@/types/ipc";

type ResultSetOutcome = Extract<QueryOutcome, { kind: "result_set" }>;

/**
 * Rendering of one query result set. Reuses the Phase-2 DataGrid; read-only
 * by default. When the source statement provably reads exactly one table
 * AND its primary key is part of the result columns, the grid becomes
 * editable and posts through the normal changeset machinery against that
 * table (Phase 9-A).
 */
export function QueryResultGrid({
  tabId,
  resultIndex,
  result,
  connId,
  dbContext,
}: {
  tabId: string;
  /** Position of this result set within the run — keys the changeset. */
  resultIndex: number;
  result: ResultSetOutcome;
  connId: number | null;
  /** Session/completion database used for unqualified table names. */
  dbContext: string | null;
}) {
  const [widthOverrides, setWidthOverrides] = useState<Record<string, number>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(null);
  const [editingCell, setEditingCell] = useState<FocusedCell | null>(null);
  const [blobValue, setBlobValue] = useState<Extract<RowValue, { t: "bytes" }> | null>(null);

  // -- updatable-results detection ------------------------------------------
  const detected = useMemo(
    () => (result.sql ? detectQueryTable(result.sql) : null),
    [result.sql],
  );
  const effectiveDb = detected?.db ?? dbContext ?? null;

  const described = useQuery({
    queryKey: ["query-result-table-columns", connId, effectiveDb, detected?.table],
    queryFn: () => fetchColumns(connId!, effectiveDb!, detected!.table),
    enabled: connId !== null && effectiveDb !== null && !!detected,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const columnsMeta: ColumnMeta[] = useMemo(
    () =>
      result.columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        nullable: true,
      })),
    [result.columns],
  );

  const columns: GridColumn[] = useMemo(
    () =>
      columnsMeta.map((m) => ({
        meta: m,
        width: widthOverrides[m.name] ?? estimateColumnWidth(m),
      })),
    [columnsMeta, widthOverrides],
  );

  const resultNames = new Set(result.columns.map((c) => c.name));
  const pkCols = useMemo(
    () => (described.data ? primaryKeyColumns(described.data) : []),
    [described.data],
  );
  const pkInResult = useMemo(
    () => pkCols.filter((c) => resultNames.has(c.name)).map((c) => c.name),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pkCols],
  );

  const editable =
    detected !== null &&
    described.isSuccess &&
    pkCols.length > 0 &&
    pkCols.every((c) => resultNames.has(c.name));

  /**
   * Columns whose values map to real table columns are editable; expression
   * / aliased-unknown columns stay read-only.
   */
  const editableColumns = useMemo(() => {
    if (!editable || !described.data) return null;
    return new Set(described.data.map((c) => c.name).filter((n) => resultNames.has(n)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, described.data]);

  const changesetKey = queryChangesetKey(tabId, resultIndex);
  const changeset = useChangesetStore((s) => s.byTab[changesetKey]);
  const pending = changesetCount(changeset);

  // -- editing handlers -----------------------------------------------------
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

  /** Ctrl+C — selected rows as TSV. */
  const onCopy = useCallback(() => {
    if (selectedIds.size === 0) return;
    const order = [...selectedIds].sort(
      (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
    );
    const lines = order.map((id) => {
      const row = result.rows[Number(id.slice(1))];
      return row ? row.map(cellDisplayText).join("\t") : "";
    });
    void navigator.clipboard.writeText(lines.join("\n"));
    notify.success(`Copied ${order.length} row(s) to clipboard.`);
  }, [selectedIds, result.rows]);

  const onCommitEdit = useCallback(
    (cell: FocusedCell, rawText: string) => {
      setEditingCell(null);
      const col = columns[cell.colIndex];
      if (!col) return;
      const value = parseCellValue(rawText, isNumericType(col.meta.dataType));
      if (cell.rowId.startsWith("n")) {
        useChangesetStore.getState().setInsertValue(changesetKey, cell.rowId, col.meta.name, value);
        return;
      }
      const rowIndex = Number(cell.rowId.slice(1));
      const original = result.rows[rowIndex]?.[cell.colIndex];
      if (original && sameScalar(original, value)) {
        useChangesetStore.getState().removeUpdate(changesetKey, rowIndex, cell.colIndex);
      } else {
        useChangesetStore.getState().setUpdate(changesetKey, rowIndex, cell.colIndex, value);
      }
    },
    [columns, changesetKey, result.rows],
  );

  // -- posting --------------------------------------------------------------
  const post = useMutation({
    mutationFn: () => {
      if (!detected || !effectiveDb) throw new Error("no backing table");
      const cs = getChangeset(changesetKey);
      const plan = buildPostPlan(cs, {
        columns: columnsMeta,
        rows: result.rows,
        pkColumns: pkInResult.length > 0 ? pkInResult : null,
      });
      if (plan.changes.length === 0) throw new Error("nothing to post");
      return applyDataChanges(connId ?? -1, {
        db: effectiveDb,
        table: detected.table,
        changes: plan.changes,
      }).then((r: ApplyChangesResult) => ({ r, plan }));
    },
    onSuccess: ({ r, plan }) => {
      for (const err of r.errors) {
        log(
          "error",
          `${effectiveDb ?? "?"}.${detected?.table ?? "?"}: row edit failed — ${err.message}`,
        );
        void plan.origins[err.index];
      }
      if (r.failed > 0) {
        notify.warning(`${r.applied} applied, ${r.failed} failed — failed edits kept.`);
      } else {
        useChangesetStore.getState().clear(changesetKey);
        notify.success(
          t("query.editable.posted", {
            count: r.applied,
            db: effectiveDb ?? "?",
            table: detected?.table ?? "?",
          }),
        );
      }
    },
    onError: (err) => {
      notify.error(`Post failed: ${err instanceof Error ? err.message : String(err)}`);
    },
  });

  const tooltip = !detected
    ? t("query.editable.noTable")
    : pkCols.length === 0 || pkCols.some((c) => !resultNames.has(c.name))
      ? t("query.editable.noPk")
      : `${effectiveDb}.${detected.table}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DataGrid
        tabId={changesetKey}
        columns={columns}
        rows={result.rows}
        inserts={changeset?.inserts ?? []}
        selectedIds={selectedIds}
        focusedCell={focusedCell}
        editingCell={editingCell}
        sortColumn={null}
        sortDirection={null}
        activeFilter={null}
        isLoading={false}
        readOnly={!editable}
        hideFilterRow
        emptyLabel={
          result.columns.length === 0 ? "Empty result set" : "No rows returned"
        }
        onSelectRow={onSelectRow}
        onSelectAll={() => {
          const next = new Set<string>();
          for (let i = 0; i < result.rows.length; i++) next.add(`r${i}`);
          setSelectedIds(next);
        }}
        onClearSelection={() => setSelectedIds(new Set())}
        onSetFocusedCell={setFocusedCell}
        onStartEdit={(cell) => {
          setFocusedCell(cell);
          setEditingCell(cell);
        }}
        onCommitEdit={onCommitEdit}
        onCancelEdit={() => setEditingCell(null)}
        onDeleteSelected={() => {}}
        onToggleDeleteRow={(rowIndex) =>
          useChangesetStore.getState().toggleDeleteRow(changesetKey, rowIndex)
        }
        onRemoveInsertRow={(rowId) =>
          useChangesetStore.getState().removeInsertRow(changesetKey, rowId)
        }
        onSetInsertNull={(rowId, colName) =>
          useChangesetStore.getState().setInsertValue(changesetKey, rowId, colName, { t: "null" })
        }
        onSetCellNull={(rowIndex, colName) => {
          const colIndex = columnsMeta.findIndex((c) => c.name === colName);
          if (colIndex >= 0) {
            useChangesetStore.getState().setUpdate(changesetKey, rowIndex, colIndex, { t: "null" });
          }
        }}
        onSetCellEmptyString={(rowIndex, colName) => {
          const colIndex = columnsMeta.findIndex((c) => c.name === colName);
          if (colIndex >= 0) {
            useChangesetStore.getState().setUpdate(changesetKey, rowIndex, colIndex, {
              t: "str",
              v: "",
            });
          }
        }}
        onCopy={onCopy}
        onSortClick={() => {}}
        onFilterApply={() => {}}
        onFilterClearColumn={() => {}}
        editableColumns={editableColumns}
        onColumnResize={(name, width) =>
          setWidthOverrides((prev) => ({ ...prev, [name]: width }))
        }
        onColumnResizeCommit={(name, width) =>
          setWidthOverrides((prev) => ({ ...prev, [name]: width }))
        }
        onViewBlob={setBlobValue}
      />

      <div
        className={cn(
          "flex h-6 shrink-0 items-center gap-2 border-t bg-muted/40 px-2",
          "text-[11px] text-muted-foreground tabular-nums",
        )}
      >
        <span>{result.rows.length.toLocaleString()} rows</span>
        <span>·</span>
        <span>{formatElapsed(result.elapsedMs)}</span>
        {result.truncated && (
          <>
            <span>·</span>
            <span className="text-warning">
              truncated by the backend row cap — narrow the query for full data
            </span>
          </>
        )}

        {editable && (
          <div className="ml-auto flex items-center gap-1" title={tooltip}>
            <Button
              variant="ghost"
              size="xs"
              className="h-5 px-1.5 text-[11px]"
              disabled={pending === 0 || post.isPending}
              onClick={() => {
                useChangesetStore.getState().clear(changesetKey);
              }}
            >
              <Undo2 data-icon="inline-start" />
              {t("query.editable.discard")}
            </Button>
            <Button
              size="xs"
              className="h-5 px-1.5 text-[11px]"
              disabled={pending === 0 || post.isPending}
              onClick={() => post.mutate()}
            >
              {post.isPending ? (
                <Spinner className="size-3" data-icon="inline-start" />
              ) : (
                <RedoDot data-icon="inline-start" />
              )}
              {t("query.editable.postChanges")}
              {pending > 0 && (
                <Badge variant="secondary" className="ml-0.5 h-4 px-1 font-mono text-[10px]">
                  {pending}
                </Badge>
              )}
            </Button>
          </div>
        )}
      </div>

      <BlobViewerDialog value={blobValue} onClose={() => setBlobValue(null)} />
    </div>
  );
}

/** Structural equality between two scalar RowValues (for edit-revert). */
function sameScalar(a: RowValue, b: RowValue): boolean {
  if (a.t !== b.t) return false;
  if (a.t === "null" && b.t === "null") return true;
  return cellRawText(a) === cellRawText(b);
}
