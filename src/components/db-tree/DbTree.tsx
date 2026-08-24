import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Braces,
  ChevronRight,
  Clock,
  Copy,
  Database,
  Download,
  Eye,
  FileUp,
  Hash,
  Key,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sigma,
  Star,
  Stethoscope,
  Table,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { createContext, useContext, useMemo, useState } from "react";

import { openExportDialog } from "@/stores/export-dialog";
import { openImportWizard } from "@/stores/import-dialog";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { TreeDialogs } from "@/components/db-tree/dialogs";
import { useTreeDialogsStore } from "@/components/db-tree/tree-dialogs-store";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/toast";
import { t } from "@/lib/i18n";
import {
  TREE_STALE_TIME,
  dbKeys,
  fetchColumns,
  fetchDatabases,
  fetchTables,
  isPrimaryKeyColumn,
} from "@/lib/db-queries";
import { useTreeFavorites, parseFavoriteKey } from "@/lib/tree-favorites";
import {
  OBJECT_STALE_TIME,
  dropObjects,
  fetchEvents,
  fetchRoutines,
  fetchTriggers,
  objKeys,
  truncateTables,
} from "@/lib/object-queries";
import { compileTreeFilter, type TreeMatcher } from "@/lib/tree-filter";
import { useConnectionStore } from "@/stores/connection";
import {
  openDataTable,
  openDesignerTab,
  openObjectEditorTab,
} from "@/stores/tabs";
import type {
  ColumnMeta,
  RoutineKind,
  RoutineMeta,
  SqlDialect,
  TableKind,
  TableMeta,
  TriggerMeta,
  EventMeta,
} from "@/types/ipc";

/**
 * Left-hand database object tree. Lazily loads databases → tables → columns
 * per connection; Phase 4 adds routines/triggers/events groups plus the
 * designer/bulk/maintenance context menus. Everything is cached per connId
 * and refreshed explicitly.
 *
 * Phase 9-B: a regex-or-substring filter box (auto-expands matched
 * databases and loads their object lists to filter — column children stay
 * hidden while filtering), per-session favorites with a favorites-only
 * mode, and a subtle session-color accent. F5/Ctrl+R refresh only
 * invalidates queries; expansion, scroll position, filter text and
 * favorites-only state live in component state keyed by stable node keys,
 * so they all survive refreshes.
 */

// ---------------------------------------------------------------------------
// Filter / favorites context
// ---------------------------------------------------------------------------

interface TreeFilterState {
  /** Compiled filter, or null when the pattern is empty. */
  matcher: TreeMatcher | null;
  favoritesOnly: boolean;
  /** All favorite keys ("db.table") of the current session. */
  favorites: Set<string>;
  toggleFavorite: (db: string, table: string) => void;
}

const TreeFilterContext = createContext<TreeFilterState>({
  matcher: null,
  favoritesOnly: false,
  favorites: new Set(),
  toggleFavorite: () => {},
});

function useTreeFilter(): TreeFilterState {
  return useContext(TreeFilterContext);
}

/** True when `name` passes the active pattern filter. */
function keeps(matcher: TreeMatcher | null, name: string): boolean {
  return matcher === null || matcher.matches(name);
}

/** True when any `{name}` item of a scan result passes the filter. */
function scanMatches<T extends { name: string }>(
  data: T[] | undefined,
  matcher: TreeMatcher,
): boolean {
  return (data ?? []).some((item) => matcher.matches(item.name));
}

/** True while any filter dimension is active. */
function useFiltering(): boolean {
  const { matcher, favoritesOnly } = useTreeFilter();
  return matcher !== null || favoritesOnly;
}

// ---------------------------------------------------------------------------
// Shared row visuals
// ---------------------------------------------------------------------------

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground transition-transform",
        open && "rotate-90",
      )}
    />
  );
}

interface RowProps {
  open?: boolean;
  onToggle?: () => void;
  onDoubleClick?: () => void;
  children: React.ReactNode;
  menu: React.ReactNode;
  className?: string;
}

/** A tree row with chevron + right-click context menu. */
function TreeRow({ open = false, onToggle, onDoubleClick, children, menu, className }: RowProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          onDoubleClick={onDoubleClick}
          className={cn(
            "flex w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-xs hover:bg-accent/60",
            className,
          )}
        >
          <Chevron open={open} />
          {children}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>{menu}</ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Right-aligned star toggle used by table/view rows. Clicks must not reach
 * the row's own toggle handler.
 */
function FavoriteStar({ db, table }: { db: string; table: string }) {
  const { favorites, toggleFavorite } = useTreeFilter();
  const active = favorites.has(`${db}.${table}`);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={t(active ? "tree.favorite.remove" : "tree.favorite.add")}
      title={t(active ? "tree.favorite.remove" : "tree.favorite.add")}
      onClick={(e) => {
        e.stopPropagation();
        toggleFavorite(db, table);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
          toggleFavorite(db, table);
        }
      }}
      className="ml-auto mr-0.5 shrink-0 rounded p-0.5 hover:bg-accent"
    >
      <Star
        className={cn(
          "size-3",
          active ? "fill-warning text-warning" : "text-muted-foreground/40",
        )}
      />
    </span>
  );
}

