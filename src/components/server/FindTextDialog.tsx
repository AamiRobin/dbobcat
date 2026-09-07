import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Play, Search, X } from "lucide-react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { dbKeys, fetchDatabases, fetchTables, TREE_STALE_TIME } from "@/lib/db-queries";
import { Field, FieldLabel } from "@/components/ui/field";
import { findTextCancel, findTextStart, singlePkFilterValue } from "@/lib/server-queries";
import { onBackendEvent } from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { log } from "@/stores/log";
import { notify } from "@/lib/toast";
import { useConnectionStore } from "@/stores/connection";
import { useFindDialogStore } from "@/stores/find-dialog";
import { openDataTable } from "@/stores/tabs";
import type {
  FindMode,
  FindTextMatch,
  FindTextProgress,
  SqlDialect,
} from "@/types/ipc";

/**
 * Find text on server (Phase 7). Scans string columns of the selected
 * databases/tables with LIKE/REGEXP predicates; progress streams through
 * `find://progress` and results support jump-back-to-row on single-PK
 * tables. SQLite connections are gated at the toolbar.
 */
export function FindTextDialog() {
  const request = useFindDialogStore((s) => s.request);
  const close = useFindDialogStore((s) => s.close);

  if (!request) return null;
  return <FindTextDialogInner key={`${request.connId}-${request.db ?? ""}`} request={request} onClose={close} />;
}

const MODES: Array<{ value: FindMode; label: string; hint: string }> = [
  { value: "contains", label: t("find.mode.contains"), hint: "text anywhere in the cell" },
  { value: "prefix", label: t("find.mode.prefix"), hint: "cell starts with the text" },
  { value: "whole", label: t("find.mode.whole"), hint: "exact cell match" },
  { value: "regex", label: t("find.mode.regex"), hint: "regular expression" },
];

