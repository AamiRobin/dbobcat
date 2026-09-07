import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Eye,
  FilePlus2,
  KeyRound,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AlterPreviewDialog } from "@/components/designer/AlterPreviewDialog";
import {
  blankDraft,
  emptyColumn,
  emptyForeignKey,
  emptyIndex,
  isDirty,
  togglePrimaryKey,
} from "@/components/designer/column-utils";
import { ColumnsTab } from "@/components/designer/ColumnsTab";
import { DdlTab } from "@/components/designer/DdlTab";
import { ForeignKeysTab } from "@/components/designer/ForeignKeysTab";
import { IndexesTab } from "@/components/designer/IndexesTab";
import { OptionsTab } from "@/components/designer/OptionsTab";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { EmptyPlaceholder } from "@/components/layout/EmptyPlaceholder";
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { dbKeys, TREE_STALE_TIME } from "@/lib/db-queries";
import { diaKeys } from "@/lib/diagram-queries";
import { alterTable, createTable, fetchTableDdl, objKeys } from "@/lib/object-queries";
import { notify } from "@/lib/toast";
import { log } from "@/stores/log";
import { useConnectionStore } from "@/stores/connection";
import type { SqlDialect } from "@/types/ipc";
import { useTabsStore, type Tab } from "@/stores/tabs";
import { useUiStore } from "@/stores/ui";
import type { TableDdl as TableDdlType } from "@/types/ipc";

/**
 * Heidi-style table designer (Phase 4): editable columns/indexes/FK/options
 * tabs over a parsed SHOW CREATE TABLE snapshot, with ALTER preview and
 * sequential apply. Create mode starts from a blank draft and issues
 * CREATE TABLE instead.
 */
export function DesignerView({ tab }: { tab: Tab }) {
  const meta = tab.meta as { connId?: unknown; db?: unknown; table?: unknown };
  if (
    typeof meta.connId !== "number" ||
    typeof meta.db !== "string" ||
    (meta.table !== undefined && typeof meta.table !== "string")
  ) {
    return (
      <EmptyPlaceholder
        icon={KeyRound}
        title="No table selected"
        hint='Open the designer via a table’s "Design table" context menu in the tree.'
      />
    );
  }
  const table = typeof meta.table === "string" ? meta.table : undefined;
  return (
    <DesignerInner key={tab.id} tabId={tab.id} connId={meta.connId} db={meta.db} table={table} />
  );
}

