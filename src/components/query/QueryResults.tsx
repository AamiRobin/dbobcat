import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";

import { QueryResultGrid } from "@/components/query/QueryResultGrid";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatElapsed } from "@/lib/query-queries";
import { cn } from "@/lib/utils";
import type { QueryOutcome } from "@/types/ipc";

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
}

const RESULT_LINE_CLASS = "text-muted-foreground";
const ERROR_CLASS = "text-destructive";

/**
 * Bottom half of a query tab: a "Messages" summary plus one virtualized
 * read-only grid per returned result set.
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

  useEffect(() => {
    const match = /^res-(\d+)$/.exec(activeTab);
    onActiveResultSetChange?.(match ? Number(match[1]) : null);
  }, [activeTab, onActiveResultSetChange]);

  const errorCount = outcomes.filter((o) => o.kind === "error").length;

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
          {resultSetIndexes.map((idx) => (
            <TabsTrigger key={idx} value={`res-${idx}`} className="text-xs">
              Result {(resultSetIndexes.indexOf(idx) + 1).toLocaleString()}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent value="messages" className="min-h-0 data-[state=inactive]:hidden">
        <ScrollArea className="h-full">
          <div className="px-3 py-2 font-mono text-[11px] leading-relaxed">
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
