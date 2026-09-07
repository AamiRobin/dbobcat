import { useEffect, useState } from "react";
import { Download, ListTree, MessageSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { QueryResultGrid } from "@/components/query/QueryResultGrid";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cellDisplayText } from "@/lib/grid-columns";
import { formatElapsed } from "@/lib/query-queries";
import { cn } from "@/lib/utils";
import type { ExplainStatement, QueryOutcome } from "@/types/ipc";

interface QueryResultsProps {
  tabId: string;
  outcomes: QueryOutcome[];
  /** Number of statements the executed script contained. */
  statementCount: number;
  totalMs: number | null;
  /** Bumped on every run so result-tab focus resets to the first set. */
  runNonce: number;
  /** Notifies the parent which result-set outcome is visible (export). */
  onActiveResultSetChange?: (outcomeIndex: number | null) => void;
  /** Connection + database context for updatable result grids (Phase 9-A). */
  connId: number | null;
  dbContext: string | null;
  /** EXPLAIN output of the last explain request (Plan tab). */
  plan: ExplainStatement[] | null;
  planLoading: boolean;
  planAnalyze: boolean;
  /** Bumped on every completed explain — focuses the plan tab. */
  planNonce: number;
  /** Exports the visible result set (lives on the results strip). */
  onExport?: () => void;
  /** Whether a result set is showing to export. */
  canExport?: boolean;
}

const RESULT_LINE_CLASS = "text-muted-foreground";
const ERROR_CLASS = "text-destructive";

/**
 * Bottom half of a query tab: a "Messages" summary, one virtualized
 * read-only grid per returned result set, and an EXPLAIN "Plan" tab.
 */