function DesignerInner({
  tabId,
  connId,
  db,
  table,
}: {
  tabId: string;
  connId: number;
  db: string;
  /** undefined → create mode */
  table?: string;
}) {
  const theme = useUiTheme();
  const queryClient = useQueryClient();
  const closeTab = useTabsStore((s) => s.closeTab);
  const dialect: SqlDialect = useConnectionStore((s) => s.serverInfo?.dialect ?? "mysql");

  const createMode = table === undefined;

  // -- loaded snapshot --------------------------------------------------------
  const ddlQuery = useQuery({
    queryKey: objKeys.ddl(connId, db, table ?? ""),
    queryFn: () => fetchTableDdl(connId, db, table!),
    enabled: !createMode,
    staleTime: TREE_STALE_TIME,
    retry: false,
  });

  const [draft, setDraft] = useState<TableDdlType>(() =>
    createMode ? blankDraft(db, "") : (ddlQuery.data ?? blankDraft(db, table ?? "")),
  );
  const [loadedAt, setLoadedAt] = useState<number>(0);

  // Adopt fetched snapshots exactly once per load.
  useEffect(() => {
    if (!createMode && ddlQuery.data && ddlQuery.dataUpdatedAt !== loadedAt) {
      setDraft(structuredClone(ddlQuery.data));
      setLoadedAt(ddlQuery.dataUpdatedAt);
    }
  }, [createMode, ddlQuery.data, ddlQuery.dataUpdatedAt, loadedAt]);

  // No-PK warning (P2 pattern reuse).
  useEffect(() => {
    if (createMode || !ddlQuery.data) return;
    if (!ddlQuery.data.indexes.some((ix) => ix.kind === "primary")) {
      log("warn", `${table} has no primary key.`);
    }
  }, [createMode, ddlQuery.data, table]);

  const dirty = useMemo(
    () => (createMode ? true : isDirty(ddlQuery.data ?? null, draft)),
    [createMode, ddlQuery.data, draft],
  );

  // -- actions -----------------------------------------------------------------
  const refresh = async () => {
    if (createMode) {
      setDraft(blankDraft(db, ""));
      return;
    }
    await ddlQuery.refetch();
  };

  const applyDisabled =
    createMode ? draft.table.trim() === "" || draft.columns.length === 0 : !dirty;

  const applyCreate = async (): Promise<string | null> => {
    try {
      const createSql = await createTable(connId, db, {
        name: draft.table.trim(),
        columns: draft.columns.map((c) => ({ ...c })),
        indexes: draft.indexes,
        foreignKeys: draft.foreignKeys,
        options: draft.options,
      });
      log("success", `Table \`${db}\`.\`${draft.table}\` created.`);
      notify.success("toast.table.created", { table: draft.table });
      void queryClient.invalidateQueries({ queryKey: dbKeys.tables(connId, db) });
      // Diagram caches (columns + whole-schema FKs) must follow.
      void queryClient.invalidateQueries({ queryKey: diaKeys.all(connId) });
      return createSql;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", `CREATE TABLE failed: ${message}`);
      return null;
    }
  };

  const applyAlter = async (): Promise<void> => {
    try {
      const result = await alterTable(connId, db, table!, structuredClone(draft), false);
      const executed = result.executed ?? [];
      if (result.error) {
        log(
          "error",
          `ALTER failed after ${executed.length} of ${executed.length + 1} statement(s): ${result.error}`,
        );
        // Reload so the designer reflects what actually applied.
        await ddlQuery.refetch();
        return;
      }
      log("success", `${table} updated — ${executed.length} statement(s) executed.`);
      notify.success("toast.table.altered", { table: table! });
      for (const warning of result.warnings) {
        log("warn", warning);
      }
      void queryClient.invalidateQueries({ queryKey: dbKeys.tables(connId, db) });
      void queryClient.invalidateQueries({ queryKey: objKeys.ddl(connId, db, table!) });
      // Diagram caches (columns + whole-schema FKs) must follow.
      void queryClient.invalidateQueries({ queryKey: diaKeys.all(connId) });
      await ddlQuery.refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", `ALTER failed: ${message}`);
    }
  };

  // -- render --------------------------------------------------------------------
  if (!createMode && ddlQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" /> Loading table structure…
        </p>
      </div>
    );
  }

  if (!createMode && ddlQuery.isError) {
    return (
      <EmptyPlaceholder
        icon={X}
        title="Could not load table"
        hint={(ddlQuery.error as Error)?.message}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b bg-muted/40 px-1">
        <Badge variant="secondary" className="gap-1 text-[10px] uppercase">
          {createMode ? "New table" : "Table"}
        </Badge>
        <Input
          value={draft.table}
          readOnly={!createMode}
          onChange={(e) => {
            setDraft((d) => ({ ...d, table: e.target.value }));
            renameTab(tabId, e.target.value || "New table");
          }}
          placeholder="table_name"
          aria-label="Table name"
          className="h-6 w-44 px-2 font-mono text-xs"
        />
        <span className="text-xs text-muted-foreground">in</span>
        <Badge variant="outline" className="font-mono text-xs">
          {db}
        </Badge>

        <Separator orientation="vertical" className="mx-1 h-4!" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="xs" onClick={() => addColumn(setDraft)}>
              <Plus data-icon="inline-start" /> Column
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add column</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="xs" onClick={() => addIndex(draft, setDraft)}>
          <Plus data-icon="inline-start" /> Index
        </Button>
        <Button variant="ghost" size="xs" onClick={() => addFk(draft, setDraft)}>
          <Plus data-icon="inline-start" /> Foreign Key
        </Button>

        <div className="ml-auto flex items-center gap-1">
          <PreviewAlterButton
            connId={connId}
            db={db}
            table={table}
            draft={draft}
            disabled={!dirty}
            createMode={createMode}
          />
          <ApplyWithConfirm
            disabled={applyDisabled}
            createMode={createMode}
            tableName={draft.table.trim() || table || ""}
            onApply={async () => {
              if (createMode) await applyCreate();
              else await applyAlter();
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="xs" onClick={() => void refresh()}>
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Discard changes and reload</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={() => closeTab(tabId)} aria-label="Close designer">
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {dialect === "sqlite" && (
        <div className="shrink-0 border-b bg-warning/10 px-3 py-1.5 text-xs leading-snug text-warning">
          Limited ALTER support on SQLite: only adding columns, renaming and
          dropping columns/indexes apply directly. Other changes require
          recreating the table (not generated here).
        </div>
      )}

      {/* sub tabs */}
      <Tabs defaultValue="columns" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex h-8 shrink-0 items-center border-b bg-background px-1">
          <TabsList variant="line" className="h-7">
            <TabsTrigger value="columns" className="text-xs">
              Columns ({draft.columns.length})
            </TabsTrigger>
            <TabsTrigger value="indexes" className="text-xs">
              Indexes ({draft.indexes.length})
            </TabsTrigger>
            <TabsTrigger value="fks" className="text-xs">
              Foreign Keys ({draft.foreignKeys.length})
            </TabsTrigger>
            <TabsTrigger value="options" className="text-xs">
              Options
            </TabsTrigger>
            <TabsTrigger value="ddl" className="text-xs">
              DDL
            </TabsTrigger>
          </TabsList>
          {!createMode && dirty && (
            <span className="ml-auto pr-2 text-xs text-warning">
              unsaved changes
            </span>
          )}
        </div>

        <TabsContent value="columns" className="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <ColumnsTab
            columns={draft.columns}
            indexes={draft.indexes}
            onChange={(columns) => setDraft((d) => ({ ...d, columns }))}
            onTogglePk={(columnName, checked) =>
              setDraft((d) => ({
                ...d,
                indexes: togglePrimaryKey(d.indexes, columnName, checked),
              }))
            }
          />
        </TabsContent>
        <TabsContent value="indexes" className="min-h-0 flex-1 overflow-auto data-[state=inactive]:hidden">
          <IndexesTab
            columns={draft.columns}
            indexes={draft.indexes}
            onChange={(indexes) => setDraft((d) => ({ ...d, indexes }))}
          />
        </TabsContent>
        <TabsContent value="fks" className="min-h-0 flex-1 overflow-auto data-[state=inactive]:hidden">
          <ForeignKeysTab
            foreignKeys={draft.foreignKeys}
            columns={draft.columns}
            onChange={(foreignKeys) => setDraft((d) => ({ ...d, foreignKeys }))}
          />
        </TabsContent>
        <TabsContent value="options" className="min-h-0 flex-1 overflow-auto data-[state=inactive]:hidden">
          <OptionsTab
            options={draft.options}
            onChange={(options) => setDraft((d) => ({ ...d, options }))}
          />
        </TabsContent>
        <TabsContent value="ddl" className="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <DdlTab createSql={ddlQuery.data?.createSql ?? ""} theme={theme} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

function addColumn(setDraft: React.Dispatch<React.SetStateAction<TableDdlType>>) {
  setDraft((d) => ({
    ...d,
    columns: [...d.columns, emptyColumn(`column_${d.columns.length + 1}`)],
  }));
}

function addIndex(
  draft: TableDdlType,
  setDraft: React.Dispatch<React.SetStateAction<TableDdlType>>,
) {
  let n = draft.indexes.length + 1;
  while (draft.indexes.some((ix) => ix.name === `idx_${n}`)) n += 1;
  setDraft((d) => ({ ...d, indexes: [...d.indexes, emptyIndex("index", `idx_${n}`)] }));
}

function addFk(draft: TableDdlType, setDraft: React.Dispatch<React.SetStateAction<TableDdlType>>) {
  let n = draft.foreignKeys.length + 1;
  while (draft.foreignKeys.some((fk) => fk.name.endsWith(`_${n}`))) n += 1;
  const fk = { ...emptyForeignKey(), name: `fk_${n}` };
  setDraft((d) => ({ ...d, foreignKeys: [...d.foreignKeys, fk] }));
}

function renameTab(tabId: string, title: string) {
  useTabsStore.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
  }));
}

function PreviewAlterButton({
  connId,
  db,
  table,
  draft,
  disabled,
  createMode,
}: {
  connId: number;
  db: string;
  table?: string;
  draft: TableDdlType;
  disabled: boolean;
  createMode: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="xs" disabled={disabled} onClick={() => setOpen(true)}>
        <Eye data-icon="inline-start" /> Preview
      </Button>
      <AlterPreviewDialog
        open={open}
        onOpenChange={setOpen}
        connId={connId}
        db={db}
        table={table}
        desired={draft}
        createMode={createMode}
      />
    </>
  );
}

function ApplyWithConfirm({
  disabled,
  createMode,
  tableName,
  onApply,
}: {
  disabled: boolean;
  createMode: boolean;
  tableName: string;
  onApply: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await onApply();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <Button variant="default" size="xs" disabled={disabled || busy} onClick={() => setConfirming(true)}>
        {busy ? (
          <Spinner data-icon="inline-start" />
        ) : createMode ? (
          <FilePlus2 data-icon="inline-start" />
        ) : (
          <Check data-icon="inline-start" />
        )}
        {createMode ? "Create" : "Apply"}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={createMode ? "Create table?" : "Apply changes?"}
        description={
          createMode
            ? `This will execute CREATE TABLE \`${tableName}\` on the server.`
            : `Generated ALTER statements will run sequentially against \`${tableName}\`. Continue?`
        }
        confirmLabel={busy ? "Applying…" : "Execute"}
        onConfirm={() => void run()}
      />
    </>
  );
}

// -- misc ----------------------------------------------------------------------

function useUiTheme(): "dark" | "light" {
  return useUiStore((s) => s.theme);
}
