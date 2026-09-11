import { useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  ClipboardCopy,
  CornerDownLeft,
  Eraser,
  Pause,
  Replace,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildSchemaContext, looksLikeSql, stripCodeFence } from "@/lib/ai-context";
import {
  cancelAi,
  fetchDiagramColumnsForAi,
  fetchDiagramForeignKeysForAi,
  runAgent,
  runAi,
} from "@/lib/ai-queries";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { setAiBarFocus } from "@/lib/shortcuts";
import { agentSession, openAiSettings, aiReady, useAiAgentStore, useAiStore } from "@/stores/ai";
import type { AgentChatEntry } from "@/stores/ai";
import { log } from "@/stores/log";
import type {
  AgentEvent,
  AgentResume,
  AgentRunResult,
  AgentWireMessage,
  AiJob,
  AiMode,
  SqlDialect,
} from "@/types/ipc";

/**
 * The AI bar (Phase 12): a prompt strip above the query editor.
 *
 * Contract: the assistant DRAFTS, the human RUNS. Generated SQL lands in a
 * preview with explicit Insert / Replace actions and is never executed or
 * inserted automatically. The context sent to the model is built by
 * `ai-context.ts` — schema metadata and the user's SQL only, never row
 * data — and the note in the corner of every preview says so.
 *
 * Agent mode (Phase 13): the model may inspect the schema and run
 * statements itself. Read-only statements execute automatically; writes
 * and DDL pause the agent until the user confirms — the confirmation is
 * bound to the connection + database + exact SQL backend-side, so it can
 * never fire against a different target.
 */

interface AiBarProps {
  /** Owning tab, for per-tab agent sessions. */
  tabId: string;
  /** Active connection; null while the tab is disconnected. */
  connId: number | null;
  db: string | null;
  dialect: SqlDialect;
  /** Last failed statement of this tab, for the "Fix with AI" action. */
  lastError: { message: string; sql: string | null } | null;
  /** Insert a draft at the editor cursor (replaces the selection). */
  insertText: (text: string) => void;
  /** Replace the whole editor document (keeps undo history). */
  replaceDoc: (text: string) => void;
  getSelection: () => string;
  getDoc: () => string;
  /** Editor non-empty? (render-time, from doc length — no toString) */
  hasEditorSql: boolean;
}

type Phase = "idle" | "streaming" | "done" | "error";

/** Monotonic job ids so an in-flight job can be cancelled by id. */
let nextJobId = 1;

