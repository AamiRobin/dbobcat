import { useQueryClient } from "@tanstack/react-query";
import { ClipboardCopy, CornerDownLeft, Eraser, Pause, Replace, Sparkles, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildSchemaContext, stripCodeFence } from "@/lib/ai-context";
import {
  cancelAi,
  fetchDiagramColumnsForAi,
  fetchDiagramForeignKeysForAi,
  runAi,
} from "@/lib/ai-queries";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { setAiBarFocus } from "@/lib/shortcuts";
import { openAiSettings, aiReady, useAiStore } from "@/stores/ai";
import { log } from "@/stores/log";
import type { AiJob, AiMode, SqlDialect } from "@/types/ipc";

/**
 * The AI bar (Phase 12): a prompt strip above the query editor.
 *
 * Contract: the assistant DRAFTS, the human RUNS. Generated SQL lands in a
 * preview with explicit Insert / Replace actions and is never executed or
 * inserted automatically. The context sent to the model is built by
 * `ai-context.ts` — schema metadata and the user's SQL only, never row
 * data — and the note in the corner of every preview says so.
 */

interface AiBarProps {
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

  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<AiMode>("generate");
  const [output, setOutput] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const jobIdRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ready = aiReady({ enabled, baseUrl, model, keyHint });

  // Abort an in-flight job when the tab (and this bar) goes away — no
  // silent token burn in the background.
  useEffect(
    () => () => {
      if (jobIdRef.current !== null) void cancelAi(jobIdRef.current);
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
    if (!ready || phase === "streaming") return;
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
    if (!lastError || connId === null || !ready || phase === "streaming") return;
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
    if (connId === null || !ready || phase === "streaming") return;
    const sql = getSelection().trim() || getDoc().trim();
    if (!sql) return;
    run({ mode: "explain", dialect, database: db, sql });
  };

  const handleStop = () => {
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

  const streaming = phase === "streaming";
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

        <Input
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleAsk();
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
            onClick={handleAsk}
            aria-label={t("ai.bar.run")}
          >
            <CornerDownLeft data-icon="inline-start" />
            {t("ai.bar.run")}
          </Button>
        )}
      </div>

      {(phase === "streaming" || phase === "done" || phase === "error") && (
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
    </div>
  );
}

/** Clean a finished draft for insertion: fences off, whitespace trimmed. */
function draftText(mode: AiMode, output: string): string {
  if (mode === "explain") return output.trim();
  return stripCodeFence(output);
}
