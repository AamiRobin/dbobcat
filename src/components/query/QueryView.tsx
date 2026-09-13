import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import {
  AlignLeft,
  ChevronDown,
  ChevronRight,
  Database,
  ListTree,
  PanelRight,
  Play,
  Settings2,
  TextSelect,
} from "lucide-react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { AiBar } from "@/components/ai/AiBar";
import { QueryHelpersPanel } from "@/components/query/QueryHelpersPanel";
import { QueryHistoryMenu } from "@/components/query/QueryHistoryMenu";
import { QueryResults } from "@/components/query/QueryResults";
import { dialectToFormatterLanguage } from "@/components/common/SqlCodeEditor";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { SqlEditor, type RunRequestKind } from "@/components/query/SqlEditor";
import { setActiveQueryRunner } from "@/lib/shortcuts";
import { hasImplicitCommitDdl } from "@/lib/tx-classify";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  TREE_STALE_TIME,
  dbKeys,
  fetchColumns,
  fetchDatabases,
  fetchTables,
} from "@/lib/db-queries";
import { runScript, explainScript } from "@/lib/query-queries";
import { splitStatements, statementAtOffset } from "@/lib/sql-splitter";
import { t } from "@/lib/i18n";
import { openExportDialog } from "@/stores/export-dialog";
import { log } from "@/stores/log";
import { useConnectionStore } from "@/stores/connection";
import { useTransactionStore } from "@/stores/transaction";
import {
  EMPTY_QUERY_TAB,
  useQueryEditorStore,
} from "@/stores/query-editor";
import type { Tab } from "@/stores/tabs";
import { useUiStore } from "@/stores/ui";

/** Databases that are poor autocomplete contexts, deprioritized in the picker. */
const SYSTEM_DATABASES = new Set([
  "information_schema",
  "mysql",
  "performance_schema",
  "sys",
]);

/** Above this table count, columns load per-table lazily (P3: names only). */
const EAGER_COLUMN_LIMIT = 100;

/**
 * Query tab: SQL editor on top, results below (resizable). Editor content
 * and outcomes live in the query-editor store so switching tabs never loses
 * them.
 */