export function AiBar({
  tabId,
  connId,
  db,
  dialect,
  lastError,
  insertText,
  replaceDoc,
  getSelection,
  getDoc,
  hasEditorSql,
}: AiBarProps) {
  const queryClient = useQueryClient();

  const enabled = useAiStore((s) => s.enabled);
  const baseUrl = useAiStore((s) => s.baseUrl);
  const model = useAiStore((s) => s.model);
  const keyHint = useAiStore((s) => s.keyHint);

  const agentMode = useAiAgentStore((s) => s.byTab[tabId]?.agentMode ?? false);
  const session = useAiAgentStore((s) => agentSession(s.byTab, tabId));
  const patchAgent = useAiAgentStore((s) => s.patch);
  const clearAgent = useAiAgentStore((s) => s.clear);

  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<AiMode>("generate");
  const [output, setOutput] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const jobIdRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ready = aiReady({ enabled, baseUrl, model, keyHint });
  // Composed busy: local phase + store flag (the store survives the
  // hasResults remount, where local phase resets to idle).
  const busy = phase === "streaming" || session.running;

  // Abort an in-flight job when the tab (and this bar) goes away — no
  // silent token burn in the background. EXCEPTION: a running agent is
  // store-backed and survives QueryView's layout remount (`hasResults`
  // key flip), so it keeps streaming into the reattached bar.
  useEffect(
    () => () => {
      if (jobIdRef.current === null) return;
      const agentRunning =
        useAiAgentStore.getState().byTab[tabId]?.running ?? false;
      if (!agentRunning) void cancelAi(jobIdRef.current);
    },
    [],
  );

  const focusInput = () => inputRef.current?.focus();
  useEffect(() => {
    // Mod+I lands here from the global shortcuts registry (see
    // shortcuts.ts) — same latest-wins bridge as the query runner.
    setAiBarFocus(focusInput);
    return () => setAiBarFocus(null);
  }, []);

  const run = (job: AiJob) => {
    if (!ready || busy) return;
    const jobId = nextJobId++;
    jobIdRef.current = jobId;
    setMode(job.mode);
    setPhase("streaming");
    setOutput("");
    setErrorMsg(null);

    const config = { baseUrl: baseUrl.trim(), model: model.trim() };
    void runAi(jobId, config, job, (delta) => {
      setOutput((prev) => prev + delta);
    })
      .then((result) => {
        setPhase("done");
        setOutput(result.text);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("cancelled:")) {
          setPhase("idle");
          log("info", "AI request cancelled.");
        } else {
          setPhase("error");
          setErrorMsg(message);
          log("error", `AI request failed: ${message}`);
        }
      })
      .finally(() => {
        jobIdRef.current = null;
      });
  };

  /** Fetch (and cache) the schema context for the current database. */
  const schemaContext = async (): Promise<string> => {
    if (connId === null || db === null) return "";
    const [tables, fks] = await Promise.all([
      fetchDiagramColumnsForAi(queryClient, connId, db),
      fetchDiagramForeignKeysForAi(queryClient, connId, db),
    ]);
    return buildSchemaContext(db, dialect, tables, fks);
  };

  const handleAsk = () => {
    const request = prompt.trim();
    if (!request || connId === null) return;
    if (!ready) {
      openAiSettings();
      return;
    }
    if (phase === "streaming") return;
    void schemaContext()
      .then((schema) => {
        run({
          mode: "generate",
          dialect,
          database: db,
          schema,
          prompt: request,
        });
      })
      .catch((err: unknown) => {
        setPhase("error");
        setErrorMsg(err instanceof Error ? err.message : String(err));
      });
    setPrompt("");
  };

  const handleFix = () => {
    if (!lastError || connId === null || !ready || busy) return;
    void schemaContext()
      .then((schema) => {
        run({
          mode: "fix",
          dialect,
          database: db,
          schema,
          sql: lastError.sql ?? getDoc(),
          error: lastError.message,
        });
      })
      .catch((err: unknown) => {
        setPhase("error");
        setErrorMsg(err instanceof Error ? err.message : String(err));
      });
  };

  const handleExplain = () => {
    if (connId === null || !ready || busy) return;
    const sql = getSelection().trim() || getDoc().trim();
    if (!sql) return;
    run({ mode: "explain", dialect, database: db, sql });
  };

  const handleStop = () => {
    // The store id survives hasResults remounts; the ref covers one-shot jobs.
    const agentJobId = agentSession(useAiAgentStore.getState().byTab, tabId).jobId;
    if (agentJobId !== null && agentJobId !== undefined) void cancelAi(agentJobId);
    if (jobIdRef.current !== null) void cancelAi(jobIdRef.current);
  };

  const handleInsert = () => {
    const draft = draftText(mode, output);
    if (!draft) return;
    insertText(draft);
    reset();
  };

  const handleReplace = () => {
    const draft = draftText(mode, output);
    if (!draft) return;
    replaceDoc(draft);
    reset();
  };

  const reset = () => {
    setPhase("idle");
    setOutput("");
    setErrorMsg(null);
  };

  // -- agent mode (Phase 13) --------------------------------------------------


  /**
   * One agent invocation. On `awaiting_confirmation` the backend stops with
   * the exact SQL; the Confirm / Decline buttons resume the same
   * conversation with (or without) a target-bound grant.
   */
  const runAgentTurn = (options: { userText?: string; resume?: AgentResume }) => {
    if (!ready || connId === null || db === null || busy) return;
    const jobId = nextJobId++;
    jobIdRef.current = jobId;
    setPhase("streaming");
    setErrorMsg(null);
    patchAgent(tabId, { running: true, error: null, jobId });

    const current = agentSession(useAiAgentStore.getState().byTab, tabId);
    const messages: AgentWireMessage[] = [...current.messages];
    if (options.userText !== undefined) {
      messages.push({ role: "user", content: options.userText });
    }
    const entries: AgentChatEntry[] = [...current.entries];
    if (options.userText !== undefined) {
      entries.push({ kind: "user", text: options.userText });
    }
    let streamIndex: number | null = null;

    const applyEvent = (event: AgentEvent) => {
      if (event.kind === "text_delta") {
        if (streamIndex === null) {
          entries.push({ kind: "assistant", text: event.delta });
          streamIndex = entries.length - 1;
        } else {
          entries[streamIndex] = {
            ...entries[streamIndex],
            text: entries[streamIndex].text + event.delta,
          };
        }
      } else if (event.kind === "tool_start") {
        entries.push({ kind: "tool", text: `${event.name}…` });
        // A tool turn ends the current assistant text block: the model's
        // post-tool narration is its own entry, not a continuation.
        streamIndex = null;
      } else if (event.kind === "tool_end") {
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].kind === "tool" && entries[i].text === `${event.name}…`) {
            entries[i] = { kind: "tool", text: `${event.name}: ${event.summary}`, ok: event.ok };
            break;
          }
        }
        streamIndex = null;
      } else {
        entries.push({ kind: "notice", text: event.message });
      }
      // Publish every mutation so the log streams live instead of
      // appearing all at once when the run finishes.
      patchAgent(tabId, { entries: [...entries] });
    };

    const finish = (result: AgentRunResult) => {
      if (result.status === "awaiting_confirmation" && result.pending) {
        entries.push({
          kind: "notice",
          text: `${t("ai.agent.wantsToRun")} ${result.pending.sql}`,
        });
      }
      // Final text guard: keep the log consistent even if a provider
      // delivered the answer without streaming deltas.
      if (result.status === "done" && result.text) {
        const last = entries[entries.length - 1];
        if (last?.kind !== "assistant" || last.text !== result.text) {
          entries.push({ kind: "assistant", text: result.text });
        }
      }
      patchAgent(tabId, {
        messages: result.messages,
        entries,
        running: false,
        pending: result.pending ?? null,
        lastResult: result,
      });
      if (result.status === "done") {
        setOutput(result.text);
        setPhase("done");
      } else if (result.status === "cancelled") {
        setPhase("idle");
      } else {
        setPhase("idle");
      }
    };

    const config = { baseUrl: baseUrl.trim(), model: model.trim() };
    // Schema context rides along on every run; React Query keeps it cached.
    void schemaContext()
      .then((schema) =>
        runAgent(
          jobId,
          config,
          {
            connId,
            db,
            dialect,
            schema,
            request: {
              messages,
              resume: options.resume ?? null,
            },
          },
          applyEvent,
        ),
      )
      .then(finish)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("cancelled:")) {
          setPhase("idle");
          log("info", "AI agent cancelled.");
        } else {
          setPhase("error");
          setErrorMsg(message);
          log("error", `AI agent failed: ${message}`);
        }
        // Cancelled or failed: the log must not sit on "Thinking…" forever.
        patchAgent(tabId, {
          running: false,
          error: message.startsWith("cancelled:") ? null : message,
        });
      })
      .finally(() => {
        jobIdRef.current = null;
        patchAgent(tabId, { jobId: null });
      });
  };

  const handleAgentSubmit = () => {
    const request = prompt.trim();
    if (!request || connId === null || db === null) return;
    if (!ready) {
      openAiSettings();
      return;
    }
    if (busy || session.pending) return;
    setPrompt("");
    runAgentTurn({ userText: request });
  };

  const confirmPending = () => {
    const pending = session.pending;
    if (!pending) return;
    patchAgent(tabId, { pending: null });
    runAgentTurn({
      resume: {
        approved: true,
        call: pending.call,
        // Snapshot from PAUSE time (carried by the backend) — never from
        // current props, or a mid-dialog connection switch would rebind
        // the approval to another target.
        grant: { sql: pending.sql, connId: pending.connId, db: pending.db },
      },
    });
  };

  // The store flag survives the hasResults remount; the local phase does
  // not. Both must agree before the UI treats an agent run as idle.
  const streaming = busy;
  const isProse = mode === "explain";

  return (
    <div className="shrink-0 border-b bg-muted/20">
      <div className="flex h-9 items-center gap-1 px-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(enabled && "text-primary")}
              aria-label={t("ai.bar.title")}
              onClick={() => openAiSettings()}
            >
              <Sparkles />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("ai.bar.setup")}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(agentMode && "text-primary")}
              aria-pressed={agentMode}
              aria-label={t("ai.agent.toggle")}
              disabled={!enabled}
              onClick={() => patchAgent(tabId, { agentMode: !agentMode })}
            >
              <Bot />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("ai.agent.toggleHint")}</TooltipContent>
        </Tooltip>

        <Input
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (agentMode) handleAgentSubmit();
              else handleAsk();
            }
          }}
          disabled={!enabled || connId === null}
          className="h-6 flex-1 border-none bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
          placeholder={
            !enabled
              ? t("ai.bar.disabled")
              : connId === null
                ? t("ai.bar.needConnection")
                : t("ai.bar.placeholder")
          }
          aria-label={t("ai.bar.title")}
        />

        {lastError && (
          <Button variant="ghost" size="xs" disabled={!ready || streaming} onClick={handleFix}>
            <Wrench data-icon="inline-start" />
            {t("ai.bar.fix")}
          </Button>
        )}
        {hasEditorSql && (
          <Button variant="ghost" size="xs" disabled={!ready || streaming} onClick={handleExplain}>
            {t("ai.bar.explain")}
          </Button>
        )}

        {streaming ? (
          <Button variant="secondary" size="xs" onClick={handleStop}>
            <Pause data-icon="inline-start" />
            {t("ai.bar.stop")}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="xs"
            disabled={!prompt.trim()}
            onClick={agentMode ? handleAgentSubmit : handleAsk}
            aria-label={t("ai.bar.run")}
          >
            <CornerDownLeft data-icon="inline-start" />
            {t("ai.bar.run")}
          </Button>
        )}
      </div>

      {!agentMode && (phase === "streaming" || phase === "done" || phase === "error") && (
        <div className="border-t px-2 py-1.5">
          {phase === "error" ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-destructive">{errorMsg}</span>
              <Button variant="ghost" size="xs" onClick={reset}>
                <Eraser data-icon="inline-start" />
                {t("ai.bar.discard")}
              </Button>
            </div>
          ) : (
            <>
              <div className="max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
                {output || `${t("ai.bar.thinking")}`}
              </div>
              {!streaming && (
                <div className="mt-1.5 flex items-center gap-1">
                  {!isProse && (
                    <>
                      <Button variant="secondary" size="xs" onClick={handleInsert}>
                        {t("ai.bar.insert")}
                      </Button>
                      <Button variant="outline" size="xs" onClick={handleReplace}>
                        <Replace data-icon="inline-start" />
                        {t("ai.bar.replace")}
                      </Button>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void navigator.clipboard.writeText(output)}
                  >
                    <ClipboardCopy data-icon="inline-start" />
                    {t("ai.bar.copy")}
                  </Button>
                  <Button variant="ghost" size="xs" onClick={reset}>
                    {t("ai.bar.discard")}
                  </Button>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {t("ai.bar.privacy")}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ---- agent conversation log + confirmation ---- */}
      {agentMode && (
        <div className="border-t px-2 py-1.5">
          {session.entries.length > 0 && (
            <div className="max-h-52 overflow-y-auto">
              {session.entries.map((entry, i) => (
                <div key={i} className="flex items-start gap-1.5 py-0.5 text-xs">
                  <span
                    className={cn(
                      "mt-0.5 w-12 shrink-0 text-right text-[10px] uppercase tracking-wide",
                      entry.kind === "user" && "text-primary",
                      entry.kind === "assistant" && "text-muted-foreground",
                      entry.kind === "tool" && (entry.ok === false ? "text-destructive" : "text-muted-foreground/60"),
                      entry.kind === "notice" && "text-warning",
                    )}
                  >
                    {entry.kind === "user"
                      ? t("ai.agent.you")
                      : entry.kind === "assistant"
                        ? t("ai.agent.assistant")
                        : entry.kind === "tool"
                          ? t("ai.agent.tool")
                          : t("ai.agent.notice")}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 whitespace-pre-wrap",
                      entry.kind === "tool" && "font-mono text-[11px] text-muted-foreground",
                      entry.kind !== "assistant" && entry.kind !== "tool" && "text-muted-foreground",
                    )}
                  >
                    {entry.text}
                  </span>
                </div>
              ))}
              {session.running && (
                <div className="py-0.5 text-xs text-muted-foreground">{t("ai.bar.thinking")}</div>
              )}
              {session.error && !session.running && (
                <div className="py-0.5 text-xs text-destructive">{session.error}</div>
              )}
              {session.entries.length > 0 && !session.running && (
                <div className="mt-1 flex items-center gap-1">
                  {phase === "done" &&
                    output.trim() &&
                    looksLikeSql(stripCodeFence(output)) && (
                    <>
                      <Button variant="secondary" size="xs" onClick={handleInsert}>
                        {t("ai.bar.insert")}
                      </Button>
                      <Button variant="outline" size="xs" onClick={handleReplace}>
                        <Replace data-icon="inline-start" />
                        {t("ai.bar.replace")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => void navigator.clipboard.writeText(output)}
                      >
                        <ClipboardCopy data-icon="inline-start" />
                        {t("ai.bar.copy")}
                      </Button>
                    </>
                  )}
                  <Button variant="ghost" size="xs" onClick={() => clearAgent(tabId)}>
                    <Eraser data-icon="inline-start" />
                    {t("ai.agent.clear")}
                  </Button>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {t("ai.agent.privacy")}
                  </span>
                </div>
              )}
            </div>
          )}
          {session.running && session.entries.length === 0 && (
            <div className="py-1 text-xs text-muted-foreground">{t("ai.bar.thinking")}</div>
          )}
        </div>
      )}

      {/* Write confirmation: the grant binds to connection + db + exact SQL. */}
      <ConfirmDialog
        open={session.pending !== null}
        onOpenChange={(open) => {
          // Dismissing (ESC / close) drops the request locally at zero
          // cost — the conversation stays at its pre-pause state.
          if (!open) patchAgent(tabId, { pending: null });
        }}
        title={t("ai.agent.confirmTitle", {
          risk: session.pending?.risk ?? "write",
        })}
        description={
          <>
            {t("ai.agent.confirmBody", {
              risk: session.pending?.risk ?? "write",
            })}{" "}
            <span className="font-mono">
              {session.pending?.db ?? db ?? "?"} @ #
              {session.pending?.connId ?? connId ?? "?"}
            </span>
            <pre className="mt-1.5 max-h-32 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px]">
              {session.pending?.sql ?? ""}
            </pre>
          </>
        }
        confirmLabel={t("ai.agent.confirmRun")}
        secondaryLabel={t("ai.agent.decline")}
        onSecondary={() => {
          const pending = session.pending;
          if (!pending) return;
          patchAgent(tabId, { pending: null });
          runAgentTurn({
            resume: { approved: false, call: pending.call },
          });
        }}
        destructive={session.pending?.risk !== "unknown"}
        onConfirm={confirmPending}
      />
    </div>
  );
}

/** Clean a finished draft for insertion: fences off, whitespace trimmed. */
function draftText(mode: AiMode, output: string): string {
  if (mode === "explain") return output.trim();
  return stripCodeFence(output);
}
