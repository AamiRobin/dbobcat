import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { t } from "@/lib/i18n";
import {
  TREE_STALE_TIME,
  dbKeys,
  fetchDatabases,
  fetchTables,
} from "@/lib/db-queries";
import { copyTable } from "@/lib/object-queries";
import { openDataTable } from "@/stores/tabs";
import { useConnectionStore } from "@/stores/connection";
import type { SqlDialect } from "@/types/ipc";

import { useTreeDialogsStore } from "./tree-dialogs-store";
import { notify } from "@/lib/toast";

/**
 * "Create table copy…" (Phase 9-B): builds the target table on THIS
 * connection from the source DDL (structure and/or data). Cross-server
 * copies deliberately route through the export dialog instead — noted in
 * the footer hint.
 */
export function CopyTableDialog() {
  const request = useTreeDialogsStore((s) => s.copyTable);
  const closeAll = useTreeDialogsStore((s) => s.closeAll);
  const connId = useConnectionStore((s) => s.connId);

  if (!request || connId === null) return null;

  return (
    <CopyTableDialogInner
      key={`${request.db}.${request.table}`}
      connId={connId}
      db={request.db}
      table={request.table}
      onClose={closeAll}
    />
  );
}

function CopyTableDialogInner({
  connId,
  db,
  table,
  onClose,
}: {
  connId: number;
  db: string;
  table: string;
  onClose: () => void;
}) {
  const dialect = useConnectionStore(
    (s) => s.serverInfo?.dialect ?? ("mysql" as SqlDialect),
  );
  const queryClient = useQueryClient();

  const [targetDb, setTargetDb] = useState(db);
  const [targetName, setTargetName] = useState(`${table}_copy`);
  const [withData, setWithData] = useState<"structure" | "data">("data");
  const [copyIndexes, setCopyIndexes] = useState(true);
  const [copyFks, setCopyFks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const databases = useQuery({
    queryKey: dbKeys.databases(connId),
    queryFn: () => fetchDatabases(connId),
    staleTime: TREE_STALE_TIME,
  });

  const targetTables = useQuery({
    queryKey: dbKeys.tables(connId, targetDb),
    queryFn: () => fetchTables(connId, targetDb),
    staleTime: TREE_STALE_TIME,
  });

  const nameTaken = useMemo(
    () =>
      (targetTables.data ?? []).some(
        (existing) => existing.name.toLowerCase() === targetName.trim().toLowerCase(),
      ),
    [targetTables.data, targetName],
  );

  // Cross-database copies are a MySQL-only capability (PG databases are
  // separate clusters; SQLite sessions are one file).
  const crossDbAllowed = dialect === "mysql";

  const run = useMutation({
    mutationFn: () =>
      copyTable(connId, db, table, targetDb, targetName.trim(), withData === "data", copyIndexes, copyFks),
    onSuccess: async (inserted) => {
      void queryClient.invalidateQueries({
        queryKey: dbKeys.tables(connId, targetDb),
      });
      notify.success(
        t("tree.copyTable.done", {
          count: inserted,
          table: `${targetDb}.${targetName.trim()}`,
        }),
      );
      // Heidi opens the new table's data grid right away.
      openDataTable(connId, targetDb, targetName.trim());
      onClose();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    },
  });

  const submit = () => {
    const name = targetName.trim();
    if (!name) return;
    if (nameTaken) {
      setError(t("tree.copyTable.exists"));
      return;
    }
    setError(null);
    setBusy(true);
    run.mutate();
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("tree.copyTable.title")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              {t("tree.copyTable.source")}{" "}
              <span className="font-mono">
                {db}.{table}
              </span>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-3">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="copy-target-db" className="text-xs text-muted-foreground">
              {t("tree.copyTable.targetDb")}
            </FieldLabel>
            <Select
              value={targetDb}
              onValueChange={(next) => {
                setTargetDb(next);
                setError(null);
              }}
            >
              <SelectTrigger id="copy-target-db" size="sm" className="h-8 w-full text-xs">
                <SelectValue placeholder={databases.isPending ? "…" : undefined} />
              </SelectTrigger>
              <SelectContent>
                {(databases.data ?? []).map((d) => (
                  <SelectItem key={d.name} value={d.name} className="text-xs">
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!crossDbAllowed && (
              <p className="text-[11px] text-muted-foreground/70">{t("tree.copyTable.sameOnly")}</p>
            )}
          </Field>

          <Field className="gap-1.5">
            <FieldLabel htmlFor="copy-target-name" className="text-xs text-muted-foreground">
              {t("tree.copyTable.targetName")}
            </FieldLabel>
            <Input
              id="copy-target-name"
              autoFocus
              value={targetName}
              onChange={(e) => {
                setTargetName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && !busy && void submit()}
              className="font-mono text-xs"
              aria-invalid={nameTaken}
            />
            {nameTaken && (
              <p className="text-[11px] text-destructive">{t("tree.copyTable.exists")}</p>
            )}
          </Field>

          <Field className="gap-1.5">
            <FieldLabel className="text-xs text-muted-foreground">
              {t("tree.copyTable.content")}
            </FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={withData}
              onValueChange={(v) => v && setWithData(v as typeof withData)}
              className="grid w-full grid-cols-2"
            >
              <ToggleGroupItem value="structure" className="text-xs">
                {t("tree.copyTable.structure")}
              </ToggleGroupItem>
              <ToggleGroupItem value="data" className="text-xs">
                {t("tree.copyTable.structureData")}
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>

          <label className="flex items-center justify-between text-xs">
            {t("tree.copyTable.indexes")}
            <Switch checked={copyIndexes} onCheckedChange={setCopyIndexes} aria-label={t("tree.copyTable.indexes")} />
          </label>
          <label className="flex items-center justify-between text-xs">
            {t("tree.copyTable.fks")}
            <Switch checked={copyFks} onCheckedChange={setCopyFks} aria-label={t("tree.copyTable.fks")} />
          </label>

          {error && <p className="break-all text-[11px] leading-snug text-destructive">{error}</p>}
          <p className="text-[11px] text-muted-foreground/70">{t("tree.copyTable.hint")}</p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>{t("dialog.cancel")}</AlertDialogCancel>
          <Button size="sm" disabled={busy || !targetName.trim() || nameTaken} onClick={() => void submit()}>
            {busy && <Spinner data-icon="inline-start" />}
            {t("tree.copyTable.create")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
