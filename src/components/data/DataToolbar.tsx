import { useMutation } from "@tanstack/react-query";
import {
  Download,
  FileUp,
  Plus,
  RedoDot,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { applyDataChanges } from "@/lib/db-queries";
import { notify } from "@/lib/toast";
import { log } from "@/stores/log";
import {
  buildPostPlan,
  changesetCount,
  getChangeset,
  useChangesetStore,
} from "@/stores/changesets";
import type {
  ApplyChangesResult,
  ColumnMeta,
  FilterSpec,
  RowValue,
  SortSpec,
} from "@/types/ipc";

const PAGE_SIZES = [500, 1000, 5000] as const;

export interface DataToolbarProps {
  tabId: string;
  connId: number;
  db: string;
  table: string;
  columns: ColumnMeta[];
  rows: RowValue[][];
  pkColumns: string[] | null;
  pageSize: number;
  hasMore: boolean;
  isFetching: boolean;
  selectionCount: number;
  filter: FilterSpec | null;
  orderBy: SortSpec[];
  onPageSizeChange: (size: number) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onAddRow: () => void;
  onDeleteSelected: () => void;
  onClearFilter: () => void;
  /** Reload from offset 0 (drops accumulated pages) — used after posting. */
  onHardReload: () => void;
  /** Open the export dialog for this grid. */
  onExportGrid: () => void;
  /** Open the CSV import wizard preselecting this table. */
  onImportTable: () => void;
}

export function DataToolbar(props: DataToolbarProps) {
  const changeset = useChangesetStore((s) => s.byTab[props.tabId]);
  const clearChangeset = useChangesetStore((s) => s.clear);
  const pending = changesetCount(changeset);

  const post = useMutation({
    mutationFn: () => {
      const cs = getChangeset(props.tabId);
      const plan = buildPostPlan(cs, {
        columns: props.columns,
        rows: props.rows,
        pkColumns: props.pkColumns,
      });
      if (plan.changes.length === 0) throw new Error("nothing to post");
      return applyDataChanges(props.connId, {
        db: props.db,
        table: props.table,
        changes: plan.changes,
      }).then((result: ApplyChangesResult) => ({ result, plan }));
    },
    onSuccess: ({ result, plan }) => {
      const { applied, failed, errors, elapsedMs } = result;
      for (const err of errors) {
        const origin = plan.origins[err.index];
        const where =
          origin?.type === "update"
            ? `row ${origin.rowIndex + 1} (${origin.columns.join(", ")})`
            : origin?.type === "delete"
              ? `row ${origin.rowIndex + 1}`
              : "inserted row";
        log("error", `${props.table}: ${where} — ${err.message}`);
      }
      if (failed > 0) {
        notify.warning(`${props.table}: posted with errors — ${applied} applied, ${failed} failed. Failed edits kept.`);
        log(
          "warn",
          `${props.table}: posted with errors — ${applied} applied, ${failed} failed (${elapsedMs}ms). Failed edits kept.`,
        );
      } else {
        notify.success("toast.changes.posted", { count: applied, table: props.table });
        log("success", `${props.table}: ${applied} change(s) applied in ${elapsedMs}ms.`);
      }
      // Prune exactly the succeeded entries so failures stay editable.
      if (failed > 0 && applied + failed === plan.changes.length) {
        pruneSucceeded(props.tabId, plan, new Set(errors.map((e) => e.index)));
      }
      if (failed === 0 || applied + failed !== plan.changes.length) {
        if (failed === 0) clearChangeset(props.tabId);
      }
      // Offsets may have shifted (deletes/inserts): reload page 0.
      props.onHardReload();
    },
    onError: (err) => {
      notify.error(`Post failed: ${err instanceof Error ? err.message : String(err)}`);
    },
  });

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b bg-muted/40 px-2">
      <ToolButton tooltip="Refresh (reload current view)" onClick={props.onRefresh}>
        {props.isFetching ? <Spinner /> : <RefreshCw />}
      </ToolButton>

      <Separator orientation="vertical" className="mx-1 h-5!" />

      <ToolButton tooltip="Insert new row" onClick={props.onAddRow}>
        <Plus />
      </ToolButton>
      <ToolButton
        tooltip={`Delete selected row(s)${props.selectionCount > 0 ? ` (${props.selectionCount})` : ""}`}
        disabled={props.selectionCount === 0}
        onClick={props.onDeleteSelected}
      >
        <Trash2 />
      </ToolButton>

      <ToolButton tooltip="Export grid…" onClick={props.onExportGrid}>
        <Download />
      </ToolButton>
      <ToolButton tooltip="Import into table…" onClick={props.onImportTable}>
        <FileUp />
      </ToolButton>

      <Separator orientation="vertical" className="mx-1 h-5!" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            disabled={pending === 0 || post.isPending}
            onClick={() => post.mutate()}
          >
            <Undo2 data-icon="inline-start" />
            Discard
          </Button>
        </TooltipTrigger>
        <TooltipContent>Discard all pending changes</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="xs"
            disabled={pending === 0 || post.isPending}
            onClick={() => post.mutate()}
          >
            {post.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RedoDot data-icon="inline-start" />
            )}
            Post changes
            {pending > 0 && (
              <Badge variant="secondary" className="ml-0.5 h-4 px-1 font-mono text-[10px]">
                {pending}
              </Badge>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Write pending changes to the database</TooltipContent>
      </Tooltip>

      <div className="ml-auto flex items-center gap-1">
        {props.filter && <FilterChip filter={props.filter} onClear={props.onClearFilter} />}
        <Select
          value={String(props.pageSize)}
          onValueChange={(v) => props.onPageSizeChange(Number(v))}
        >
          <SelectTrigger size="sm" className="h-7 w-[88px] text-xs" aria-label="Page size">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} rows
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="xs"
          disabled={!props.hasMore || props.isFetching}
          onClick={props.onLoadMore}
        >
          Load more
        </Button>
      </div>
    </div>
  );
}

/**
 * Remove only the changeset entries whose posted change succeeded, keeping
 * failed ones editable. `failed` holds the indexes of failing changes.
 */
function pruneSucceeded(
  tabId: string,
  plan: ReturnType<typeof buildPostPlan>,
  failed: Set<number>,
) {
  const store = useChangesetStore.getState();
  const columns = plan.columnNames;

  for (let i = 0; i < plan.origins.length; i++) {
    if (failed.has(i)) continue;
    const origin = plan.origins[i];
    switch (origin.type) {
      case "delete":
        store.toggleDeleteRow(tabId, origin.rowIndex); // currently marked → unmark
        break;
      case "insert":
        store.removeInsertRow(tabId, origin.rowId);
        break;
      case "update":
        for (const column of origin.columns) {
          const colIndex = columns.indexOf(column);
          if (colIndex >= 0) store.removeUpdate(tabId, origin.rowIndex, colIndex);
        }
        break;
    }
  }
}

function FilterChip({ filter, onClear }: { filter: FilterSpec; onClear: () => void }) {
  const label =
    filter.op === "in"
      ? `${filter.column} IN (${filter.values?.length ?? 0} values)`
      : `${filter.column} ${filter.op}${filter.value != null ? ` '${filter.value}'` : ""}`;
  return (
    <button
      type="button"
      title="Clear filter"
      onClick={onClear}
      className="mr-1 flex max-w-64 items-center gap-1 rounded-sm bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning hover:bg-warning/25"
    >
      <span className="truncate font-mono">{label}</span>
      ×
    </button>
  );
}

function ToolButton({
  tooltip,
  disabled,
  onClick,
  children,
}: {
  tooltip: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
