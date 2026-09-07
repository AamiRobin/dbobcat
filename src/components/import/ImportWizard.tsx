import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  FolderOpen,
} from "lucide-react";

import { Stepper } from "@/components/common/Stepper";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  TREE_STALE_TIME,
  dbKeys,
  fetchColumns,
  fetchDatabases,
  fetchTables,
} from "@/lib/db-queries";
import {
  autoMapColumns,
  guessColumnTypes,
  importCsvPreview,
  importCsvRun,
} from "@/lib/import-queries";
import { pickOpenPath } from "@/lib/export-queries";
import { t, type TKey } from "@/lib/i18n";
import { notify } from "@/lib/toast";
import { onBackendEvent } from "@/lib/ipc";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { log } from "@/stores/log";
import { useConnectionStore } from "@/stores/connection";
import { useImportDialogStore } from "@/stores/import-dialog";
import type {
  CsvParseOptions,
  CsvPreview,
  ImportMode,
  ImportErrorMode,
  ImportProgress,
  ImportResult,
  MapSpec,
} from "@/types/ipc";

const STEPS = [
  t("import.step.source"),
  t("import.step.parse"),
  t("import.step.target"),
  t("import.step.mode"),
  t("import.step.run"),
];

/** Sentinel for the "(skip)" mapping entry — Radix forbids empty item values. */
const SKIP = "__skip__";

const MODE_INFO: Record<
  ImportMode,
  { labelKey: TKey; hintKey: TKey }
> = {
  append: { labelKey: "import.mode.append", hintKey: "import.mode.append.hint" },
  replace: { labelKey: "import.mode.replace", hintKey: "import.mode.replace.hint" },
  insert_ignore: {
    labelKey: "import.mode.insertIgnore",
    hintKey: "import.mode.insertIgnore.hint",
  },
  upsert: { labelKey: "import.mode.upsert", hintKey: "import.mode.upsert.hint" },
};

const ON_ERROR_INFO: Record<ImportErrorMode, TKey> = {
  abort: "import.onError.abort",
  skip: "import.onError.skip",
  through: "import.onError.through",
};

const CSV_FILTERS = [
  { name: "CSV / text", extensions: ["csv", "tsv", "txt"] },
  { name: "Gzip CSV", extensions: ["gz"] },
];

/** Five-step CSV import wizard (Heidi's text-import parity). */
export function ImportWizard() {
  const request = useImportDialogStore((s) => s.request);
  const close = useImportDialogStore((s) => s.close);

  if (!request) return null;
  return (
    <ImportWizardInner
      key={`${request.connId}:${request.db ?? ""}:${request.table ?? ""}`}
      request={request}
      onClose={close}
    />
  );
}

