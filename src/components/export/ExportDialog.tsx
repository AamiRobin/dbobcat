import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  Code,
  Database,
  FileCode,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Globe,
  Hash,
  List,
  Server,
  Table2,
  X,
} from "lucide-react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { dbKeys, fetchTables, TREE_STALE_TIME } from "@/lib/db-queries";
import { t } from "@/lib/i18n";
import { notify } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  cancelExport,
  defaultSqlDumpOptions,
  fileDestination,
  formatFilters,
  pickSavePath,
} from "@/lib/export-queries";
import { onBackendEvent, ipc } from "@/lib/ipc";
import { log } from "@/stores/log";
import { useConnectionStore } from "@/stores/connection";
import {
  useExportDialogStore,
  type ExportRequest,
} from "@/stores/export-dialog";
import type {
  ExportFormat,
  ExportProgress,
  ExportResult,
  SqlDumpOptions,
} from "@/types/ipc";

const FORMAT_CARDS: {
  value: ExportFormat;
  label: string;
  icon: typeof FileText;
}[] = [
  { value: "csv", label: "CSV", icon: FileSpreadsheet },
  { value: "xlsx", label: "XLSX", icon: Table2 },
  { value: "tsv", label: "TSV", icon: List },
  { value: "json", label: "JSON", icon: Braces },
  { value: "xml", label: "XML", icon: Code },
  { value: "html", label: "HTML", icon: Globe },
  { value: "markdown", label: "Markdown", icon: Hash },
  { value: "latex", label: "LaTeX", icon: FileText },
  { value: "php", label: "PHP", icon: FileCode },
  { value: "textile", label: "Textile", icon: List },
  { value: "sql_inserts", label: "SQL INSERTs", icon: Database },
];

