import { useMutation } from "@tanstack/react-query";
import {
  Columns3,
  CornerDownLeft,
  Download,
  FileUp,
  Plus,
  RedoDot,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { applyDataChanges } from "@/lib/db-queries";
import { prettyFilterLabel } from "@/lib/fk-navigation";
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
  /** Active AND-combined WHERE terms (one chip per term). */
  filters: FilterSpec[];
  orderBy: SortSpec[];
  onPageSizeChange: (size: number) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onAddRow: () => void;
  onDeleteSelected: () => void;
  onClearFilter: () => void;
  /** Remove a single term (chip ✕). */
  onClearFilterTerm: (index: number) => void;
  /** Reload from offset 0 (drops accumulated pages) — used after posting. */
  onHardReload: () => void;
  /** Open the export dialog for this grid. */
  onExportGrid: () => void;
  /** Open the CSV import wizard preselecting this table. */
  onImportTable: () => void;
  /** Column names hidden from the grid (persisted per table). */
  hiddenColumns: ReadonlySet<string>;
  /** Show (true) or hide (false) one column of the grid. */
  onToggleColumnVisibility: (name: string, visible: boolean) => void;
  /** Undo the most recent pending change. */
  onUndo: () => void;
}

export function DataToolbar(props: DataToolbarProps) {
  const changeset = useChangesetStore((s) => s.byTab[props.tabId]);
  const clearChangeset = useChangesetStore((s) => s.clear);
  // Primitive subscription — re-renders only when undo availability flips.
  const canUndo = useChangesetStore((s) => (s.history[props.tabId]?.length ?? 0) > 0);
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
      <ColumnsMenu
        columns={props.columns}
        hidden={props.hiddenColumns}
        onToggle={props.onToggleColumnVisibility}
      />

      <Separator orientation="vertical" className="mx-1 h-5!" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            disabled={!canUndo}
            onClick={props.onUndo}
          >
            <CornerDownLeft data-icon="inline-start" />
            Undo
          </Button>
        </TooltipTrigger>
        <TooltipContent>Undo last pending change (Ctrl+Z)</TooltipContent>
      </Tooltip>

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
              // key re-mounts the badge on every count change → the pop replays.
              <Badge
                key={pending}
                variant="secondary"
                className="ml-0.5 h-4 animate-badge-pop px-1 font-mono text-[10px]"
              >
                {pending}
              </Badge>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Write pending changes to the database</TooltipContent>
      </Tooltip>

      <div className="ml-auto flex items-center gap-1">
        {props.filters.map((filter, index) => (
          <FilterChip
            key={`${filter.column}:${index}`}
            filter={filter}
            onClear={() => props.onClearFilterTerm(index)}
          />
        ))}
        <Select
          value={String(props.pageSize)}
          onValueChange={(v) => props.onPageSizeChange(Number(v))}
        >
          <SelectTrigger size="sm" className="h-7 w-[100px] text-xs" aria-label="Page size">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {PAGE_SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} rows
                </SelectItem>
              ))}

            </SelectGroup>
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
  const label = prettyFilterLabel(filter);
  return (
    <button
      type="button"
      title="Clear filter"
      onClick={onClear}
      className="mr-1 flex max-w-64 items-center gap-1 rounded-sm bg-warning/15 px-1.5 py-0.5 text-xs text-warning hover:bg-warning/25"
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
        {/* Icon-only: the tooltip is visual only, so the accessible name
            comes from the same literal string. */}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={tooltip}
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

/**
 * Show/hide grid columns. Hiding is display-only: pending edits keep their
 * meaning and hidden columns stay in copies/exports made through the export
 * dialog (row copy respects visibility).
 */
function ColumnsMenu({
  columns,
  hidden,
  onToggle,
}: {
  columns: ColumnMeta[];
  hidden: ReadonlySet<string>;
  onToggle: (name: string, visible: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const hiddenCount = columns.filter((c) => hidden.has(c.name)).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Tooltip wraps the popover trigger: tooltip triggers merge props down
          the asChild chain, popover triggers must sit below it. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Show / hide columns"
              className={
                hiddenCount > 0
                  ? "relative text-foreground"
                  : "text-muted-foreground"
              }
            >
              <Columns3 />
              {hiddenCount > 0 && (
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary"
                />
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Show / hide columns</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-60 p-1.5">
        <p className="px-1.5 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">
          Visible columns
        </p>
        <div className="max-h-72 overflow-y-auto">
          {columns.map((col) => (
            <div
              key={col.name}
              role="checkbox"
              aria-checked={!hidden.has(col.name)}
              tabIndex={0}
              onClick={() => onToggle(col.name, hidden.has(col.name))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle(col.name, hidden.has(col.name));
                }
              }}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent"
            >
              {/* Visual only — the row handles clicks so they never double-fire. */}
              <Checkbox
                checked={!hidden.has(col.name)}
                tabIndex={-1}
                className="pointer-events-none"
              />
              <span className="truncate font-mono" title={col.name}>
                {col.name}
              </span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
