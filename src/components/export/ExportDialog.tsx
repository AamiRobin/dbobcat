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
  X,
} from "lucide-react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { dbKeys, fetchTables, TREE_STALE_TIME } from "@/lib/db-queries";
import { t } from "@/lib/i18n";
import { notify } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { cancelExport, fileDestination, formatFilters, pickSavePath } from "@/lib/export-queries";
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

const DUMP_FLAGS: { key: keyof SqlDumpOptions; label: string }[] = [
  { key: "dropAdd", label: "DROP TABLE IF EXISTS" },
  { key: "addLocks", label: "Lock tables around data" },
  { key: "completeInserts", label: "Complete INSERTs (column lists)" },
  { key: "extendedInserts", label: "Extended INSERTs (batched VALUES)" },
  { key: "useTransactions", label: "Wrap data in transactions" },
  { key: "createDbHeader", label: "CREATE DATABASE / USE header" },
  { key: "definerStrip", label: "Strip DEFINER clauses" },
  { key: "includeViews", label: "Include views" },
  { key: "includeRoutines", label: "Include routines" },
  { key: "includeTriggers", label: "Include triggers" },
  { key: "includeEvents", label: "Include events" },
  { key: "insertIgnore", label: "INSERT IGNORE" },
  { key: "hexBlobs", label: "Blobs as 0x hex" },
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

  // -- SQL dump options ------------------------------------------------------
  const [dump, setDump] = useState<SqlDumpOptions>(() =>
    request.kind === "dump"
      ? {
          dbs: request.dbs,
          tables: request.tables,
          what: "structure_and_data",
          dropAdd: true,
          addLocks: true,
          completeInserts: false,
          extendedInserts: true,
          useTransactions: false,
          createDbHeader: true,
          definerStrip: true,
          includeViews: true,
          includeRoutines: false,
          includeTriggers: false,
          includeEvents: false,
          insertIgnore: false,
          hexBlobs: false,
        }
      : ({} as SqlDumpOptions),
  );

  // Table checklist for whole-database dumps; seeded from the tree cache.
  const connId = useConnectionStore((s) => s.connId) ?? request.connId;
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
      destination = fileDestination(path, gzip);
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
      return {
        connId: request.connId,
        db: request.db,
        table: useSelection ? null : request.table ?? null,
        sql: useSelection ? null : request.sql ?? null,
        selectionColumns: useSelection ? request.columns : null,
        selectionRows: useSelection ? request.rows : null,
        format,
        destination,
        options: {},
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
    const chosen = await pickSavePath(`${stem}.${extFor(format)}`, formatFilters(format));
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

        {/* ---- format ---- */}
        {request.kind !== "ddl" && (
          <section>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Format
            </p>
            <div className="grid grid-cols-5 gap-1.5">
              {FORMAT_CARDS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFormat(value)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-[10px] transition-colors",
                    format === value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent/60",
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

        {/* ---- SQL dump options ---- */}
        {request.kind === "dump" && (
          <Accordion type="single" collapsible>
            <AccordionItem value="opts">
              <AccordionTrigger className="py-2 text-xs">
                SQL options
              </AccordionTrigger>
              <AccordionContent className="flex flex-col gap-3">
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

                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                  {DUMP_FLAGS.map(({ key, label }) => (
                    <label
                      key={String(key)}
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      <Checkbox
                        checked={Boolean(dump[key])}
                        onCheckedChange={(v) =>
                          setDump({ ...dump, [key]: v === true })
                        }
                      />
                      {label}
                    </label>
                  ))}
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
              </AccordionContent>
            </AccordionItem>
          </Accordion>
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
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                  {path ?? "no file chosen"}
                </span>
                <label className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <Checkbox
                    checked={gzip}
                    onCheckedChange={(v) => setGzip(v === true)}
                  />
                  gzip .gz
                </label>
              </span>
            </div>

            <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
              <RadioGroupItem value="clipboard" />
              Clipboard
              <span className="pl-2 text-[11px] text-muted-foreground">
                up to 50 MB
              </span>
            </label>

            <div className="rounded-md border px-3 py-2 text-xs">
              <label className="flex items-center gap-2">
                <RadioGroupItem
                  value="server"
                  disabled={request.kind === "ddl"}
                />
                <span className={request.kind === "ddl" ? "opacity-50" : ""}>
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
            <p className="flex items-center gap-1 text-[11px] text-warning">
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
              <span className="font-mono text-[11px] text-muted-foreground">
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
    sql_inserts: "sql",
    sql_replaces: "sql",
    sql_updates: "sql",
  };
  return map[format];
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