function ToggleFavoriteItem({ db, table }: { db: string; table: string }) {
  const { favorites, toggleFavorite } = useTreeFilter();
  const active = favorites.has(`${db}.${table}`);
  return (
    <ContextMenuItem onClick={() => toggleFavorite(db, table)}>
      <Star className={cn(active && "fill-warning text-warning")} />
      {t(active ? "tree.favorite.remove" : "tree.favorite.add")}
    </ContextMenuItem>
  );
}

function CopyNameItem({ name }: { name: string }) {
  return (
    <ContextMenuItem
      onClick={() => {
        void navigator.clipboard.writeText(name);
        notify.success("toast.copied", { name });
      }}
    >
      <Copy />
      Copy Name
    </ContextMenuItem>
  );
}

function RefreshItem({ onClick }: { onClick: () => void }) {
  return (
    <ContextMenuItem onClick={onClick}>
      <RefreshCw />
      Refresh
    </ContextMenuItem>
  );
}

// ---------------------------------------------------------------------------
// Table node (columns loaded lazily)
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<TableKind, string> = {
  table: "Tables",
  view: "Views",
  system_table: "System Tables",
  materialized_view: "Materialized Views",
  sequence: "Sequences",
};

function TableNode({ connId, database, table }: { connId: number; database: string; table: TableMeta }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<"drop" | "truncate" | null>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const dialogs = useTreeDialogsStore();
  const filtering = useFiltering();

  const runConfirmed = async () => {
    if (!confirming) return;
    setBusy(true);
    try {
      if (confirming === "drop") {
        await dropObjects(connId, [{ db: database, kind: "table", name: table.name }]);
        notify.success(`Table \`${table.name}\` dropped.`);
      } else {
        await truncateTables(connId, database, [table.name]);
        notify.success(`Table \`${table.name}\` truncated.`);
      }
      void queryClient.invalidateQueries({ queryKey: dbKeys.tables(connId, database) });
    } catch (err) {
      notify.error(`${confirming === "drop" ? "Drop" : "Truncate"} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const columns = useQuery({
    queryKey: dbKeys.columns(connId, database, table.name),
    queryFn: () => fetchColumns(connId, database, table.name),
    // Column children stay hidden (and unloaded) while a filter is active.
    enabled: open && !filtering,
    staleTime: TREE_STALE_TIME,
  });

  function refresh() {
    void queryClient.refetchQueries({
      queryKey: dbKeys.columns(connId, database, table.name),
    });
  }

  const openData = () => openDataTable(connId, database, table.name);
  const designTable = () => openDesignerTab(connId, database, table.name);
  if (table.kind === "view") {
    return <ViewNode connId={connId} database={database} name={table.name} />;
  }

  return (
    <li>
      <TreeRow
        open={open}
        onToggle={() => setOpen(!open)}
        onDoubleClick={designTable}
        menu={
          <>
            <ContextMenuItem onClick={openData}>
              <Table />
              Open Data
            </ContextMenuItem>
            <ContextMenuItem onClick={designTable}>
              <Pencil />
              Design Table
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() =>
                dialogs.openCopyTable({ db: database, table: table.name })
              }
            >
              <Copy />
              {t("tree.copyTable")}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() =>
                openExportDialog({
                  kind: "grid",
                  connId,
                  db: database,
                  table: table.name,
                })
              }
            >
              <Download />
              Export Table…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ToggleFavoriteItem db={database} table={table.name} />
            <MaintenanceSubmenu
              onPick={(op) => dialogs.openMaintenance({ db: database, tables: [table.name], op })}
            />
            <ContextMenuItem onClick={() => dialogs.openPrompt({ kind: "rename", db: database, table: table.name })}>
              <Pencil />
              Rename…
            </ContextMenuItem>
            <ContextMenuItem onClick={() => dialogs.openPrompt({ kind: "clone", db: database, table: table.name })}>
              <Copy />
              Duplicate Table…
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setConfirming("truncate")}>
              <Trash2 />
              Truncate…
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setConfirming("drop")}>
              <Trash2 />
              Drop Table…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <CopyNameItem name={table.name} />
            <RefreshItem onClick={refresh} />
          </>
        }
      >
        <Table className="size-3.5 shrink-0 text-warning" />
        <span className="truncate">{table.name}</span>
        <FavoriteStar db={database} table={table.name} />
      </TreeRow>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={confirming === "drop" ? "Drop table?" : "Truncate table?"}
        description={
          confirming === "drop" ? (
            <>
              Table <span className="font-mono">{table.name}</span> (structure and data) will be
              dropped permanently.
            </>
          ) : (
            <>
              All rows of <span className="font-mono">{table.name}</span> will be removed. The
              structure stays.
            </>
          )
        }
        destructive={confirming === "drop"}
        busy={busy}
        confirmLabel={confirming === "drop" ? "Drop" : "Truncate"}
        onConfirm={() => void runConfirmed()}
      />

      {open && (
        <ul className="ml-4 border-l pl-2">
          {columns.isPending && (
            <li className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground">
              <Spinner className="size-3" /> Loading columns…
            </li>
          )}
          {columns.isError && (
            <li className="py-0.5 text-[11px] text-destructive">
              {(columns.error as Error).message}
            </li>
          )}
          {(columns.data ?? []).map((column: ColumnMeta) => (
            <li key={column.name}>
              <div className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground">
                {isPrimaryKeyColumn(column) ? (
                  <Key className="size-3 shrink-0 text-warning" />
                ) : (
                  <Hash className="ml-3 mr-1 size-3 shrink-0 opacity-40" />
                )}
                <span className="truncate">{column.name}</span>
                <span className="ml-auto shrink-0 rounded bg-secondary px-1 font-mono text-[10px] text-secondary-foreground/80">
                  {column.dataType}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// View node
// ---------------------------------------------------------------------------

function ViewNode({ connId, database, name }: { connId: number; database: string; name: string }) {
  const queryClient = useQueryClient();

  const openEditor = () =>
    openObjectEditorTab({ connId, db: database, kind: "view", name });

  const dropView = async () => {
    try {
      await dropObjects(connId, [{ db: database, kind: "view", name }]);
      notify.success(`View \`${name}\` dropped.`);
      void queryClient.invalidateQueries({ queryKey: dbKeys.tables(connId, database) });
    } catch (err) {
      notify.error(`Drop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <li>
      <TreeRow
        onToggle={() => {}}
        onDoubleClick={openEditor}
        menu={
          <>
            <ContextMenuItem onClick={openEditor}>
              <Eye />
              Open Editor
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void dropView()}>
              <Trash2 />
              Drop View
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ToggleFavoriteItem db={database} table={name} />
            <CopyNameItem name={name} />
            <RefreshItem
              onClick={() =>
                void queryClient.invalidateQueries({
                  queryKey: dbKeys.tables(connId, database),
                })
              }
            />
          </>
        }
      >
        <Eye className="size-3.5 shrink-0 text-icon-blue" />
        <span className="truncate">{name}</span>
        <FavoriteStar db={database} table={name} />
      </TreeRow>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Maintenance submenu (shared by tables and groups)
// ---------------------------------------------------------------------------

const MAINT_OPS = [
  ["analyze", "Analyze"],
  ["optimize", "Optimize"],
  ["repair", "Repair"],
  ["check", "Check"],
  ["flush", "Flush"],
  ["checksum", "Checksum"],
] as const;

function MaintenanceSubmenu({ onPick }: { onPick: (op: (typeof MAINT_OPS)[number][0]) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground" role="menuitem">
          <Stethoscope className="mr-2 size-4" />
          Maintenance
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start">
        {MAINT_OPS.map(([op, label]) => (
          <DropdownMenuItem key={op} onClick={() => onPick(op)}>
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Grouped tables for one database
// ---------------------------------------------------------------------------

function TableGroups({
  connId,
  database,
  dialect,
}: {
  connId: number;
  database: string;
  dialect: SqlDialect;
}) {
  const tables = useQuery({
    queryKey: dbKeys.tables(connId, database),
    queryFn: () => fetchTables(connId, database),
    staleTime: TREE_STALE_TIME,
  });
  const queryClient = useQueryClient();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<TableKind>>(new Set());
  const dialogs = useTreeDialogsStore();
  const { matcher } = useTreeFilter();

  if (tables.isPending) {
    return (
      <p className="flex items-center gap-1.5 px-6 py-1 text-[11px] text-muted-foreground">
        <Spinner className="size-3" /> Loading tables…
      </p>
    );
  }

  if (tables.isError) {
    return (
      <p className="px-6 py-1 text-[11px] leading-snug text-destructive">
        {(tables.error as Error).message}
      </p>
    );
  }

  // Filtered view: keep matching objects only; a pattern hides whole groups
  // that end up empty (the db node itself only renders when something
  // matches or its own name does).
  const groups = groupTables(tables.data ?? [])
    .map(([kind, items]) => [kind, items.filter((t2) => keeps(matcher, t2.name))] as [TableKind, TableMeta[]])
    .filter(([, items]) => matcher === null || items.length > 0);

  const createTable = () => openDesignerTab(connId, database);

  return (
    <ul className="ml-3 border-l pl-2">
      {groups.map(([kind, items]) => {
        const collapsed = matcher === null && collapsedGroups.has(kind);
        const toggleGroup = () =>
          setCollapsedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(kind)) next.delete(kind);
            else next.add(kind);
            return next;
          });

        return (
          <li key={kind}>
            <TreeRow
              open={!collapsed}
              onToggle={toggleGroup}
              menu={
                <>
                  {kind === "table" && (
                    <ContextMenuItem onClick={createTable}>
                      <Plus />
                      Create Table
                    </ContextMenuItem>
                  )}
                  {kind === "table" && allTableNames(tables.data).length > 0 && (
                    <>
                      <MaintenanceSubmenu
                        onPick={(op) =>
                          dialogs.openMaintenance({ db: database, tables: allTableNames(tables.data), op })
                        }
                      />
                      <ContextMenuItem
                        onClick={() =>
                          openExportDialog({
                            kind: "dump",
                            connId,
                            dbs: [database],
                            tables: null,
                          })
                        }
                      >
                        <Download />
                        Export Tables as SQL…
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={() => dialogs.openBulk({ op: "truncate", db: database })}
                      >
                        <Trash2 />
                        Truncate Tables…
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={() => dialogs.openBulk({ op: "drop", db: database })}
                      >
                        <Trash2 />
                        Drop Tables…
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}
                  <CopyNameItem name={`${database}/${KIND_LABELS[kind]}`} />
                  <RefreshItem
                    onClick={() =>
                      void queryClient.invalidateQueries({
                        queryKey: dbKeys.tables(connId, database),
                      })
                    }
                  />
                </>
              }
            >
              {kind === "view" ? (
                <Eye className="size-3.5 shrink-0 text-icon-blue" />
              ) : (
                <Table className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="font-medium">{KIND_LABELS[kind]}</span>
              <span className="ml-auto pr-1 tabular-nums text-[10px] text-muted-foreground">
                {items.length}
              </span>
            </TreeRow>

            {!collapsed && (
              <ul>
                {items.map((table) => (
                  <TableNode key={`${kind}:${table.name}`} connId={connId} database={database} table={table} />
                ))}
              </ul>
            )}
          </li>
        );
      })}

      {/* Phase 4 object groups, hidden per engine capability:
          PostgreSQL has no scheduled events; SQLite has neither routines
          nor events. */}
      {dialect !== "sqlite" && (
        <RoutinesGroup connId={connId} database={database} filtering={matcher !== null} />
      )}
      <TriggersGroup connId={connId} database={database} filtering={matcher !== null} />
      {dialect === "mysql" && (
        <EventsGroup connId={connId} database={database} filtering={matcher !== null} />
      )}
    </ul>
  );
}

/** Unfiltered base-table names (bulk operations always target everything). */
function allTableNames(tables: TableMeta[] | undefined): string[] {
  return (tables ?? []).filter((t) => t.kind === "table").map((t) => t.name);
}

/** Split tables into display groups in stable order. */
function groupTables(tables: TableMeta[]): [TableKind, TableMeta[]][] {
  const order: TableKind[] = ["table", "view", "system_table"];
  const map = new Map<TableKind, TableMeta[]>();
  for (const t of tables) {
    const kind: TableKind = order.includes(t.kind) ? t.kind : "table";
    const list = map.get(kind) ?? [];
    list.push(t);
    map.set(kind, list);
  }
  // Any exotic kinds (materialized views, sequences) get their own groups.
  for (const t of tables) {
    if (!order.includes(t.kind)) order.push(t.kind);
  }
  return order
    .filter((kind) => (map.get(kind)?.length ?? 0) > 0)
    .map((kind) => [kind, map.get(kind)!]);
}

// ---------------------------------------------------------------------------
// Routines / Triggers / Events groups (Phase 4)
// ---------------------------------------------------------------------------

interface ObjectGroupProps {
  connId: number;
  database: string;
}

function GroupShell({
  label,
  icon,
  count,
  open,
  onToggle,
  menu,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  count?: number;
  open: boolean;
  onToggle: () => void;
  menu: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li>
      <TreeRow open={open} onToggle={onToggle} menu={menu}>
        {icon}
        <span className="font-medium">{label}</span>
        {count !== undefined && (
          <span className="ml-auto pr-1 tabular-nums text-[10px] text-muted-foreground">
            {count}
          </span>
        )}
      </TreeRow>
      {open && children}
    </li>
  );
}

function GroupPendingRow({ what }: { what: string }) {
  return (
    <li className="flex items-center gap-1.5 py-0.5 pl-6 text-[11px] text-muted-foreground">
      <Spinner className="size-3" /> Loading {what}…
    </li>
  );
}

function GroupErrorRow({ error }: { error: Error }) {
  return (
    <li className="py-0.5 pl-6 text-[11px] leading-snug text-destructive">
      {error.message}
    </li>
  );
}

function EmptyGroupRow({ what }: { what: string }) {
  return <li className="py-0.5 pl-6 text-[11px] text-muted-foreground">No {what}.</li>;
}

function RoutinesGroup({ connId, database, filtering }: ObjectGroupProps & { filtering?: boolean }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { matcher } = useTreeFilter();
  const forceOpen = filtering === true;

  const routines = useQuery({
    queryKey: objKeys.routines(connId, database),
    queryFn: () => fetchRoutines(connId, database),
    enabled: open || forceOpen,
    staleTime: OBJECT_STALE_TIME,
  });

  const refresh = () =>
    void queryClient.refetchQueries({ queryKey: objKeys.routines(connId, database) });

  const items = (routines.data ?? []).filter((r) => keeps(matcher, r.name));
  if (matcher !== null && items.length === 0 && !routines.isPending) return null;

  return (
    <GroupShell
      label="Routines"
      icon={<Braces className="size-3.5 shrink-0 text-icon-violet" />}
      count={matcher !== null ? items.length : routines.data?.length}
      open={open || forceOpen}
      onToggle={() => setOpen(!open)}
      menu={
        <>
          <CreateNewObjectItem
            label="Create Procedure"
            template={{ kind: "routine", routineKind: "procedure" }}
            connId={connId}
            db={database}
          />
          <CreateNewObjectItem
            label="Create Function"
            template={{ kind: "routine", routineKind: "function" }}
            connId={connId}
            db={database}
          />
          <ContextMenuSeparator />
          <RefreshItem onClick={refresh} />
        </>
      }
    >
      <ul className="ml-4 border-l pl-2">
        {routines.isPending && <GroupPendingRow what="routines" />}
        {routines.isError && <GroupErrorRow error={routines.error as Error} />}
        {!routines.isPending && !routines.isError && items.length === 0 && (
          <EmptyGroupRow what="routines" />
        )}
        {items.map((routine: RoutineMeta) => (
          <RoutineLeaf key={`${routine.kind}:${routine.name}`} connId={connId} database={database} routine={routine} />
        ))}
      </ul>
    </GroupShell>
  );
}

function RoutineLeaf({
  connId,
  database,
  routine,
}: {
  connId: number;
  database: string;
  routine: RoutineMeta;
}) {
  const queryClient = useQueryClient();
  const kindLabel = routine.kind === "function" ? "Function" : "Procedure";

  const openEditor = () =>
    openObjectEditorTab({
      connId,
      db: database,
      kind: "routine",
      name: routine.name,
      routineKind: routine.kind satisfies RoutineKind as RoutineKind,
    });

  const dropRoutine = async () => {
    try {
      await dropObjects(connId, [
        { db: database, kind: "routine", name: routine.name },
      ]);
      notify.success(`${kindLabel} \`${routine.name}\` dropped.`);
      void queryClient.refetchQueries({ queryKey: objKeys.routines(connId, database) });
    } catch (err) {
      notify.error(`Drop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const Icon = routine.kind === "function" ? Sigma : Braces;

  return (
    <li>
      <TreeRow
        onToggle={() => {}}
        onDoubleClick={openEditor}
        menu={
          <>
            <ContextMenuItem onClick={openEditor}>
              <Braces />
              Open Editor
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void dropRoutine()}>
              <Trash2 />
              Drop {kindLabel}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <CopyNameItem name={routine.name} />
            <RefreshItem
              onClick={() =>
                void queryClient.refetchQueries({
                  queryKey: objKeys.routines(connId, database),
                })
              }
            />
          </>
        }
      >
        <Icon className="size-3.5 shrink-0 text-icon-violet/80" />
        <span className="truncate">{routine.name}</span>
        <span className="ml-auto pr-1 font-mono text-[10px] text-muted-foreground/70">
          {routine.kind === "function" ? "fn" : "proc"}
        </span>
      </TreeRow>
    </li>
  );
}

function TriggersGroup({ connId, database, filtering }: ObjectGroupProps & { filtering?: boolean }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { matcher } = useTreeFilter();
  const forceOpen = filtering === true;

  const triggers = useQuery({
    queryKey: objKeys.triggers(connId, database),
    queryFn: () => fetchTriggers(connId, database),
    enabled: open || forceOpen,
    staleTime: OBJECT_STALE_TIME,
  });

  const items = (triggers.data ?? []).filter((tr) => keeps(matcher, tr.name));
  if (matcher !== null && items.length === 0 && !triggers.isPending) return null;

  return (
    <GroupShell
      label="Triggers"
      icon={<Zap className="size-3.5 shrink-0 text-warning" />}
      count={matcher !== null ? items.length : triggers.data?.length}
      open={open || forceOpen}
      onToggle={() => setOpen(!open)}
      menu={
        <>
          <CreateNewObjectItem
            label="Create Trigger"
            template={{ kind: "trigger" }}
            connId={connId}
            db={database}
          />
          <ContextMenuSeparator />
          <RefreshItem
            onClick={() =>
              void queryClient.refetchQueries({ queryKey: objKeys.triggers(connId, database) })
            }
          />
        </>
      }
    >
      <ul className="ml-4 border-l pl-2">
        {triggers.isPending && <GroupPendingRow what="triggers" />}
        {triggers.isError && <GroupErrorRow error={triggers.error as Error} />}
        {!triggers.isPending && !triggers.isError && items.length === 0 && (
          <EmptyGroupRow what="triggers" />
        )}
        {items.map((trigger: TriggerMeta) => (
          <TriggerLeaf key={trigger.name} connId={connId} database={database} trigger={trigger} />
        ))}
      </ul>
    </GroupShell>
  );
}

function TriggerLeaf({
  connId,
  database,
  trigger,
}: {
  connId: number;
  database: string;
  trigger: TriggerMeta;
}) {
  const queryClient = useQueryClient();

  const openEditor = () =>
    openObjectEditorTab({ connId, db: database, kind: "trigger", name: trigger.name });

  const dropTrigger = async () => {
    try {
      await dropObjects(connId, [{ db: database, kind: "trigger", name: trigger.name }]);
      notify.success(`Trigger \`${trigger.name}\` dropped.`);
      void queryClient.refetchQueries({ queryKey: objKeys.triggers(connId, database) });
    } catch (err) {
      notify.error(`Drop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <li>
      <TreeRow
        onToggle={() => {}}
        onDoubleClick={openEditor}
        menu={
          <>
            <ContextMenuItem onClick={openEditor}>
              <Zap />
              Open Editor
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void dropTrigger()}>
              <Trash2 />
              Drop Trigger
            </ContextMenuItem>
            <ContextMenuSeparator />
            <CopyNameItem name={trigger.name} />
            <RefreshItem
              onClick={() =>
                void queryClient.refetchQueries({
                  queryKey: objKeys.triggers(connId, database),
                })
              }
            />
          </>
        }
      >
        <Zap className="size-3.5 shrink-0 text-warning/80" />
        <span className="truncate">{trigger.name}</span>
        <span className="ml-auto pr-1 text-[10px] text-muted-foreground/70">
          {trigger.timing.toLowerCase()} {trigger.event.toLowerCase()}
        </span>
      </TreeRow>
    </li>
  );
}

function EventsGroup({ connId, database, filtering }: ObjectGroupProps & { filtering?: boolean }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { matcher } = useTreeFilter();
  const forceOpen = filtering === true;

  const events = useQuery({
    queryKey: objKeys.events(connId, database),
    queryFn: () => fetchEvents(connId, database),
    enabled: open || forceOpen,
    staleTime: OBJECT_STALE_TIME,
  });

  const items = (events.data ?? []).filter((ev) => keeps(matcher, ev.name));
  if (matcher !== null && items.length === 0 && !events.isPending) return null;

  return (
    <GroupShell
      label="Events"
      icon={<Clock className="size-3.5 shrink-0 text-icon-teal" />}
      count={matcher !== null ? items.length : events.data?.length}
      open={open || forceOpen}
      onToggle={() => setOpen(!open)}
      menu={
        <>
          <CreateNewObjectItem
            label="Create Event"
            template={{ kind: "event" }}
            connId={connId}
            db={database}
          />
          <ContextMenuSeparator />
          <RefreshItem
            onClick={() =>
              void queryClient.refetchQueries({ queryKey: objKeys.events(connId, database) })
            }
          />
        </>
      }
    >
      <ul className="ml-4 border-l pl-2">
        {events.isPending && <GroupPendingRow what="events" />}
        {events.isError && <GroupErrorRow error={events.error as Error} />}
        {!events.isPending && !events.isError && items.length === 0 && (
          <EmptyGroupRow what="events" />
        )}
        {items.map((event: EventMeta) => (
          <EventLeaf key={event.name} connId={connId} database={database} event={event} />
        ))}
      </ul>
    </GroupShell>
  );
}

function EventLeaf({
  connId,
  database,
  event,
}: {
  connId: number;
  database: string;
  event: EventMeta;
}) {
  const queryClient = useQueryClient();

  const openEditor = () =>
    openObjectEditorTab({ connId, db: database, kind: "event", name: event.name });

  const dropEvent = async () => {
    try {
      await dropObjects(connId, [{ db: database, kind: "event", name: event.name }]);
      notify.success(`Event \`${event.name}\` dropped.`);
      void queryClient.refetchQueries({ queryKey: objKeys.events(connId, database) });
    } catch (err) {
      notify.error(`Drop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <li>
      <TreeRow
        onToggle={() => {}}
        onDoubleClick={openEditor}
        menu={
          <>
            <ContextMenuItem onClick={openEditor}>
              <Clock />
              Open Editor
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void dropEvent()}>
              <Trash2 />
              Drop Event
            </ContextMenuItem>
            <ContextMenuSeparator />
            <CopyNameItem name={event.name} />
            <RefreshItem
              onClick={() =>
                void queryClient.refetchQueries({
                  queryKey: objKeys.events(connId, database),
                })
              }
            />
          </>
        }
      >
        <Clock className="size-3.5 shrink-0 text-icon-teal/80" />
        <span className="truncate">{event.name}</span>
        <span className="ml-auto pr-1 text-[10px] text-muted-foreground/70">
          {event.status.toLowerCase()}
        </span>
      </TreeRow>
    </li>
  );
}

/** Opens an editor tab pre-filled with a CREATE skeleton. */
function CreateNewObjectItem({
  label,
  template,
  connId,
  db,
}: {
  label: string;
  template: { kind: "routine" | "trigger" | "event"; routineKind?: RoutineKind };
  connId: number;
  db: string;
}) {
  return (
    <ContextMenuItem
      onClick={() =>
        openObjectEditorTab({
          connId,
          db,
          kind: template.kind,
          routineKind: template.routineKind,
          mode: "create",
        })
      }
    >
      <Plus />
      {label}
    </ContextMenuItem>
  );
}

// ---------------------------------------------------------------------------
// Database nodes + shell
// ---------------------------------------------------------------------------

/** Favorites belonging to one database ("db.table" prefix match). */
function favoriteEntriesFor(favorites: Set<string>, database: string): string[] {
  const prefix = `${database}.`;
  return [...favorites].filter((key) => key.startsWith(prefix));
}

function DatabaseNode({
  connId,
  name,
  dialect,
  defaultOpen = false,
}: {
  connId: number;
  name: string;
  dialect: SqlDialect;
  defaultOpen?: boolean;
}) {
  const { matcher, favoritesOnly, favorites } = useTreeFilter();
  const [open, setOpen] = useState(defaultOpen);
  const queryClient = useQueryClient();
  // A pattern forces the db open so its object lists load and filter;
  // favorites-only renders a flat starred list instead of the groups.
  const forceOpen = matcher !== null;

  // Favorites-only mode: flat starred entries under this db.
  const favEntries = useMemo(
    () => favoriteEntriesFor(favorites, name),
    [favorites, name],
  );

  function refresh() {
    // Prefix-invalidates the tables query AND every columns query below it.
    void queryClient.invalidateQueries({ queryKey: dbKeys.tables(connId, name) });
  }

  return (
    <li>
      <TreeRow
        open={forceOpen ? true : open}
        onToggle={() => setOpen(!open)}
        menu={
          <>
            <ContextMenuItem onClick={() => openDesignerTab(connId, name)}>
              <Plus />
              Create Table
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() =>
                openExportDialog({ kind: "dump", connId, dbs: [name], tables: null })
              }
            >
              <Download />
              Export Database as SQL…
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => openImportWizard({ connId, db: name })}
            >
              <FileUp />
              Import CSV…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <CopyNameItem name={name} />
            <RefreshItem onClick={refresh} />
          </>
        }
      >
        <Database className="size-3.5 shrink-0 text-success" />
        <span className="truncate font-medium">{name}</span>
      </TreeRow>

      {favoritesOnly ? (
        favEntries.length > 0 && (
          <ul className="ml-4 border-l pl-2">
            {favEntries.map((key) => {
              const entry = parseFavoriteKey(key);
              if (!entry) return null;
              const openEntry = () => openDataTable(connId, entry.db, entry.table);
              return (
                <li key={key}>
                  <TreeRow
                    onToggle={openEntry}
                    onDoubleClick={openEntry}
                    menu={
                      <>
                        <ToggleFavoriteItem db={entry.db} table={entry.table} />
                        <CopyNameItem name={entry.table} />
                      </>
                    }
                  >
                    <Table className="size-3.5 shrink-0 text-warning" />
                    <span className="truncate">{entry.table}</span>
                  </TreeRow>
                </li>
              );
            })}
          </ul>
        )
      ) : (
        (forceOpen || open) && (
          <TableGroups connId={connId} database={name} dialect={dialect} />
        )
      )}
    </li>
  );
}

export function DbTree() {
  const status = useConnectionStore((s) => s.status);
  const connId = useConnectionStore((s) => s.connId);

  if (status !== "connected" || connId === null) {
    return (
      <ScrollArea className="h-full">
        <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-4 text-center">
          <Database className="size-8 text-muted-foreground/40" strokeWidth={1.5} />
          <p className="text-xs font-medium text-muted-foreground">Not connected</p>
          <p className="max-w-36 text-[11px] leading-relaxed text-muted-foreground/70">
            Use <span className="font-medium">Connect</span> in the toolbar to open a session.
          </p>
        </div>
      </ScrollArea>
    );
  }

  return <ConnectedTree connId={connId} />;
}

function ConnectedTree({ connId }: { connId: number }) {
  const dialect = useConnectionStore((s) => s.serverInfo?.dialect ?? "mysql");
  const sessionColor = useConnectionStore((s) => s.session?.color ?? null);
  const sessionId = useConnectionStore((s) => s.session?.sessionId ?? null);
  const databases = useQuery({
    queryKey: dbKeys.databases(connId),
    queryFn: () => fetchDatabases(connId),
    staleTime: TREE_STALE_TIME,
  });

  // Filter box + favorites-only toggle (Phase 9-B). Both live here so a
  // tree refresh (query invalidation only) never loses them.
  const [pattern, setPattern] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const matcher = useMemo(() => compileTreeFilter(pattern), [pattern]);
  const { favorites, toggleFavorite } = useTreeFavorites(sessionId);

  const filterState = useMemo<TreeFilterState>(
    () => ({ matcher, favoritesOnly, favorites, toggleFavorite }),
    [matcher, favoritesOnly, favorites, toggleFavorite],
  );

  const dbs = databases.data ?? [];

  // While a pattern is active, every database's object lists load through
  // the SAME cache keys the lazy groups use below (deduped by TanStack
  // Query), so non-matching databases can hide themselves once scanned.
  const scanning = matcher !== null;
  const tableScans = useQueries({
    queries: dbs.map((d) => ({
      queryKey: dbKeys.tables(connId, d.name),
      queryFn: () => fetchTables(connId, d.name),
      enabled: scanning,
      staleTime: TREE_STALE_TIME,
    })),
  });
  const routineScans = useQueries({
    queries: dbs.map((d) => ({
      queryKey: objKeys.routines(connId, d.name),
      queryFn: () => fetchRoutines(connId, d.name),
      enabled: scanning && dialect !== "sqlite",
      staleTime: OBJECT_STALE_TIME,
    })),
  });
  const triggerScans = useQueries({
    queries: dbs.map((d) => ({
      queryKey: objKeys.triggers(connId, d.name),
      queryFn: () => fetchTriggers(connId, d.name),
      enabled: scanning,
      staleTime: OBJECT_STALE_TIME,
    })),
  });
  const eventScans = useQueries({
    queries: dbs.map((d) => ({
      queryKey: objKeys.events(connId, d.name),
      queryFn: () => fetchEvents(connId, d.name),
      enabled: scanning && dialect === "mysql",
      staleTime: OBJECT_STALE_TIME,
    })),
  });

  const visibleDbs = useMemo(() => {
    if (!scanning && !favoritesOnly) return dbs;
    return dbs.filter((db, i) => {
      if (favoritesOnly && favoriteEntriesFor(favorites, db.name).length === 0) {
        return false;
      }
      if (!scanning || matcher === null) return true;
      if (matcher.matches(db.name)) return true;
      const childMatch =
        scanMatches(tableScans[i]?.data, matcher) ||
        scanMatches(routineScans[i]?.data, matcher) ||
        scanMatches(triggerScans[i]?.data, matcher) ||
        scanMatches(eventScans[i]?.data, matcher);
      if (childMatch) return true;
      // Keep the node visible while its scans are still loading so the tree
      // doesn't flicker; hide it only once everything landed unmatched.
      const settled =
        Array.isArray(tableScans[i]?.data) &&
        Array.isArray(triggerScans[i]?.data) &&
        (dialect === "sqlite" || Array.isArray(routineScans[i]?.data)) &&
        (dialect !== "mysql" || Array.isArray(eventScans[i]?.data));
      return !settled;
    });
  }, [dbs, favoritesOnly, favorites, scanning, matcher, tableScans, routineScans, triggerScans, eventScans, dialect]);

  // SQLite exposes exactly one pseudo-database — expand it right away.
  const singleFileDb = dialect === "sqlite" && dbs.length <= 1;

  return (
    <TreeFilterContext.Provider value={filterState}>
      <ScrollArea className="h-full">
        <TreeDialogs />
        {/* Filter bar */}
        <div className="flex items-center gap-1 border-b bg-muted/30 px-1.5 py-1">
          {sessionColor && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-hidden
                  className="ml-0.5 size-2 shrink-0 rounded-full border border-black/10"
                  style={{ backgroundColor: sessionColor }}
                />
              </TooltipTrigger>
              <TooltipContent>{t("tree.sessionAccent")}</TooltipContent>
            </Tooltip>
          )}
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder={t("tree.filterPlaceholder")}
              aria-label={t("tree.filterLabel")}
              title={t("tree.filterHint")}
              className="h-6 border-none bg-transparent pl-6 pr-5 text-[11px] focus-visible:ring-1"
            />
            {pattern && (
              <button
                type="button"
                aria-label={t("tree.filterClear")}
                onClick={() => setPattern("")}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={favoritesOnly ? "secondary" : "ghost"}
                size="icon-xs"
                className="size-6"
                aria-pressed={favoritesOnly}
                aria-label={t("tree.favoritesOnly")}
                onClick={() => setFavoritesOnly((v) => !v)}
              >
                <Star className={cn("size-3.5", favoritesOnly && "fill-warning text-warning")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("tree.favoritesOnly")}</TooltipContent>
          </Tooltip>
        </div>

        <div className="p-2">
          {databases.isPending && (
            <p className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> Loading databases…
            </p>
          )}
          {databases.isError && (
            <p className="px-2 py-2 text-xs leading-snug text-destructive">
              {(databases.error as Error).message}
            </p>
          )}
          {databases.data && databases.data.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">No databases visible.</p>
          )}
          {(matcher !== null || favoritesOnly) && dbs.length > 0 && visibleDbs.length === 0 && (
            <p className="px-2 py-2 text-[11px] text-muted-foreground">
              {favoritesOnly ? t("tree.noFavorites") : t("tree.noMatches")}
            </p>
          )}
          <ul className="flex flex-col gap-0.5 ">
            {visibleDbs.map((db) => (
              <DatabaseNode
                key={db.name}
                connId={connId}
                name={db.name}
                dialect={dialect}
                defaultOpen={singleFileDb}
              />
            ))}
          </ul>
        </div>
      </ScrollArea>
    </TreeFilterContext.Provider>
  );
}