function ImportWizardInner({
  request,
  onClose,
}: {
  request: { connId: number; db?: string; table?: string };
  onClose: () => void;
}) {
  const connId = useConnectionStore((s) => s.connId) ?? request.connId;

  // -- step state -------------------------------------------------------------
  const [step, setStep] = useState(0);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [pastedText, setPastedText] = useState<string | null>(null);

  const [options, setOptions] = useState<CsvParseOptions>({
    delimiter: ",",
    quote: '"',
    hasHeader: true,
    skipRows: 0,
    emptyIsNull: true,
  });

  const [targetDb, setTargetDb] = useState(request.db ?? "");
  const [targetTable, setTargetTable] = useState(request.table ?? "");
  const [createNew, setCreateNew] = useState(false);
  const [newTableName, setNewTableName] = useState("");
  const [mapping, setMapping] = useState<(string | null)[]>([]);

  const [mode, setMode] = useState<ImportMode>("append");
  const [batchSize, setBatchSize] = useState(500);
  const [onError, setOnError] = useState<ImportErrorMode>("abort");

  // -- preview ----------------------------------------------------------------
  const preview = useMutation({
    mutationFn: () =>
      importCsvPreview(sourcePath, pastedText, options),
  });

  // Re-parse whenever parse knobs change while a preview exists.
  useEffect(() => {
    if (step === 1 && (sourcePath || pastedText)) preview.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, sourcePath, pastedText, options]);

  const csvColumns = preview.data?.columns ?? [];
  const previewRows = preview.data?.rows ?? [];

  const databasesQuery = useQuery({
    queryKey: dbKeys.databases(connId),
    queryFn: () => fetchDatabases(connId),
    staleTime: TREE_STALE_TIME,
  });

  // Seed the mapping once the target table columns are known.
  const targetInfo = useColumns(connId, targetDb, createNew ? "" : targetTable);
  const columnMeta = targetInfo.columns.data;
  useEffect(() => {
    if (!createNew && columnMeta && csvColumns.length > 0) {
      setMapping(autoMapColumns(csvColumns, columnMeta));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createNew, columnMeta, csvColumns.join("|")]);

  const newColumns = useMemo(
    () => guessColumnTypes(csvColumns, previewRows),
    [csvColumns, previewRows],
  );

  // -- run ----------------------------------------------------------------------
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    if (step !== 4) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void onBackendEvent<ImportProgress>("import://progress", (p) => {
      if (!disposed && p.phase !== "done") setProgress(p);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [step]);

  const run = useMutation({
    mutationFn: async (): Promise<ImportResult> => {
      let effectiveMapping: MapSpec[];
      let newTable: import("@/types/ipc").NewTableSpec | null = null;

      if (createNew) {
        newTable = { name: newTableName.trim(), columns: newColumns };
        effectiveMapping = csvColumns.map((_, i) => ({
          csvColIdx: i,
          targetCol: csvColumns[i],
        }));
      } else {
        effectiveMapping = mapping
          .map((target, idx) =>
            target ? { csvColIdx: idx, targetCol: target } : null,
          )
          .filter((m): m is MapSpec => m !== null);
      }
      if (effectiveMapping.length === 0) {
        throw new Error("no columns are mapped to the target table");
      }

      return importCsvRun({
        connId,
        db: targetDb,
        table: createNew ? newTableName.trim() : targetTable,
        sourcePath,
        clipboardText: pastedText,
        options,
        mapping: effectiveMapping,
        newTable,
        mode,
        batchSize,
        onError,
      });
    },
    onSuccess: (res) => {
      setResult(res);
      notify.success("toast.import.finished", { inserted: res.inserted.toLocaleString() });
      log("success", `Import finished — ${res.inserted} row(s), ${res.errors.length} error(s), ${res.elapsedMs}ms.`);
    },
    onError: (err) => {
      notify.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    },
  });

  // -- navigation guards ----------------------------------------------------------
  const canNext =
    (step === 0 && Boolean(sourcePath || pastedText)) ||
    (step === 1 && preview.isSuccess) ||
    (step === 2 &&
      targetDb.trim().length > 0 &&
      (createNew ? newTableName.trim().length > 0 : targetTable.trim().length > 0)) ||
    step === 3;

  async function browse() {
    const chosen = await pickOpenPath(CSV_FILTERS);
    if (chosen) {
      setSourcePath(chosen);
      setPastedText(null);
      setStep(1);
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-h-[88vh] overflow-auto sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Import CSV / text file</AlertDialogTitle>
          <AlertDialogDescription>
            <Stepper steps={STEPS} active={step} className="mt-1" />
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* ---- step 0 · source ---- */}
        {step === 0 && (
          <div className="flex flex-col gap-3">
            <Button variant="outline" onClick={() => void browse()}>
              <FolderOpen data-icon="inline-start" />
              Choose file…
            </Button>
            <p className="text-xs text-muted-foreground">
              {sourcePath ? (
                <>
                  Selected{" "}
                  <span className="font-mono">{sourcePath}</span>
                  {sourcePath.toLowerCase().endsWith(".gz") && " (gzip — decompressed automatically)"}
                </>
              ) : (
                "…or paste delimited text below."
              )}
            </p>
            <Textarea
              value={pastedText ?? ""}
              onChange={(e) => setPastedText(e.target.value || null)}
              placeholder="id,name\n1,ann"
              rows={6}
              className="bg-background font-mono text-xs"
            />          </div>
        )}

        {/* ---- step 1 · parse options + preview ---- */}
        {step === 1 && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field className="w-16 gap-1">
                <FieldLabel htmlFor="csv-delimiter" className="text-xs">
                  {t("import.parse.delimiter")}
                </FieldLabel>
                <Input
                  id="csv-delimiter"
                  value={options.delimiter}
                  onChange={(e) =>
                    setOptions({ ...options, delimiter: e.target.value.slice(0, 1) })
                  }
                  className="h-7 font-mono text-xs"
                />
              </Field>
              <Field className="w-16 gap-1">
                <FieldLabel htmlFor="csv-quote" className="text-xs">
                  {t("import.parse.quote")}
                </FieldLabel>
                <Input
                  id="csv-quote"
                  value={options.quote}
                  onChange={(e) =>
                    setOptions({ ...options, quote: e.target.value.slice(0, 1) })
                  }
                  className="h-7 font-mono text-xs"
                />
              </Field>
              <label className="flex items-center gap-1.5 pb-1 text-xs">
                <Checkbox
                  checked={options.hasHeader}
                  onCheckedChange={(v) =>
                    setOptions({ ...options, hasHeader: v === true })
                  }
                />
                {t("import.parse.header")}
              </label>
              <label className="flex items-center gap-1.5 pb-1 text-xs">
                <Checkbox
                  checked={options.emptyIsNull}
                  onCheckedChange={(v) =>
                    setOptions({ ...options, emptyIsNull: v === true })
                  }
                />
                {t("import.parse.emptyIsNull")}
              </label>
              <Field className="w-20 gap-1">
                <FieldLabel htmlFor="csv-skip-rows" className="text-xs">
                  {t("import.parse.skipRows")}
                </FieldLabel>
                <Input
                  id="csv-skip-rows"
                  type="number"
                  min={0}
                  value={options.skipRows}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      skipRows: Math.max(0, Number(e.target.value) || 0),
                    })
                  }
                  className="h-7 text-xs"
                />
              </Field>
            </div>

            <PreviewGrid preview={preview.data} loading={preview.isPending} />
            {preview.data && (
              <p className="text-xs text-muted-foreground">
                ≈{preview.data.totalLinesEst.toLocaleString()} record(s) in total.
              </p>
            )}
          </div>
        )}

        {/* ---- step 2 · target + mapping ---- */}
        {step === 2 && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs">
                <Checkbox
                  checked={!createNew}
                  onCheckedChange={(v) => setCreateNew(v !== true)}
                />
                Existing table
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <Checkbox
                  checked={createNew}
                  onCheckedChange={(v) => setCreateNew(v === true)}
                />
                Create new
              </label>
            </div>

            {!createNew && (
              <div className="flex flex-wrap items-center gap-2">
                <Select value={targetDb} onValueChange={setTargetDb}>
                  <SelectTrigger size="sm" className="h-7 w-44 text-xs">
                    <SelectValue placeholder={t("import.target.database")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(databasesQuery.data ?? []).map((d) => (
                        <SelectItem key={d.name} value={d.name} className="text-xs">
                          {d.name}
                        </SelectItem>
                      ))}

                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Select value={targetTable} onValueChange={setTargetTable}>
                  <SelectTrigger size="sm" className="h-7 w-44 text-xs">
                    <SelectValue placeholder={t("import.target.table")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(targetInfo.tables.data ?? []).map((tb) => (
                        <SelectItem key={tb} value={tb} className="text-xs">
                          {tb}
                        </SelectItem>
                      ))}

                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}

            {createNew && (
              <div className="flex flex-col gap-2">
                <Input
                  value={newTableName}
                  onChange={(e) => setNewTableName(e.target.value)}
                  placeholder="new_table_name"
                  className="h-8 font-mono text-xs"
                />
                <div className="grid max-h-32 grid-cols-2 gap-x-6 gap-y-1 overflow-auto rounded-md border p-2">
                  {newColumns.map((c) => (
                    <span key={c.name} className="truncate font-mono text-xs text-muted-foreground">
                      {c.name} <span className="opacity-60">{c.dataType}</span>
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Types guessed TEXT/INT/DOUBLE from the first rows; every CSV
                  column will be imported in order.
                </p>
              </div>
            )}

            {/* mapping */}
            {!createNew && csvColumns.length > 0 && (
              <div className="rounded-md border p-2">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  Column mapping
                </p>
                <div className="grid max-h-40 grid-cols-2 gap-x-6 gap-y-1.5 overflow-auto">
                  {csvColumns.map((col, idx) => (
                    <label key={`${col}-${idx}`} className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={mapping[idx] != null}
                        onCheckedChange={(v) =>
                          setMapping((prev) => {
                            const next = [...prev];
                            next[idx] =
                              v === true
                                ? (columnMeta?.[idx]?.name ?? col)
                                : null;
                            return next;
                          })
                        }
                      />
                      <span className="min-w-0 flex-1 truncate font-mono">{col}</span>
                      <Select
                        value={mapping[idx] ?? SKIP}
                        onValueChange={(v) =>
                          setMapping((prev) => {
                            const next = [...prev];
                            next[idx] = v === SKIP ? null : v;
                            return next;
                          })
                        }
                      >
                        <SelectTrigger size="sm" className="h-6 w-36 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value={SKIP} className="text-xs">
                              {t("import.map.skip")}
                            </SelectItem>
                            {(columnMeta ?? []).map((cm) => (
                              <SelectItem key={cm.name} value={cm.name} className="text-xs">
                                {cm.name}
                                <span className="ml-1 opacity-50">{cm.dataType}</span>
                              </SelectItem>
                            ))}

                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---- step 3 · mode ---- */}
        {step === 3 && (
          <FieldGroup className="gap-4">
            <div className="flex flex-col gap-1.5">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={mode}
                onValueChange={(v) => v && setMode(v as ImportMode)}
                className="grid w-full grid-cols-4"
              >
                {(Object.keys(MODE_INFO) as ImportMode[]).map((m) => (
                  <ToggleGroupItem
                    key={m}
                    value={m}
                    title={t(MODE_INFO[m].hintKey)}
                    className="text-xs"
                  >
                    {t(MODE_INFO[m].labelKey)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                {t(MODE_INFO[mode].hintKey)}.
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="import-batch-size" className="text-xs">
                  {t("import.run.batchSize")}
                </FieldLabel>
                <Input
                  id="import-batch-size"
                  type="number"
                  min={1}
                  max={5000}
                  value={batchSize}
                  onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value) || 500))}
                  className="h-7 w-24 text-xs"
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel className="text-xs">
                  {t("import.run.onError")}
                </FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={onError}
                  onValueChange={(v) => v && setOnError(v as ImportErrorMode)}
                  className="grid w-full grid-cols-3"
                >
                  {(Object.keys(ON_ERROR_INFO) as ImportErrorMode[]).map((e) => (
                    <ToggleGroupItem key={e} value={e} className="text-xs">
                      {t(ON_ERROR_INFO[e])}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            </div>
          </FieldGroup>
        )}

        {/* ---- step 4 · run ---- */}
        {step === 4 && (
          <div className="flex flex-col gap-3">
            {run.isPending && (
              <div className="flex flex-col gap-2 rounded-md border p-3">
                <p className="flex items-center gap-1.5 text-xs">
                  <Spinner className="size-3.5" />
                  Importing…
                  {progress && ` ${progress.imported.toLocaleString()} done`}
                </p>
                <Progress
                  value={
                    progress?.totalEstimate
                      ? Math.min(100, (progress.imported / progress.totalEstimate) * 100)
                      : undefined
                  }
                />
              </div>
            )}

            {result && (
              <>
                <p className="flex items-center gap-1.5 text-xs text-success">
                  <CheckCircle2 className="size-3.5" />
                  {result.inserted.toLocaleString()} inserted ·{" "}
                  {result.skipped.toLocaleString()} skipped ·{" "}
                  {result.elapsedMs}ms
                </p>
                {result.errors.length > 0 && (
                  <div className="max-h-48 overflow-auto rounded-md border">
                    <UITable>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="h-7 w-16 text-xs">Line</TableHead>
                          <TableHead className="h-7 text-xs">Error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.errors.map((e, i) => (
                          <TableRow key={i}>
                            <TableCell className="py-1 font-mono text-xs">{e.line}</TableCell>
                            <TableCell className="py-1 text-xs text-destructive">
                              {e.message}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </UITable>
                  </div>
                )}
              </>
            )}

            {!run.isPending && !result && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                Ready to import into{" "}
                <span className="font-mono">
                  {targetDb}.{createNew ? newTableName : targetTable}
                </span>
                {mode === "replace" && " — the table will be TRUNCATED first."}
              </p>
            )}
          </div>
        )}

        <AlertDialogFooter>
          {step > 0 && (
            <Button variant="ghost" size="sm" disabled={run.isPending} onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          <span className="mr-auto self-center text-xs text-muted-foreground">
            Step {step + 1}/{STEPS.length}
          </span>
          <AlertDialogCancel disabled={run.isPending}>Close</AlertDialogCancel>
          {step < 4 ? (
            <Button
              size="sm"
              disabled={!canNext}
              onClick={() => setStep(step + 1)}
            >
              Next
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={run.isPending}
              onClick={() => run.mutate()}
              className="gap-1"
            >
              {run.isPending ? <Spinner data-icon="inline-start" /> : <FileText data-icon="inline-start" />}
              Import
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Small data hooks
// ---------------------------------------------------------------------------

function useColumns(connId: number, db: string, table: string) {
  const columns = useQuery({
    queryKey: dbKeys.columns(connId, db, table),
    queryFn: () => fetchColumns(connId, db, table),
    enabled: db !== "" && table !== "",
    staleTime: TREE_STALE_TIME,
  });

  const tables = useQuery({
    queryKey: dbKeys.tables(connId, db),
    queryFn: () => fetchTables(connId, db),
    enabled: db !== "",
    staleTime: TREE_STALE_TIME,
    select: (list) => list.filter((t) => t.kind === "table").map((t) => t.name),
  });

  return { columns, tables };
}

function PreviewGrid({
  preview,
  loading,
}: {
  preview: CsvPreview | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-1.5 p-3 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Parsing…
      </p>
    );
  }
  if (!preview) {
    return <p className="p-3 text-xs text-muted-foreground">No preview yet.</p>;
  }
  return (
    <div className="max-h-56 overflow-auto rounded-md border">
      <UITable>
        <TableHeader className="sticky top-0 bg-background">
          <TableRow>
            {preview.columns.map((c, i) => (
              <TableHead key={`${c}-${i}`} className="h-7 text-xs">
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {preview.rows.map((row, ri) => (
            <TableRow key={ri}>
              {preview.columns.map((_, ci) => (
                <TableCell key={ci} className="py-1 font-mono text-xs">
                  {row[ci] ?? <span className="italic opacity-50">NULL</span>}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </UITable>
    </div>
  );
}