const DATA_STATEMENT_ITEMS: {
  value: SqlDumpOptions["dataStatement"];
  label: string;
  hint: string;
}[] = [
  { value: "insert", label: "INSERT", hint: "plain inserts" },
  { value: "insert_ignore", label: "INSERT IGNORE", hint: "skip duplicate-key rows" },
  { value: "replace", label: "REPLACE", hint: "overwrite duplicate rows" },
  { value: "delete_insert", label: "DELETE + INSERT", hint: "delete each row by PK, then insert" },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Single export dialog serving grids, queries, databases and DDL bundles. */
export function ExportDialog() {
  const request = useExportDialogStore((s) => s.request);
  const close = useExportDialogStore((s) => s.close);

  if (!request) return null;
  return (
    <ExportDialogInner
      key={stableKey(request)}
      request={request}
      onClose={close}
    />
  );
}

function stableKey(req: ExportRequest): string {
  return JSON.stringify(req).slice(0, 160);
}

function ExportDialogInner({
  request,
  onClose,
}: {
  request: ExportRequest;
  onClose: () => void;
}) {
  // -- shared options --------------------------------------------------------
  const [format, setFormat] = useState<ExportFormat>(
    request.kind === "ddl" ? "sql_inserts" : "csv",
  );
  const [destKind, setDestKind] = useState<"file" | "clipboard" | "server">("file");
  const [path, setPath] = useState<string | null>(null);
  const [gzip, setGzip] = useState(false);
  const [serverDb, setServerDb] = useState(
    request.kind === "dump"
      ? request.dbs[0] ?? ""
      : request.kind === "grid"
        ? request.db
        : "",
  );

  // Row range only applies to client-side row sources.
  const hasClientRows =
    request.kind === "grid" && request.columns != null && request.rows != null;
  const [range, setRange] = useState<"all" | "selection">("all");

  // XLSX is a binary workbook: it can only land in a file.
  const xlsxFileOnly = request.kind === "grid" && format === "xlsx";

  // Switching to XLSX while a clipboard/server destination is selected
  // snaps the destination back to File (the radios disable either way).
  useEffect(() => {
    if (xlsxFileOnly && destKind !== "file") setDestKind("file");
  }, [xlsxFileOnly, destKind]);

  // -- SQL dump options ------------------------------------------------------
  const [dump, setDump] = useState<SqlDumpOptions>(() =>
    request.kind === "dump"
      ? { ...defaultSqlDumpOptions(request.dbs), tables: request.tables }
      : ({} as SqlDumpOptions),
  );

  // Grid CSV options (Heidi-style delimiter/encloser/NULL handling).
  const [csvDelimiter, setCsvDelimiter] = useState(",");
  const [csvQuote, setCsvQuote] = useState('"');
  const [csvNullText, setCsvNullText] = useState("");

  // Table checklist for whole-database dumps; seeded from the tree cache.
  const connId = useConnectionStore((s) => s.connId) ?? request.connId;
  const dialect = useConnectionStore((s) => s.serverInfo?.dialect ?? "mysql");
  const needsTableList = request.kind === "dump" && request.tables === null;
  const tablesQuery = useQueryTables(connId, needsTableList ? request.dbs[0] : null);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const seeded = useRef(false);
  useEffect(() => {
    if (needsTableList && !seeded.current && tablesQuery.data) {
      seeded.current = true;
      setSelectedTables(new Set(tablesQuery.data));
    }
  }, [needsTableList, tablesQuery.data]);

  // -- run lifecycle -----------------------------------------------------------
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [existsPath, setExistsPath] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const progressId = useRef<number | null>(null);

  useEffect(() => {
    if (!running) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void onBackendEvent<ExportProgress>("export://progress", (p) => {
      if (!disposed) {
        progressId.current = p.id;
        setProgress(p);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [running]);

  function buildArgs(
    overwrite: boolean,
  ): Record<string, unknown> | null {
    let destination: ReturnType<typeof fileDestination> | { kind: "clipboard" } | {
      kind: "server";
      connId: number;
      db: string;
    };
    if (destKind === "file") {
      if (!path) return null;
      // XLSX is already a ZIP: never send a stale gzip flag.
      destination = fileDestination(path, gzip && !xlsxFileOnly);
    } else if (destKind === "clipboard") {
      destination = { kind: "clipboard" };
    } else {
      if (!serverDb.trim()) return null;
      destination = {
        kind: "server",
        connId: request.connId,
        db: serverDb.trim(),
      };
    }

    if (request.kind === "grid") {
      const useSelection = hasClientRows && range === "selection";
      const csvOptions =
        format === "csv" || format === "tsv"
          ? { delimiter: csvDelimiter, quote: csvQuote, nullText: csvNullText }
          : {};
      return {
        connId: request.connId,
        db: request.db,
        table: useSelection ? null : request.table ?? null,
        sql: useSelection ? null : request.sql ?? null,
        selectionColumns: useSelection ? request.columns : null,
        selectionRows: useSelection ? request.rows : null,
        format,
        destination,
        options: csvOptions,
        overwrite,
      };
    }
    if (request.kind === "dump") {
      const effective: SqlDumpOptions = {
        ...dump,
        dbs: request.dbs,
        tables:
          request.tables !== null
            ? request.tables
            : tablesQuery.data &&
                selectedTables.size === (tablesQuery.data?.length ?? 0)
              ? null
              : [...selectedTables],
      };
      return { connId: request.connId, options: effective, destination, overwrite };
    }
    return {
      connId: request.connId,
      requests: request.requests,
      destination,
      title: null,
      overwrite,
    };
  }

  async function run(overwrite: boolean) {
    setExistsPath(null);
    setResult(null);
    setProgress(null);

    const commandName =
      request.kind === "grid"
        ? "export_grid_data"
        : request.kind === "dump"
          ? "export_sql_dump"
          : "export_objects_ddl";
    const args = buildArgs(overwrite);
    if (!args) {
      log("warn", "Export: choose a destination first.");
      return;
    }

    setRunning(true);
    try {
      const res = await ipc<ExportResult>(commandName, args);
      if (res.cancelled) {
        notify.warning(`Export cancelled — kept ${formatBytes(res.bytesWritten)}.`);
      } else {
        notify.success("toast.export.finished", {
          bytes: formatBytes(res.bytesWritten),
          file: res.path ?? "clipboard",
        });
        log(
          "success",
          `Export finished — ${formatBytes(res.bytesWritten)}, ${res.rows.toLocaleString()} row(s), ${res.elapsedMs}ms${res.path ? ` → ${res.path}` : ""}`,
        );
      }
      setResult(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("file exists:")) {
        setExistsPath(message.slice("file exists:".length).trim());
      } else {
        notify.error(`Export failed: ${message}`);
      }
    } finally {
      setRunning(false);
      setProgress(null);
      progressId.current = null;
    }
  }

  async function browse() {
    const stem = suggestedFileName();
    // Database dumps are always SQL — the format cards don't apply to them.
    const effectiveFormat: ExportFormat = request.kind === "dump" ? "sql_inserts" : format;
    const chosen = await pickSavePath(
      `${stem}.${extFor(effectiveFormat)}`,
      formatFilters(effectiveFormat),
    );
    if (chosen) setPath(chosen);
  }

  function suggestedFileName(): string {
    if (request.kind === "grid")
      return request.table ?? "query_result";
    if (request.kind === "dump") return request.dbs.join("_") || "dump";
    return "objects_ddl";
  }

  const serverNeedsSql =
    destKind === "server" && request.kind === "grid" && format !== "sql_inserts";
  const canRun =
    !running &&
    (destKind === "clipboard" ||
      (destKind === "file" && path != null) ||
      (destKind === "server" && serverDb.trim().length > 0)) &&
    !serverNeedsSql;

  const busyLabel = progress?.phase ?? "working…";

  const title =
    request.kind === "dump"
      ? "Export database as SQL"
      : request.kind === "ddl"
        ? "Export object definitions"
        : "Export data";

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-xs">
              {request.kind === "grid" && (
                <>
                  Source{" "}
                  <span className="font-mono">
                    {request.table
                      ? `${request.db}.${request.table}`
                      : (request.sql?.slice(0, 80) ?? "")}
                  </span>
                </>
              )}
              {request.kind === "dump" && (
                <>
                  Database{request.dbs.length > 1 ? "s" : ""}{" "}
                  <span className="font-mono">{request.dbs.join(", ")}</span>
                </>
              )}
              {request.kind === "ddl" && (
                <>{request.requests.length} object(s)</>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* ---- format (grid/table exports; dumps are always SQL) ---- */}
        {request.kind === "grid" && (
          <section>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Format
            </p>
            <div className="grid grid-cols-5 gap-1.5">
              {FORMAT_CARDS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setFormat(value);
                    // TSV's whole point is tab separators; switching formats
                    // keeps the delimiter consistent with the choice.
                    if (value === "tsv" && csvDelimiter === ",") setCsvDelimiter("\t");
                    if (value === "csv" && csvDelimiter === "\t") setCsvDelimiter(",");
                  }}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-[10px] transition-colors",
                    format === value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* ---- row range (client-side selections only) ---- */}
        {hasClientRows && (
          <Field className="gap-1.5">
            <FieldLabel className="text-xs font-medium text-muted-foreground">Rows</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={range}
              onValueChange={(v) => v && setRange(v as "all" | "selection")}
              className="grid w-full grid-cols-2"
            >
              <ToggleGroupItem value="all" className="text-xs">
                Whole {request.table ? "table" : "result"}
              </ToggleGroupItem>
              <ToggleGroupItem value="selection" className="text-xs">
                Selection ({(request.rows?.length ?? 0).toLocaleString()} rows)
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
        )}

        {/* ---- CSV options (grid exports) ---- */}
        {request.kind === "grid" && (format === "csv" || format === "tsv") && (
          <section className="flex flex-col gap-2 rounded-md border p-2.5">
            <p className="text-xs font-medium text-muted-foreground">CSV options</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              {format === "csv" && (
              <>
              <label className="flex items-center gap-1.5 text-muted-foreground">
                Delimiter
                <Select
                  value={csvDelimiter}
                  onValueChange={(v) => setCsvDelimiter(v)}
                >
                  <SelectTrigger className="h-7 w-24 font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value=",">, (comma)</SelectItem>
                    <SelectItem value=";">; (semicolon)</SelectItem>
                    <SelectItem value={"\t"}>Tab</SelectItem>
                    <SelectItem value="|">| (pipe)</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="flex items-center gap-1.5 text-muted-foreground">
                Enclose in
                <Select value={csvQuote} onValueChange={(v) => setCsvQuote(v)}>
                  <SelectTrigger className="h-7 w-24 font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={'"'}>" (double)</SelectItem>
                    <SelectItem value="'">' (single)</SelectItem>
                    <SelectItem value={"`"}>` (backtick)</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              </>
              )}
              <label className="flex items-center gap-1.5 text-muted-foreground">
                NULL as
                <Input
                  value={csvNullText}
                  onChange={(e) => setCsvNullText(e.target.value)}
                  placeholder="(empty)"
                  className="h-7 w-24 px-1.5 font-mono text-xs"
                />
              </label>
            </div>
          </section>
        )}

        {/* ---- SQL dump options (Heidi-style groups) ---- */}
        {request.kind === "dump" && (
          <section className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">SQL options</p>

            {/* Database */}
            <div className="rounded-md border">
              <p className="border-b bg-muted/30 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Database
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 p-2">
                <OptCheck
                  label="CREATE DATABASE + USE header"
                  checked={dump.createDbHeader}
                  onChange={(v) => setDump({ ...dump, createDbHeader: v })}
                />
                {dialect === "mysql" && (
                  <OptCheck
                    label="DROP database first (dangerous)"
                    checked={dump.dropDatabase}
                    onChange={(v) => setDump({ ...dump, dropDatabase: v })}
                  />
                )}
              </div>
            </div>

            {/* Structure */}
            <div className="rounded-md border">
              <p className="border-b bg-muted/30 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Tables &amp; structure
              </p>
              <div className="flex flex-col gap-2 p-2">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={dump.what}
                  onValueChange={(v) =>
                    v && setDump({ ...dump, what: v as SqlDumpOptions["what"] })
                  }
                  className="w-full grid grid-cols-3"
                >
                  <ToggleGroupItem value="structure_and_data" className="text-xs">
                    {t("export.dump.what.structureAndData")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="structure" className="text-xs">
                    {t("export.dump.what.structure")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="data" className="text-xs">
                    {t("export.dump.what.data")}
                  </ToggleGroupItem>
                </ToggleGroup>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <OptCheck
                    label="DROP TABLE IF EXISTS"
                    checked={dump.dropAdd}
                    onChange={(v) => setDump({ ...dump, dropAdd: v })}
                  />
                  <OptCheck
                    label="Include views"
                    checked={dump.includeViews}
                    onChange={(v) => setDump({ ...dump, includeViews: v })}
                  />
                  <OptCheck
                    label="Strip AUTO_INCREMENT counter"
                    checked={dump.stripAutoIncrement}
                    onChange={(v) => setDump({ ...dump, stripAutoIncrement: v })}
                  />
                  <OptCheck
                    label="Strip DEFINER clauses"
                    checked={dump.definerStrip}
                    onChange={(v) => setDump({ ...dump, definerStrip: v })}
                  />
                </div>
              </div>
            </div>

            {/* Data */}
            {dump.what !== "structure" && (
              <div className="rounded-md border">
                <p className="border-b bg-muted/30 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Data
                </p>
                <div className="flex flex-col gap-2 p-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="w-20 shrink-0 text-muted-foreground">Statement</span>
                    <Select
                      value={dump.dataStatement}
                      onValueChange={(v) =>
                        v &&
                        setDump({
                          ...dump,
                          dataStatement: v as SqlDumpOptions["dataStatement"],
                        })
                      }
                    >
                      <SelectTrigger className="h-7 w-44 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DATA_STATEMENT_ITEMS.map((it) => (
                          <SelectItem key={it.value} value={it.value}>
                            {it.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-[10px] text-muted-foreground">
                      {
                        DATA_STATEMENT_ITEMS.find(
                          (it) => it.value === dump.dataStatement,
                        )?.hint
                      }
                      {dump.dataStatement === "replace" &&
                        dialect === "postgres" &&
                        " (upsert via ON CONFLICT — needs a primary key)"}
                      {dump.dataStatement === "delete_insert" &&
                        " (needs a primary key)"}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    <OptCheck
                      label="Complete INSERTs (column lists)"
                      checked={dump.completeInserts}
                      onChange={(v) => setDump({ ...dump, completeInserts: v })}
                    />
                    <OptCheck
                      label="Extended INSERTs (batched VALUES)"
                      checked={dump.extendedInserts}
                      onChange={(v) => setDump({ ...dump, extendedInserts: v })}
                    />
                    <OptCheck
                      label="Delete (truncate) data before insert"
                      checked={dump.truncateBefore}
                      onChange={(v) => setDump({ ...dump, truncateBefore: v })}
                    />
                    <OptCheck
                      label="Wrap data in transactions"
                      checked={dump.useTransactions}
                      onChange={(v) => setDump({ ...dump, useTransactions: v })}
                    />
                    {dialect === "mysql" && (
                      <OptCheck
                        label="Lock tables around data"
                        checked={dump.addLocks}
                        onChange={(v) => setDump({ ...dump, addLocks: v })}
                      />
                    )}
                    <OptCheck
                      label="Blobs as 0x hex"
                      checked={dump.hexBlobs}
                      onChange={(v) => setDump({ ...dump, hexBlobs: v })}
                    />
                  </div>
                  {dump.extendedInserts && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
                      <label className="flex items-center gap-1.5">
                        Max INSERT size
                        <Input
                          type="number"
                          min={1}
                          value={dump.maxInsertSizeKb}
                          onChange={(e) =>
                            setDump({
                              ...dump,
                              maxInsertSizeKb: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                            })
                          }
                          className="h-6 w-20 px-1.5 font-mono text-xs"
                        />
                        KB
                      </label>
                      <label className="flex items-center gap-1.5">
                        Rows per statement
                        <Input
                          type="number"
                          min={1}
                          value={dump.batchRows}
                          onChange={(e) =>
                            setDump({
                              ...dump,
                              batchRows: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                            })
                          }
                          className="h-6 w-20 px-1.5 font-mono text-xs"
                        />
                      </label>
                      <label className="flex items-center gap-1.5">
                        Delay between statements
                        <Input
                          type="number"
                          min={0}
                          value={dump.delayMs}
                          onChange={(e) =>
                            setDump({
                              ...dump,
                              delayMs: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                            })
                          }
                          className="h-6 w-20 px-1.5 font-mono text-xs"
                        />
                        ms
                      </label>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Objects */}
            <div className="rounded-md border">
              <p className="border-b bg-muted/30 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Related objects
              </p>
              <div className="grid grid-cols-3 gap-x-4 gap-y-1.5 p-2">
                <OptCheck
                  label="Routines"
                  checked={dump.includeRoutines}
                  onChange={(v) => setDump({ ...dump, includeRoutines: v })}
                />
                <OptCheck
                  label="Triggers"
                  checked={dump.includeTriggers}
                  onChange={(v) => setDump({ ...dump, includeTriggers: v })}
                />
                <OptCheck
                  label="Events"
                  checked={dump.includeEvents}
                  onChange={(v) => setDump({ ...dump, includeEvents: v })}
                />
              </div>
            </div>

            {needsTableList && tablesQuery.data && tablesQuery.data.length > 0 && (
              <div className="rounded-md border">
                <div className="flex items-center justify-between border-b px-2 py-1.5">
                  <span className="text-xs font-medium">
                    Tables ({selectedTables.size}/{tablesQuery.data.length})
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      setSelectedTables(
                        selectedTables.size === tablesQuery.data!.length
                          ? new Set()
                          : new Set(tablesQuery.data!),
                      )
                    }
                  >
                    Toggle all
                  </Button>
                </div>
                <div className="grid max-h-36 grid-cols-2 gap-x-4 overflow-auto p-2">
                  {tablesQuery.data.map((name) => (
                    <label
                      key={name}
                      className="flex items-center gap-1.5 py-0.5 text-xs"
                    >
                      <Checkbox
                        checked={selectedTables.has(name)}
                        onCheckedChange={(v) => {
                          const next = new Set(selectedTables);
                          if (v === true) next.add(name);
                          else next.delete(name);
                          setSelectedTables(next);
                        }}
                      />
                      <span className="truncate font-mono">{name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        <Separator />

        {/* ---- destination ---- */}
        <section className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Destination</p>
          <RadioGroup
            value={destKind}
            onValueChange={(v) => setDestKind(v as typeof destKind)}
            className="gap-2"
          >
            <div className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
              <RadioGroupItem value="file" className="mt-0.5" />
              <span className="w-10 shrink-0 pt-0.5">File</span>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={destKind !== "file"}
                  onClick={() => void browse()}
                >
                  <FolderOpen data-icon="inline-start" />
                  Browse…
                </Button>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {path ?? "no file chosen"}
                </span>
                <label
                  className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                  title={
                    format === "xlsx"
                      ? "XLSX is already a ZIP archive — gzip does not apply"
                      : undefined
                  }
                >
                  <Checkbox
                    checked={gzip && !xlsxFileOnly}
                    disabled={xlsxFileOnly}
                    onCheckedChange={(v) => setGzip(v === true)}
                  />
                  gzip .gz
                </label>
              </span>
            </div>

            <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
              <RadioGroupItem value="clipboard" disabled={xlsxFileOnly} />
              <span className={cn(xlsxFileOnly && "opacity-50")}>Clipboard</span>
              <span className="pl-2 text-xs text-muted-foreground">
                up to 50 MB
              </span>
            </label>

            <div className="rounded-md border px-3 py-2 text-xs">
              <label className="flex items-center gap-2">
                <RadioGroupItem
                  value="server"
                  disabled={request.kind === "ddl" || xlsxFileOnly}
                />
                <span className={request.kind === "ddl" || xlsxFileOnly ? "opacity-50" : ""}>
                  Another server connection
                </span>
              </label>
              {destKind === "server" && (
                <span className="mt-2 flex items-center gap-1.5 pl-6">
                  <Server className="size-3.5 shrink-0 text-muted-foreground" />
                  <Input
                    value={serverDb}
                    onChange={(e) => setServerDb(e.target.value)}
                    placeholder="target database"
                    className="h-7 flex-1 font-mono text-xs"
                  />
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    current session
                  </Badge>
                </span>
              )}
            </div>
          </RadioGroup>
          {serverNeedsSql && (
            <p className="flex items-center gap-1 text-xs text-warning">
              <AlertTriangle className="size-3" />
              Server-to-server export runs SQL INSERT statements — pick the
              “SQL INSERTs” format.
            </p>
          )}
        </section>

        {/* ---- progress / result ---- */}
        {running && (
          <section className="flex flex-col gap-1.5 rounded-md border p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5">
                <Spinner className="size-3.5" />
                {busyLabel}
                {progress?.table ? ` — ${progress.table}` : ""}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {progress
                  ? `${progress.rowsDone.toLocaleString()} rows · ${formatBytes(progress.bytes)}`
                  : "…"}
              </span>
            </div>
            {progressId.current != null && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => void cancelExport(progressId.current!)}
              >
                <X data-icon="inline-start" />
                Cancel
              </Button>
            )}
          </section>
        )}

        {result && (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <CheckCircle2 className="size-3.5" />
            {result.cancelled
              ? `Cancelled — kept ${formatBytes(result.bytesWritten)}`
              : `Done — ${formatBytes(result.bytesWritten)}, ${result.elapsedMs}ms`}
          </p>
        )}

        {existsPath && (
          <p className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono">{existsPath}</span>
            exists.
            <Button size="xs" onClick={() => void run(true)}>
              Overwrite
            </Button>
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>Close</AlertDialogCancel>
          <Button disabled={!canRun} onClick={() => void run(false)}>
            {running && <Spinner data-icon="inline-start" />}
            Export
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function extFor(format: ExportFormat): string {
  const map: Record<ExportFormat, string> = {
    csv: "csv",
    tsv: "tsv",
    json: "json",
    xml: "xml",
    html: "html",
    markdown: "md",
    latex: "tex",
    php: "php",
    textile: "txt",
    xlsx: "xlsx",
    sql_inserts: "sql",
    sql_replaces: "sql",
    sql_updates: "sql",
  };
  return map[format];
}

/** One labelled checkbox row used across the dump option groups. */
function OptCheck({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {label}
    </label>
  );
}

/** Cached base-table names of one database, fetched through TanStack. */
function useQueryTables(connId: number, db: string | null) {
  return useQuery({
    queryKey: dbKeys.tables(connId, db ?? ""),
    queryFn: () => fetchTables(connId, db!),
    enabled: db != null,
    staleTime: TREE_STALE_TIME,
    // Only base-table names matter for dump selection.
    select: (tables) =>
      tables.filter((t) => t.kind === "table").map((t) => t.name),
  });
}
