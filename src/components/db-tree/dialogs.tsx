import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Check, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
import { Checkbox } from "@/components/ui/checkbox";
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
import { dbKeys } from "@/lib/db-queries";
import {
  dropObjects,
  emptyCloneTable,
  renameTable,
  runMaintenance,
  truncateTables,
} from "@/lib/object-queries";
import type { MaintenanceOp, MaintenanceResult, ObjectOpResult } from "@/types/ipc";

import { useConnectionStore } from "@/stores/connection";
import { notify } from "@/lib/toast";

import { CopyTableDialog } from "./CopyTableDialog";
import { useTreeDialogsStore } from "./tree-dialogs-store";

/**
 * Modal dialogs driven by tree context menus (Phase 4): bulk truncate/drop
 * with per-table checkboxes, maintenance with result output, the
 * rename/duplicate prompt — and Phase 9-B's "Create table copy…".
 */

const MAINTENANCE_OPS: { value: MaintenanceOp; label: string }[] = [
  { value: "analyze", label: "Analyze" },
  { value: "optimize", label: "Optimize" },
  { value: "repair", label: "Repair" },
  { value: "check", label: "Check" },
  { value: "flush", label: "Flush" },
  { value: "checksum", label: "Checksum" },
];

/** Rendered once at the DbTree root. */
export function TreeDialogs() {
  return (
    <>
      <BulkDialog />
      <MaintenanceDialog />
      <PromptDialog />
      <CopyTableDialog />
    </>
  );
}

// ---------------------------------------------------------------------------
// Bulk truncate / drop
// ---------------------------------------------------------------------------

