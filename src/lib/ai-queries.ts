import { Channel } from "@tauri-apps/api/core";
import type { QueryClient } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";
import {
  diaKeys,
  fetchDiagramColumnsWithFallback,
  fetchDiagramForeignKeysWithFallback,
} from "@/lib/diagram-queries";
import { TREE_STALE_TIME } from "@/lib/db-queries";
import type {
  AiJob,
  AiKeyStatus,
  AiProviderConfig,
  AiRunResult,
  AiStreamEvent,
  ForeignKeyMeta,
  TableSchemaData,
} from "@/types/ipc";

/**
 * AI assistant IPC (Phase 12). The API key never crosses into webview
 * state: save/delete/status talk to the encrypted credential store, and
 * `ai_run` reads the key backend-side at request time.
 */

/** Save the provider API key (stored AES-GCM, same file as DB passwords). */
export function saveAiKey(key: string): Promise<void> {
  return ipc<void>("ai_save_key", { key });
}

export function deleteAiKey(): Promise<void> {
  return ipc<void>("ai_delete_key");
}

export function fetchAiKeyStatus(): Promise<AiKeyStatus> {
  return ipc<AiKeyStatus>("ai_key_status");
}

export function testAiProvider(config: AiProviderConfig): Promise<string> {
  return ipc<string>("ai_test", { config });
}

/** Abort an in-flight job (best effort; mints nothing new). */
export function cancelAi(jobId: number): Promise<boolean> {
  return ipc<boolean>("ai_cancel", { jobId });
}

/**
 * Run one AI job, streaming text deltas through `onDelta` as they arrive.
 * Resolves with the full text; rejects with the provider/error message
 * ("cancelled: …" when aborted via {@link cancelAi}).
 */
export async function runAi(
  jobId: number,
  config: AiProviderConfig,
  job: AiJob,
  onDelta: (delta: string) => void,
): Promise<AiRunResult> {
  const onEvent = new Channel<AiStreamEvent>();
  onEvent.onmessage = (event) => onDelta(event.delta);
  return ipc<AiRunResult>("ai_run", { jobId, config, job, onEvent });
}

// ---------------------------------------------------------------------------
// Schema context sources (cached alongside the ER diagram's batch loaders)
// ---------------------------------------------------------------------------

/** Whole-database column metadata, cached under the diagram's query keys. */
export function fetchDiagramColumnsForAi(
  queryClient: QueryClient,
  connId: number,
  db: string,
): Promise<TableSchemaData[]> {
  return queryClient.fetchQuery({
    queryKey: diaKeys.columns(connId, db),
    queryFn: () => fetchDiagramColumnsWithFallback(connId, db),
    staleTime: TREE_STALE_TIME,
  });
}

/** Whole-database foreign keys, cached under the diagram's query keys. */
export function fetchDiagramForeignKeysForAi(
  queryClient: QueryClient,
  connId: number,
  db: string,
): Promise<ForeignKeyMeta[]> {
  return queryClient.fetchQuery({
    queryKey: diaKeys.foreignKeys(connId, db),
    queryFn: () => fetchDiagramForeignKeysWithFallback(connId, db),
    staleTime: TREE_STALE_TIME,
  });
}

// ---------------------------------------------------------------------------
// Agent mode (Phase 13)
// ---------------------------------------------------------------------------

/**
 * Run one agent invocation. Events stream through `onEvent` (text deltas,
 * tool activity); the result carries the updated conversation and either a
 * final answer or a pending write awaiting the user's decision. Stateless:
 * the caller echoes `result.messages` back on the next run.
 */
export async function runAgent(
  jobId: number,
  config: AiProviderConfig,
  args: {
    connId: number;
    db: string;
    dialect: string;
    schema?: string | null;
    request: import("@/types/ipc").AgentRunRequest;
  },
  onEvent: (event: import("@/types/ipc").AgentEvent) => void,
): Promise<import("@/types/ipc").AgentRunResult> {
  const onEventChannel = new Channel<import("@/types/ipc").AgentEvent>();
  onEventChannel.onmessage = onEvent;
  return ipc("ai_agent_run", {
    jobId,
    config,
    connId: args.connId,
    db: args.db,
    dialect: args.dialect,
    schema: args.schema ?? null,
    request: args.request,
    onEvent: onEventChannel,
  });
}