export function QueryView({ tab }: { tab: Tab }) {
  const tabId = tab.id;

  // -- environment ----------------------------------------------------------
  const connId = useConnectionStore((s) => s.connId);
  const status = useConnectionStore((s) => s.status);
  const connName = useConnectionStore((s) => s.session?.name ?? "");
  const dialect = useConnectionStore((s) => s.serverInfo?.dialect ?? "mysql");
  const theme = useUiStore((s) => s.theme);
  const setDataStats = useUiStore((s) => s.setDataStats);
  const clearDataStats = useUiStore((s) => s.clearDataStats);

  const qState = useQueryEditorStore((s) => s.byTab[tabId] ?? EMPTY_QUERY_TAB);
  const patch = useQueryEditorStore((s) => s.patch);

  const [formatError, setFormatError] = useState<string | null>(null);
  const [activeResultSet, setActiveResultSet] = useState<number | null>(null);
  /** Script awaiting the "DDL will commit the transaction" confirmation. */
  const [ddlConfirmSql, setDdlConfirmSql] = useState<string | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const running = qState.running;
  const canRun = status === "connected" && connId !== null && !running;
  // The results panel hosts both run outcomes and the EXPLAIN plan view.
  const hasResults =
    qState.outcomes !== null || qState.plan !== null || qState.planLoading;

  // Clear the global status bar when this tab goes away.
  const clearOnUnmount = useRef(clearDataStats);
  clearOnUnmount.current = clearDataStats;

  // -- schema catalog for completion ---------------------------------------
  const databases = useQuery({
    queryKey: dbKeys.databases(connId ?? -1),
    queryFn: () => fetchDatabases(connId!),
    enabled: connId !== null,
    staleTime: TREE_STALE_TIME,
  });

  // Default the context to the first user database.
  const db =
    qState.db ??
    databases.data?.find((d) => !SYSTEM_DATABASES.has(d.name.toLowerCase()))?.name ??
    databases.data?.[0]?.name ??
    null;

  const tables = useQuery({
    queryKey: dbKeys.tables(connId ?? -1, db ?? ""),
    queryFn: () => fetchTables(connId!, db!),
    enabled: connId !== null && db !== null,
    staleTime: TREE_STALE_TIME,
  });

  const tableNames = useMemo(
    () => (tables.data ?? []).map((t) => t.name),
    [tables.data],
  );

  // Small schemas: describe everything once and cache for the connection.
  const eagerColumns = useQuery({
    queryKey: ["query-autocomplete-columns", connId ?? -1, db ?? ""],
    queryFn: async () => {
      const lists = await Promise.all(
        tableNames.map(async (name) => {
          try {
            return await fetchColumns(connId!, db!, name);
          } catch {
            return []; // a dropped table mid-load shouldn't kill completion
          }
        }),
      );
      return Object.fromEntries(lists.map((cols, i) => [tableNames[i], cols.map((c) => c.name)]));
    },
    enabled: connId !== null && db !== null && tableNames.length > 0 && tableNames.length <= EAGER_COLUMN_LIMIT,
    staleTime: TREE_STALE_TIME,
  });

  /** lang-sql `schema` payload; empty arrays still yield table completions. */
  const schemaMap = useMemo(() => {
    if (tableNames.length === 0) return {};
    if (tableNames.length <= EAGER_COLUMN_LIMIT) {
      return eagerColumns.data ?? Object.fromEntries(tableNames.map((n) => [n, []]));
    }
    return Object.fromEntries(tableNames.map((n) => [n, []]));
  }, [tableNames, eagerColumns.data]);

  // -- execution ------------------------------------------------------------
  /** Actual script runner, after all pre-flight gates passed. */
  const runExecution = async (trimmed: string) => {
    patch(tabId, { running: true, executedSql: trimmed });
    setDataStats({ rowsLoaded: 0, totalRowsEstimate: null, elapsedMs: null, running: true });
    const started = performance.now();

    try {
      const stopOnError = useQueryEditorStore.getState().stateFor(tabId).stopOnError;
      const outcomes = await runScript(connId!, trimmed, stopOnError, connName);
      const totalMs = Math.round(performance.now() - started);

      let errors = 0;
      let resultSets = 0;
      let lastRowCount = 0;
      let stmtNo = 0;
      for (const outcome of outcomes) {
        stmtNo += 1;
        // Full SQL logging (HeidiSQL parity): every statement lands in the
        // message log with its text attached for re-running.
        if (outcome.sql) {
          const oneLine = outcome.sql.replace(/\s+/g, " ").trim();
          const preview = oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
          log("info", `${stmtNo}. ${preview}`, outcome.sql);
        }
        switch (outcome.kind) {
          case "result_set":
            resultSets += 1;
            lastRowCount = outcome.rows.length;
            break;
          case "exec":
            break;
          case "error":
            errors += 1;
            log("error", `${outcome.message}${outcome.sqlSnippet ? ` — in: ${outcome.sqlSnippet}` : ""}`, outcome.sql);
            break;
        }
      }

      patch(tabId, {
        outcomes,
        running: false,
        totalMs,
        runNonce: useQueryEditorStore.getState().stateFor(tabId).runNonce + 1,
        // Fresh results supersede any previous plan view.
        plan: null,
      });

      if (outcomes.length === 0) {
        log("info", "Nothing to execute — the script contains no statements.");
        setDataStats({ rowsLoaded: 0, totalRowsEstimate: null, elapsedMs: totalMs });
        return;
      }

      if (errors > 0) {
        log("error", `Script finished with ${errors} error(s), ${resultSets} result set(s) — ${totalMs} ms`);
      } else {
        log("success", `${outcomes.length} statement(s) ok · ${resultSets} result set(s) · ${totalMs} ms`);
      }

      setDataStats({
        rowsLoaded: lastRowCount,
        totalRowsEstimate: null,
        elapsedMs: totalMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patch(tabId, {
        running: false,
        totalMs: Math.round(performance.now() - started),
        outcomes: [{ kind: "error", message, sqlSnippet: "" }],
      });
      log("error", `Script could not be executed: ${message}`);
      setDataStats({ rowsLoaded: 0, totalRowsEstimate: null, elapsedMs: null });
    }
  };

  /** Gate + run: warns before MySQL DDL would implicitly commit the tx. */
  const executeSql = async (sqlText: string) => {
    const trimmed = sqlText.trim();
    if (!trimmed || connId === null || running) return;

    // Transactions Phase 1: running implicit-commit DDL inside an open
    // manual transaction silently commits it — ask before sending.
    if (
      dialect === "mysql" &&
      useTransactionStore.getState().tx?.phase === "open" &&
      hasImplicitCommitDdl(
        splitStatements(trimmed).map((s) => s.text),
        "mysql",
      )
    ) {
      setDdlConfirmSql(trimmed);
      return;
    }

    await runExecution(trimmed);
  };

  /**
   * EXPLAIN every statement of the script (Heidi plan view parity).
   * Whole-script like F9; errors and non-explainable statements are reported
   * per statement inside the plan tab.
   */
  const handleExplain = async (analyze: boolean) => {
    const docSql = useQueryEditorStore.getState().stateFor(tabId).sql.trim();
    if (!docSql || connId === null || running || qState.planLoading) return;

    patch(tabId, { planLoading: true, planAnalyze: analyze });
    try {
      const plan = await explainScript(connId, docSql, analyze);
      const errors = plan.filter((s) => s.error).length;
      const skipped = plan.filter((s) => s.skipped).length;
      patch(tabId, {
        plan,
        planLoading: false,
        planNonce: useQueryEditorStore.getState().stateFor(tabId).planNonce + 1,
      });
      log(
        errors > 0 ? "error" : "success",
        `Explain${analyze ? " analyze" : ""}: ${plan.length} statement(s) · ${errors} error(s) · ${skipped} skipped`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patch(tabId, { planLoading: false });
      log("error", `Explain failed: ${message}`);
    }
  };

  // -- editor actions -------------------------------------------------------

  const handleRunRequest = (kind: RunRequestKind) => {
    if (!canRun) return;
    const docSql = useQueryEditorStore.getState().stateFor(tabId).sql;

    if (kind === "selection") {
      const view = viewRef.current;
      const selected = view
        ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
        : "";
      void executeSql(selected.trim() ? selected : docSql);
      return;
    }
    void executeSql(docSql);
  };

  const handleRunCurrentStatement = () => {
    if (!canRun) return;
    const view = viewRef.current;
    if (!view) return;
    const stmt = statementAtOffset(view.state.doc.toString(), view.state.selection.main.head);
    if (!stmt) {
      log("info", "No executable statement at the cursor.");
      return;
    }
    void executeSql(stmt.text);
  };

  // Global-shortcut bridge: F9/F5/Ctrl+Enter work even when focus is
  // outside the editor (registry stands down inside CodeMirror, so the
  // editor keymap and this runner never double-fire).
  const runRef = useRef(handleRunRequest);
  runRef.current = handleRunRequest;
  useEffect(() => {
    setActiveQueryRunner((kind) => runRef.current(kind));
    return () => setActiveQueryRunner(null);
  }, []);

  // Lazy formatter: 288KB most sessions never use, pulled on first Format.
  const handleFormat = async () => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc.toString();
    if (!doc.trim()) return;
    try {
      const { format } = await import("sql-formatter");
      const formatted = format(doc, {
        language: dialectToFormatterLanguage(dialect),
        tabWidth: 2,
        keywordCase: "upper",
      });
      // A plain dispatch keeps CodeMirror's undo history intact.
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: formatted },
      });
      setFormatError(null);
    } catch (err) {
      setFormatError(err instanceof Error ? err.message : String(err));
    }
  };

  /** History entries replace empty editors or append at the end. */
  const handleHistorySelect = (sqlText: string) => {
    const view = viewRef.current;
    if (!view) {
      patch(tabId, { sql: sqlText });
      return;
    }
    const append = view.state.doc.length > 0;
    view.dispatch({
      changes: {
        from: view.state.doc.length,
        insert: append ? `\n${sqlText}\n` : sqlText,
      },
      selection: { anchor: view.state.doc.length + (append ? 1 : sqlText.length) },
      scrollIntoView: true,
    });
  };

  /** Export the currently visible result set (rows already in memory). */
  const handleExportResults = () => {
    if (activeResultSet == null) return;
    const outcome = qState.outcomes?.[activeResultSet];
    if (!outcome || outcome.kind !== "result_set") return;
    openExportDialog({
      kind: "grid",
      connId: connId ?? -1,
      db: db ?? "",
      columns: outcome.columns.map((c) => c.name),
      rows: outcome.rows,
    });
  };

  // -- helpers panel (Phase 9-B) --------------------------------------------
  const helpersOpen = qState.helpersOpen;
  const insertAtCursorFromView = (text: string) => {
    const view = viewRef.current;
    if (!view || !text) return;
    view.dispatch({
      changes: { from: view.state.selection.main.from, to: view.state.selection.main.to, insert: text },
      selection: { anchor: view.state.selection.main.from + text.length },
      scrollIntoView: true,
    });
    view.focus();
  };
  /** Whole-document replacement (AI draft "Replace editor" action). */
  const replaceWholeDoc = (text: string) => {
    const view = viewRef.current;
    if (!view || !text) {
      patch(tabId, { sql: text });
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
      scrollIntoView: true,
    });
    view.focus();
  };
  const getEditorSelection = () => {
    const view = viewRef.current;
    if (!view) return "";
    return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
  };

  /** First error of the last run — feeds the AI bar's "Fix with AI". */
  const lastErrorOutcome = useMemo(() => {
    const error = qState.outcomes?.find((o) => o.kind === "error");
    if (!error || error.kind !== "error") return null;
    return { message: error.message, sql: error.sql ?? null };
  }, [qState.outcomes]);

  const hasVisibleResultSet =
    activeResultSet != null &&
    qState.outcomes?.[activeResultSet]?.kind === "result_set";

  const statementCount = qState.executedSql
    ? splitStatements(qState.executedSql).length
    : 0;

  // Clear the global status bar defaults when this tab unmounts.
  useEffect(() => () => clearOnUnmount.current(), []);

  const ddlCommitCount = ddlConfirmSql
    ? splitStatements(ddlConfirmSql).filter((s) =>
        hasImplicitCommitDdl([s.text], "mysql"),
      ).length
    : 0;

  // -- render ---------------------------------------------------------------
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* toolbar; overflow-x so narrow windows scroll instead of crushing
          the right-side labels into multi-line blobs */}
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/40 px-1">
        {/* Run split: primary runs the whole script; alternates in the menu. */}
        <ButtonGroup className="h-6 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                className="rounded-r-none"
                disabled={!canRun}
                onClick={() => handleRunRequest("all")}
              >
                {running ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
                Run
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run whole script (F9)</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="rounded-l-none px-0.5"
                disabled={!canRun}
                aria-label="More ways to run"
              >
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                <DropdownMenuItem className="text-xs" onClick={() => handleRunRequest("selection")}>
                  <TextSelect data-icon="inline-start" />
                  Run selection
                </DropdownMenuItem>
                <DropdownMenuItem className="text-xs" onClick={handleRunCurrentStatement}>
                  <ChevronRight data-icon="inline-start" />
                  Current statement
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" disabled={!canRun}>
                  <ListTree data-icon="inline-start" />
                  Explain
                  <ChevronDown className="ml-0.5 size-3 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Query plan for the whole script</TooltipContent>
          </Tooltip>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuItem className="text-xs" onClick={() => void handleExplain(false)}>
                <ListTree className="size-3.5" />
                Explain
              </DropdownMenuItem>
              <DropdownMenuItem className="text-xs" onClick={() => void handleExplain(true)}>
                <ListTree className="size-3.5" />
                Explain Analyze
                <span className="ml-1 text-muted-foreground">— executes the statement</span>
              </DropdownMenuItem>

            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="xs" disabled={running} onClick={handleFormat}>
              <AlignLeft data-icon="inline-start" />
              Format
            </Button>
          </TooltipTrigger>
          <TooltipContent>Format SQL</TooltipContent>
        </Tooltip>

        <QueryHistoryMenu onSelect={handleHistorySelect} />

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={helpersOpen ? "secondary" : "ghost"}
                size="icon-xs"
                aria-pressed={helpersOpen}
                aria-label={t("helpers.open")}
                onClick={() => patch(tabId, { helpersOpen: !helpersOpen })}
              >
                <PanelRight />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("helpers.open")}</TooltipContent>
          </Tooltip>

          {formatError && (
            <span className="max-w-64 truncate text-xs text-destructive">
              Format: {formatError}
            </span>
          )}

          <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
            <Database className="size-3.5" />
            <Select
              value={db ?? ""}
              onValueChange={(next) => patch(tabId, { db: next })}
            >
              <SelectTrigger size="sm" className="h-6 w-44 gap-1 px-2 text-xs" aria-label="Completion database">
                {db ?? (databases.isLoading ? "Loading…" : "no database")}
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(databases.data ?? []).map((d) => (
                    <SelectItem key={d.name} value={d.name} className="text-xs">
                      {d.name}
                    </SelectItem>
                  ))}

                </SelectGroup>
              </SelectContent>
            </Select>
          </label>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="Query settings" className="relative">
                <Settings2 />
                {qState.stopOnError && (
                  <span
                    aria-hidden
                    className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary"
                  />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-3">
              <label className="flex items-center justify-between gap-3 text-xs">
                Stop on error
                <Switch
                  checked={qState.stopOnError}
                  onCheckedChange={(checked) => patch(tabId, { stopOnError: checked })}
                  aria-label="Stop on error"
                />
              </label>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* editor + results (+ optional helpers panel on the right) */}
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
          <ResizablePanel minSize="40" className="min-w-0">
            <div className="h-full min-h-0">
              <ResizablePanelGroup
                key={hasResults ? "split" : "full"}
                orientation="vertical"
                className="h-full min-h-0"
              >
                <ResizablePanel defaultSize={hasResults ? "55" : "100"} minSize="15" className="min-h-0">
                  <div className="flex h-full min-h-0 flex-col overflow-hidden">
                    <AiBar
                      tabId={tab.id}
                      connId={connId}
                      db={db}
                      dialect={dialect}
                      lastError={lastErrorOutcome}
                      insertText={insertAtCursorFromView}
                      replaceDoc={replaceWholeDoc}
                      getSelection={getEditorSelection}
                      getDoc={() => viewRef.current?.state.doc.toString() ?? qState.sql}
                      hasEditorSql={
                        (viewRef.current?.state.doc.length ?? qState.sql.length) > 0
                      }
                    />
                    <SqlEditor
                      value={qState.sql}
                      onChange={(value) => patch(tabId, { sql: value })}
                      theme={theme}
                      schema={schemaMap}
                      dialect={dialect}
                      onRequestRun={handleRunRequest}
                      onViewReady={(view) => {
                        viewRef.current = view;
                      }}
                    />
                  </div>
                </ResizablePanel>

                {hasResults && (
                  <>
                    <ResizableHandle />
                    <ResizablePanel defaultSize="45" minSize="8" className="min-h-0">
                      <QueryResults
                        tabId={tabId}
                        outcomes={qState.outcomes ?? []}
                        statementCount={statementCount}
                        totalMs={qState.totalMs}
                        runNonce={qState.runNonce}
                        onActiveResultSetChange={setActiveResultSet}
                        connId={connId}
                        dbContext={db}
                        onExport={handleExportResults}
                        canExport={hasVisibleResultSet}
                        plan={qState.plan}
                        planLoading={qState.planLoading}
                        planAnalyze={qState.planAnalyze}
                        planNonce={qState.planNonce}
                      />
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>
            </div>
          </ResizablePanel>

          {helpersOpen && (
            <>
              <ResizableHandle />
              <ResizablePanel defaultSize="24" minSize="14" className="min-w-52">
                {connId !== null && (
                  <QueryHelpersPanel
                    connId={connId}
                    dialect={dialect}
                    db={db}
                    databases={(databases.data ?? []).map((d) => ({ name: d.name }))}
                    onDbChange={(next) => patch(tabId, { db: next })}
                    insertText={insertAtCursorFromView}
                    getSelection={getEditorSelection}
                  />
                )}
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>

      {/* Transactions Phase 1: implicit-commit DDL warning */}
      <ConfirmDialog
        open={ddlConfirmSql !== null}
        onOpenChange={(next) => !next && setDdlConfirmSql(null)}
        title={t("tx.ddlWarning.title")}
        description={t("tx.ddlWarning.body", { count: ddlCommitCount })}
        confirmLabel={t("tx.ddlWarning.confirm")}
        destructive
        onConfirm={() => {
          const sql = ddlConfirmSql;
          setDdlConfirmSql(null);
          if (sql) void runExecution(sql);
        }}
      />
    </div>
  );
}