export function QueryResults({
  tabId,
  outcomes,
  statementCount,
  totalMs,
  runNonce,
  onActiveResultSetChange,
  connId,
  dbContext,
  plan,
  planLoading,
  planAnalyze,
  planNonce,
  onExport,
  canExport,
}: QueryResultsProps) {
  const resultSetIndexes = outcomes
    .map((o, i) => (o.kind === "result_set" ? i : -1))
    .filter((i) => i >= 0);

  const [activeTab, setActiveTab] = useState<string>(() =>
    resultSetIndexes.length > 0 ? `res-${resultSetIndexes[0]}` : "messages",
  );

  // A new run resets focus: first result set if any, else messages. Also
  // re-syncs when the result-set count changes without a nonce bump (e.g.
  // streaming outcomes arriving), so a dangling res-N value can't persist.
  const firstResultSet = resultSetIndexes.length > 0 ? `res-${resultSetIndexes[0]}` : "messages";
  useEffect(() => {
    setActiveTab(firstResultSet);
  }, [runNonce, firstResultSet]);

  // A completed explain pulls focus to the plan tab.
  useEffect(() => {
    if (planNonce > 0) setActiveTab("plan");
  }, [planNonce]);

  useEffect(() => {
    const match = /^res-(\d+)$/.exec(activeTab);
    onActiveResultSetChange?.(match ? Number(match[1]) : null);
  }, [activeTab, onActiveResultSetChange]);

  const errorCount = outcomes.filter((o) => o.kind === "error").length;
  const showPlanTab = planLoading || plan !== null;

  return (
    <Tabs
      value={activeTab}
      onValueChange={setActiveTab}
      className="flex h-full min-h-0 gap-2"
    >
      <div className="flex h-8 w-full shrink-0 items-center border-b bg-muted/40 px-1">
        <TabsList variant="line" className="h-7">
          <TabsTrigger value="messages" className="gap-1 text-xs">
            <MessageSquare className="size-3 text-muted-foreground" />
            Messages
            {errorCount > 0 && (
              <span className={cn("ml-1 font-semibold", ERROR_CLASS)}>({errorCount})</span>
            )}
          </TabsTrigger>
          {showPlanTab && (
            <TabsTrigger value="plan" className="gap-1 text-xs">
              <ListTree className="size-3 text-muted-foreground" />
              Plan
              {planAnalyze && <span className="ml-1 text-muted-foreground">(analyze)</span>}
            </TabsTrigger>
          )}
          {resultSetIndexes.map((idx) => (
            <TabsTrigger key={idx} value={`res-${idx}`} className="text-xs">
              Result {(resultSetIndexes.indexOf(idx) + 1).toLocaleString()}
            </TabsTrigger>
          ))}
        </TabsList>
        {onExport && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto mr-0.5"
            disabled={!canExport}
            onClick={onExport}
          >
            <Download data-icon="inline-start" />
            Export
          </Button>
        )}
      </div>

      <TabsContent value="messages" className="min-h-0 data-[state=inactive]:hidden">
        <ScrollArea className="h-full">
          <div className="px-3 py-2 font-mono text-xs leading-relaxed">
            {outcomes.length === 0 && (
              <p className={RESULT_LINE_CLASS}>Nothing executed yet.</p>
            )}
            {outcomes.map((outcome, idx) => (
              <OutcomeLine key={idx} outcome={outcome} index={idx} />
            ))}
            {outcomes.length > 0 && (
              <p className="mt-2 border-t pt-2 text-foreground/80">
                {statementCount.toLocaleString()} statement
                {statementCount === 1 ? "" : "s"} executed ·{" "}
                {errorCount === 0 ? (
                  <span className="text-success">no errors</span>
                ) : (
                  <span className={ERROR_CLASS}>
                    {errorCount} error{errorCount === 1 ? "" : "s"}
                  </span>
                )}{" "}
                · {formatElapsed(totalMs)} total
              </p>
            )}
          </div>
        </ScrollArea>
      </TabsContent>

      {showPlanTab && (
        <TabsContent value="plan" className="min-h-0 data-[state=inactive]:hidden">
          <PlanView plan={plan} loading={planLoading} analyze={planAnalyze} />
        </TabsContent>
      )}

      {resultSetIndexes.map((idx) => {
        const outcome = outcomes[idx];
        if (outcome.kind !== "result_set") return null;
        return (
          <TabsContent
            key={idx}
            value={`res-${idx}`}
            className="min-h-0 data-[state=inactive]:hidden"
          >
            <QueryResultGrid
              tabId={tabId}
              resultIndex={idx}
              result={outcome}
              connId={connId}
              dbContext={dbContext}
            />
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

/** Plan statements: source SQL, per-statement status, engine plan table. */
function PlanView({
  plan,
  loading,
  analyze,
}: {
  plan: ExplainStatement[] | null;
  loading: boolean;
  analyze: boolean;
}) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-4" />
        Explaining script…
      </div>
    );
  }
  if (!plan || plan.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No plan.
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-3">
        {plan.map((stmt, i) => (
          <PlanStatement key={i} stmt={stmt} index={i} analyze={analyze} />
        ))}
      </div>
    </ScrollArea>
  );
}

function PlanStatement({
  stmt,
  index,
  analyze,
}: {
  stmt: ExplainStatement;
  index: number;
  analyze: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-2 py-1.5">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          #{index + 1}
        </span>
        <code className="min-w-0 flex-1 truncate font-mono text-xs" title={stmt.sourceSql}>
          {stmt.sourceSql}
        </code>
        {stmt.skipped ? (
          <span className="shrink-0 text-xs text-muted-foreground">{stmt.note}</span>
        ) : stmt.error ? (
          <span className="shrink-0 text-xs text-destructive">{stmt.error}</span>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">
            {analyze ? "analyzed" : "planned"} · {formatElapsed(stmt.elapsedMs)}
          </span>
        )}
      </div>
      {!stmt.skipped && !stmt.error && stmt.columns && (
        <table className="w-full border-collapse font-mono text-xs">
          <thead>
            <tr className="border-b bg-muted/20 text-left text-muted-foreground">
              {stmt.columns.map((col) => (
                <th key={col} className="px-2 py-1 font-medium">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stmt.rows.map((row, r) => (
              <tr key={r} className="border-b last:border-b-0">
                {row.map((cell, c) => (
                  <td key={c} className="max-w-96 truncate px-2 py-1 align-top">
                    {cellDisplayText(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OutcomeLine({ outcome, index }: { outcome: QueryOutcome; index: number }) {
  const label = `Statement ${index + 1}`;
  switch (outcome.kind) {
    case "result_set":
      return (
        <p className="text-success">
          {label} — ok · {outcome.rows.length.toLocaleString()} row
          {outcome.rows.length === 1 ? "" : "s"} · {formatElapsed(outcome.elapsedMs)}
          {outcome.truncated && " · truncated at backend cap"}
        </p>
      );
    case "exec":
      return (
        <p className={RESULT_LINE_CLASS}>
          {label} — ok · {outcome.affected.toLocaleString()} row
          {outcome.affected === 1 ? "" : "s"} affected
          {outcome.info ? ` (${outcome.info})` : ""} · {formatElapsed(outcome.elapsedMs)}
          {outcome.lastInsertId != null && ` · insert id ${outcome.lastInsertId}`}
        </p>
      );
    case "error":
      return (
        <div className={ERROR_CLASS}>
          <p>{label} — error</p>
          <p className="font-semibold">{outcome.message}</p>
          {outcome.sqlSnippet && (
            <p className="pl-3 text-destructive/80">
              in: {outcome.sqlSnippet}
            </p>
          )}
        </div>
      );
  }
}