function FindTextDialogInner({
  request,
  onClose,
}: {
  request: { connId: number; db?: string };
  onClose: () => void;
}) {
  const connId = request.connId;
  const dialect = useConnectionStore(
    (s) => s.serverInfo?.dialect ?? null,
  ) as SqlDialect | null;

  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<FindMode>("contains");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [maxPerTable, setMaxPerTable] = useState("50");
  const [dbs, setDbs] = useState<Set<string>>(
    () => new Set(request.db ? [request.db] : []),
  );
  const [tablesOpen, setTablesOpen] = useState(false);
  const [tables, setTables] = useState<Set<string>>(new Set());
  const [scopeDbForTables, setScopeDbForTables] = useState(request.db ?? "");

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<FindTextProgress | null>(null);
  const [matches, setMatches] = useState<FindTextMatch[]>([]);
  const [resultMeta, setResultMeta] = useState<{
    cancelled: boolean;
    elapsedMs: number;
    tablesScanned: number;
  } | null>(null);

  // -- data ------------------------------------------------------------------
  const databases = useQuery({
    queryKey: dbKeys.databases(connId),
    queryFn: () => fetchDatabases(connId),
    staleTime: TREE_STALE_TIME,
  });
  // Preselect the current db once the list arrives.
  useEffect(() => {
    if (dbs.size === 0 && databases.data && databases.data.length > 0) {
      setDbs(new Set([databases.data[0].name]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databases.data]);

  const tableList = useQuery({
    queryKey: dbKeys.tables(connId, scopeDbForTables),
    queryFn: () => fetchTables(connId, scopeDbForTables),
    enabled: tablesOpen && scopeDbForTables !== "",
    staleTime: TREE_STALE_TIME,
  });

  // -- progress events ---------------------------------------------------------
  // One scan runs per dialog instance, so every event belongs to it.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void onBackendEvent<FindTextProgress>("find://progress", (p) => {
      setProgress(p);
      if (p.phase === "done" || p.phase === "cancelled") {
        setRunning(false);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  async function run() {
    if (search.trim() === "" || dbs.size === 0) return;
    setResultMeta(null);
    setMatches([]);
    setRunning(true);
    try {
      const result = await findTextStart(connId, {
        dbs: [...dbs],
        tables: tablesOpen && tables.size > 0 ? [...tables] : null,
        search,
        mode,
        caseSensitive,
        maxMatchesPerTable: Math.max(0, Number(maxPerTable) || 0),
      });
      setMatches(result.matches);
      setResultMeta({
        cancelled: result.cancelled,
        elapsedMs: result.elapsedMs,
        tablesScanned: result.tablesScanned,
      });
      setRunning(false);
      log(
        result.cancelled ? "warn" : "success",
        `Find text ${result.cancelled ? "cancelled after" : "finished"} — ${result.matches.length} match(es) in ${result.tablesScanned} table(s), ${result.elapsedMs}ms.`,
      );
    } catch (err) {
      setRunning(false);
      notify.error(`Find text failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function cancel() {
    // The backend assigns ids up front; the first throttled event usually
    // carries it. Cancelling without an id is a harmless no-op there.
    void findTextCancel(progress?.id ?? 0);
  }

  function openMatch(m: FindTextMatch) {
    const pkColumn = m.pkColumn;
    const pkValue = singlePkFilterValue(m.rowPk);
    if (pkColumn == null || pkValue === null) return;
    // Single-column PK: seed the data tab with an equality filter on the
    // primary key so the grid lands directly on the matched row.
    openDataTable(connId, m.db, m.table, [{ column: pkColumn, op: "eq", value: pkValue }]);
    log("info", `Opened ${m.db}.${m.table} filtered on ${pkColumn} = ${pkValue}.`);
  }

  const totalTables = progress?.totalTables ?? 0;
  const doneTables = progress?.tablesDone ?? 0;

  return (
    <Dialog open onOpenChange={(open) => !open && !running && onClose()}>
      <DialogContent className="flex h-[85vh] max-w-3xl flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("find.title")}</DialogTitle>
          <DialogDescription>{t("find.description")}</DialogDescription>
        </DialogHeader>

        {/* ---- form ---- */}
        <div className="flex flex-col gap-3 ">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !running && void run()}
                placeholder={t("find.placeholder")}
                autoFocus
              />
            </div>
            <Button onClick={() => void run()} disabled={running || search.trim() === "" || dbs.size === 0}>
              {running ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
              {t("find.run")}
            </Button>
            {running && (
              <Button variant="outline" onClick={cancel}>
                <X data-icon="inline-start" />
                {t("find.cancel")}
              </Button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field className="gap-1.5">
              <FieldLabel className="text-xs">{t("find.mode")}</FieldLabel>
              <RadioGroup
                value={mode}
                onValueChange={(v) => setMode(v as FindMode)}
                className="grid grid-cols-2 gap-x-2 gap-y-1"
              >
                {MODES.map((m) => (
                  <label
                    key={m.value}
                    title={m.hint}
                    className="flex items-center gap-1.5 text-xs"
                  >
                    <RadioGroupItem value={m.value} disabled={m.value === "regex" && dialect !== "mysql"} />
                    {m.label}
                  </label>
                ))}
              </RadioGroup>
            </Field>

            <Field className="gap-1.5">
              <FieldLabel className="text-xs">{t("find.options")}</FieldLabel>
              <div className="grid grid-cols-2 items-center gap-2">
                <label className="col-span-2 flex items-center gap-1.5 text-xs">
                  <Checkbox checked={caseSensitive} onCheckedChange={() => setCaseSensitive((v) => !v)} />
                  {t("find.caseSensitive")}
                </label>
                <FieldLabel htmlFor="find-max" className="text-xs text-muted-foreground">
                  {t("find.maxPerTable")}
                </FieldLabel>
                <Input
                  id="find-max"
                  inputMode="numeric"
                  className="h-7 text-xs"
                  value={maxPerTable}
                  onChange={(e) => setMaxPerTable(e.target.value)}
                />
              </div>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* db scope multi-select */}
            <Field className="gap-1.5">
              <div className="flex items-center justify-between">
                <FieldLabel className="text-xs">{t("find.databases", { count: dbs.size })}</FieldLabel>
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() =>
                    setDbs(dbs.size === (databases.data?.length ?? 0)
                      ? new Set()
                      : new Set((databases.data ?? []).map((d) => d.name)))
                  }
                >
                  {t("find.toggleAll")}
                </button>
              </div>
              <div className="flex flex-col gap-1 max-h-24 overflow-y-auto rounded-md border p-2">
                {(databases.data ?? []).map((d) => (
                  <label key={d.name} className="flex items-center gap-1.5 text-xs">
                    <Checkbox
                      checked={dbs.has(d.name)}
                      onCheckedChange={() =>
                        setDbs((prev) => {
                          const next = new Set(prev);
                          if (next.has(d.name)) next.delete(d.name);
                          else next.add(d.name);
                          return next;
                        })
                      }
                    />
                    {d.name}
                  </label>
                ))}
              </div>
            </Field>

            {/* optional tables restriction */}
            <Field className="gap-1.5">
              <div className="flex items-center justify-between">
                <FieldLabel className="text-xs">{t("find.tables")}</FieldLabel>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Checkbox checked={tablesOpen} onCheckedChange={() => setTablesOpen((v) => !v)} />
                  {t("find.restrict")}
                </label>
              </div>
              {tablesOpen ? (
                <>
                  <Select value={scopeDbForTables} onValueChange={setScopeDbForTables}>
                    <SelectTrigger size="sm" className="text-xs">
                      <SelectValue placeholder="schema" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {[...dbs].map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}

                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <div className="flex flex-col gap-1 max-h-16 overflow-y-auto rounded-md border p-2">
                    {(tableList.data ?? [])
                      .filter((t) => t.kind === "table")
                      .map((t) => (
                        <label key={t.name} className="flex items-center gap-1.5 text-xs">
                          <Checkbox
                            checked={tables.has(t.name)}
                            onCheckedChange={() =>
                              setTables((prev) => {
                                const next = new Set(prev);
                                if (next.has(t.name)) next.delete(t.name);
                                else next.add(t.name);
                                return next;
                              })
                            }
                          />
                          {t.name}
                        </label>
                      ))}
                  </div>
                </>
              ) : (
                <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
                  {t("find.allTables")}
                </p>
              )}
            </Field>
          </div>

          {/* progress */}
          {(running || resultMeta) && (
            <div className="flex flex-col gap-1 rounded-md border p-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {running
                    ? t("find.scanning", { done: doneTables, total: totalTables || "?" })
                    : resultMeta?.cancelled
                      ? t("find.cancelled")
                      : t("find.done")}
                </span>
                <span>{t("find.matchCount", { count: (progress?.matches ?? matches.length).toLocaleString() })}</span>
              </div>
              <Progress
                value={totalTables > 0 ? Math.round((doneTables / totalTables) * 100) : running ? undefined : 100}
              />
            </div>
          )}
        </div>

        {/* ---- results ---- */}
        <div className={cn("min-h-0 flex-1 overflow-auto rounded-md border")}>
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
              <tr className="border-b">
                <th className="px-2 py-1 font-medium">{t("find.col.db")}</th>
                <th className="px-2 py-1 font-medium">{t("find.col.table")}</th>
                <th className="px-2 py-1 font-medium">{t("find.col.column")}</th>
                <th className="px-2 py-1 font-medium">{t("find.col.pk")}</th>
                <th className="px-2 py-1 font-medium">{t("find.col.preview")}</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((m, i) => (
                <ResultRow key={i} m={m} onOpen={openMatch} />
              ))}
            </tbody>
          </table>
          {!running && matches.length === 0 && (
            <p className="p-4 text-center text-xs text-muted-foreground">
              {resultMeta
                ? t("find.noMatches")
                : t("find.runFirst")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={running}>
            {t("dialog.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultRow({ m, onOpen }: { m: FindTextMatch; onOpen: (m: FindTextMatch) => void }) {
  // Jump-to-row needs a scalar PK value AND the PK column name.
  const canJump =
    m.pkColumn != null && singlePkFilterValue(m.rowPk) !== null;
  return (
    <tr
      className={cn(
        "cursor-default border-b last:border-0 hover:bg-accent",
        canJump && "cursor-pointer",
      )}
      onDoubleClick={() => canJump && onOpen(m)}
      title={canJump ? "Double-click to open the table row" : undefined}
    >
      <td className="px-2 py-1 font-mono">{m.db}</td>
      <td className="px-2 py-1 font-mono">{m.table}</td>
      <td className="px-2 py-1 font-mono">{m.column}</td>
      <td className="max-w-28 truncate px-2 py-1 font-mono" title={m.rowPk}>
        {m.rowPk}
      </td>
      <td className="max-w-80 truncate px-2 py-1" title={m.preview}>
        {m.preview}
      </td>
    </tr>
  );
}