function BulkDialog() {
  const bulk = useTreeDialogsStore((s) => s.bulk);
  const closeAll = useTreeDialogsStore((s) => s.closeAll);
  const connId = useConnectionStore((s) => s.connId);
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<ObjectOpResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (bulk) setSelected(new Set());
    setResults(null);
    setBusy(false);
  }, [bulk]);

  if (!bulk || connId === null) return null;

  return (
    <BulkDialogInner
      key={`${bulk.op}:${bulk.db}`}
      connId={connId}
      op={bulk.op}
      db={bulk.db}
      selected={selected}
      setSelected={setSelected}
      results={results}
      busy={busy}
      onRun={(tables) => {
        setBusy(true);
        const run =
          bulk.op === "truncate"
            ? truncateTables(connId, bulk.db, tables)
            : dropObjects(
                connId,
                tables.map((name) => ({ db: bulk.db, kind: "table" as const, name })),
              );
        run
          .then((res) => {
            setResults(res);
            for (const r of res) {
              notify[r.ok ? "success" : "error"](`${bulk.op.toUpperCase()} \`${r.name}\`: ${r.ok ? "done" : r.error}`);
            }
            void queryClient.invalidateQueries({ queryKey: dbKeys.tables(connId, bulk.db) });
          })
          .catch((err) => notify.error(`${bulk.op} failed: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => setBusy(false));
      }}
      onClose={closeAll}
    />
  );
}

function BulkDialogInner({
  connId,
  op,
  db,
  selected,
  setSelected,
  results,
  busy,
  onRun,
  onClose,
}: {
  connId: number;
  op: "truncate" | "drop";
  db: string;
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  results: ObjectOpResult[] | null;
  busy: boolean;
  onRun: (tables: string[]) => void;
  onClose: () => void;
}) {
  // Table names come from the cached tree query.
  const tables = useTablesFromCache(connId, db);

  const toggle = (name: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(name);
    else next.delete(name);
    setSelected(next);
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {op === "drop" ? "Drop tables" : "Truncate tables"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              {op === "drop"
                ? "Dropped tables are gone permanently (structure + data)."
                : "Truncation removes all rows but keeps the table structure."}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {results ? (
          <ul className="flex max-h-64 flex-col gap-1 overflow-auto rounded-md border p-2">
            {results.map((r) => (
              <li key={r.name} className="flex items-center gap-1.5 text-xs">
                {r.ok ? (
                  <Check className="size-3.5 text-success" />
                ) : (
                  <TriangleAlert className="size-3.5 text-destructive" />
                )}
                <span className="font-mono">{r.name}</span>
                {!r.ok && <span className="text-destructive">{r.error}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex max-h-64 flex-col gap-0.5 overflow-auto rounded-md border p-2">
            {tables.map((name) => (
              <label key={name} className="flex items-center gap-2 py-0.5 text-xs">
                <Checkbox
                  checked={selected.has(name)}
                  onCheckedChange={(v) => toggle(name, v === true)}
                />
                <span className="font-mono">{name}</span>
              </label>
            ))}
            {tables.length === 0 && (
              <p className="p-2 text-xs text-muted-foreground">Loading tables…</p>
            )}
          </div>
        )}

        <AlertDialogFooter>
          {!results && tables.length > 0 && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSelected(selected.size === tables.length ? new Set() : new Set(tables))
                }
              >
                Toggle all
              </Button>
              <span className="mr-auto self-center text-[11px] text-muted-foreground">
                {selected.size} of {tables.length} selected
              </span>
            </>
          )}
          <AlertDialogCancel onClick={onClose}>
            {results ? "Close" : "Cancel"}
          </AlertDialogCancel>
          {!results && (
            <Button
              variant={op === "drop" ? "destructive" : "default"}
              size="sm"
              disabled={busy || selected.size === 0}
              onClick={() => onRun([...selected])}
            >
              {busy && <Spinner data-icon="inline-start" />}
              {op === "drop" ? "Drop selected" : "Truncate selected"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Read table names from the TanStack cache without refetching. */
function useTablesFromCache(connId: number, db: string): string[] {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const cached = queryClient.getQueryData<{ name: string; kind: string }[]>(
      dbKeys.tables(connId, db),
    );
    return (cached ?? []).filter((t) => t.kind === "table").map((t) => t.name).sort();
  }, [queryClient, connId, db]);
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

function MaintenanceDialog() {
  const maintenance = useTreeDialogsStore((s) => s.maintenance);
  const closeAll = useTreeDialogsStore((s) => s.closeAll);
  const connId = useConnectionStore((s) => s.connId);

  if (!maintenance || connId === null) return null;

  return (
    <MaintenanceDialogInner
      key={`${maintenance.db}:${maintenance.tables.join(",")}`}
      connId={connId}
      {...maintenance}
      onClose={closeAll}
    />
  );
}

function MaintenanceDialogInner({
  connId,
  db,
  tables,
  op: initialOp,
  onClose,
}: {
  connId: number;
  db: string;
  tables: string[];
  op: MaintenanceOp;
  onClose: () => void;
}) {
  const [op, setOp] = useState<MaintenanceOp>(initialOp);
  const [nonce, setNonce] = useState(0);

  const run = useQuery({
    queryKey: ["obj-maintenance-run", connId, db, tables, op, nonce],
    queryFn: () => runMaintenance(connId, db, tables, op),
    enabled: tables.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Maintenance</AlertDialogTitle>
          <AlertDialogDescription>
            {tables.length} table{tables.length === 1 ? "" : "s"} in{" "}
            <span className="font-mono">{db}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Field className="items-center gap-2" orientation="horizontal">
          <FieldLabel htmlFor="maint-op" className="text-xs text-muted-foreground">
            Operation
          </FieldLabel>
          <Select
            value={op}
            onValueChange={(v) => {
              setOp(v as MaintenanceOp);
              setNonce((n) => n + 1);
            }}
          >
            <SelectTrigger size="sm" id="maint-op" className="h-7 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MAINTENANCE_OPS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <div className="max-h-56 overflow-auto rounded-md border">
          {run.isPending && (
            <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
              <Spinner className="size-3" /> Running…
            </p>
          )}
          {run.data?.map((r: MaintenanceResult) => (
            <div
              key={r.table}
              className="flex items-start gap-2 border-b px-2.5 py-1.5 last:border-b-0"
            >
              <span className="w-40 shrink-0 truncate font-mono text-[11px]">{r.table}</span>
              <span className="whitespace-pre-wrap font-mono text-[11px] leading-snug text-muted-foreground">
                {r.resultText}
              </span>
            </div>
          ))}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Rename / duplicate prompt
// ---------------------------------------------------------------------------

function PromptDialog() {
  const prompt = useTreeDialogsStore((s) => s.prompt);
  const closeAll = useTreeDialogsStore((s) => s.closeAll);
  const connId = useConnectionStore((s) => s.connId);
  const queryClient = useQueryClient();

  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (prompt) {
      setValue(prompt.kind === "rename" ? prompt.table : `${prompt.table}_copy`);
      setBusy(false);
    }
  }, [prompt]);

  if (!prompt || connId === null) return null;

  const submit = async () => {
    const name = value.trim();
    if (!name) return;
    setBusy(true);
    try {
      if (prompt.kind === "rename") {
        await renameTable(connId, prompt.db, prompt.table, name);
        notify.success(`Table renamed to \`${name}\`.`);
      } else {
        await emptyCloneTable(connId, prompt.db, prompt.table, prompt.db, name);
        notify.success(`Structure of \`${prompt.table}\` copied to \`${name}\`.`);
      }
      void queryClient.invalidateQueries({ queryKey: dbKeys.tables(connId, prompt.db) });
      closeAll();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(o) => !o && closeAll()}>
      <AlertDialogContent className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {prompt.kind === "rename" ? "Rename table" : "Duplicate table (structure)"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              {prompt.kind === "rename"
                ? `Rename \`${prompt.table}\` in \`${prompt.db}\`.`
                : `CREATE TABLE … LIKE creates an empty copy of \`${prompt.table}\`.`}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          className="font-mono text-xs"
          aria-label="New table name"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button size="sm" disabled={busy || !value.trim()} onClick={() => void submit()}>
            {busy && <Spinner data-icon="inline-start" />}
            {prompt.kind === "rename" ? "Rename" : "Create copy"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
