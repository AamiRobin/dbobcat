import { create } from "zustand";

import { fetchAiKeyStatus } from "@/lib/ai-queries";
import { useTabsStore } from "@/stores/tabs";

/**
 * AI assistant settings (Phase 12) — persisted app preference, same
 * localStorage pattern as the theme preference in `stores/ui.ts`.
 *
 * Secret handling: the API key is NOT stored here. It lives in the
 * encrypted credential store (see `commands/ai.rs`); this store only keeps
 * a masked `keyHint` for the settings UI, refreshed from the backend via
 * {@link refreshKeyHint}.
 */

const STORAGE_KEY = "dbobcat.ai.v1";

interface AiSettingsState {
  /** Master opt-in. Default OFF: nothing is ever sent before the user
   * deliberately configures and enables the assistant. */
  enabled: boolean;
  /** OpenAI-compatible endpoint base URL, version segment included. */
  baseUrl: string;
  /** Model id on the provider (e.g. `gpt-4o-mini`, a local model tag). */
  model: string;
  /** Masked key tail from the backend; null when no key is stored. */
  keyHint: string | null;
  /** Settings dialog visibility. */
  dialogOpen: boolean;
  setEnabled: (enabled: boolean) => void;
  patch: (partial: Partial<Pick<AiSettingsState, "baseUrl" | "model">>) => void;
  setKeyHint: (hint: string | null) => void;
  setDialogOpen: (open: boolean) => void;
}

function loadPersisted(): Pick<AiSettingsState, "enabled" | "baseUrl" | "model"> {
  const fallback = { enabled: false, baseUrl: "", model: "" };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<AiSettingsState>;
    return {
      enabled: parsed.enabled === true,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
    };
  } catch {
    return fallback;
  }
}

function persist(state: AiSettingsState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ enabled: state.enabled, baseUrl: state.baseUrl, model: state.model }),
    );
  } catch {
    // Private-mode storage failures degrade to session-only settings.
  }
}

export const useAiStore = create<AiSettingsState>((set, get) => ({
  ...loadPersisted(),
  keyHint: null,
  dialogOpen: false,

  setEnabled: (enabled) => {
    set({ enabled });
    persist(get());
  },

  patch: (partial) => {
    set(partial);
    persist(get());
  },

  setKeyHint: (keyHint) => set({ keyHint }),

  setDialogOpen: (dialogOpen) => set({ dialogOpen }),
}));

/** Sync the masked key hint from the encrypted store (call on mount). */
export async function refreshKeyHint(): Promise<void> {
  try {
    const status = await fetchAiKeyStatus();
    useAiStore.getState().setKeyHint(status.hasKey ? (status.hint ?? "•••") : null);
  } catch {
    // Backend hiccup: keep the last known hint.
  }
}

/** Ready = opted in, endpoint + model set, and a key stored. */
export function aiReady(s: Pick<AiSettingsState, "enabled" | "baseUrl" | "model" | "keyHint">): boolean {
  return s.enabled && s.baseUrl.trim() !== "" && s.model.trim() !== "" && s.keyHint !== null;
}

/** Imperative helper for non-React callers. */
export function openAiSettings(): void {
  useAiStore.getState().setDialogOpen(true);
}

// ---------------------------------------------------------------------------
// Agent session (Phase 13) — per-tab conversation state
// ---------------------------------------------------------------------------

import type {
  AgentPendingWrite,
  AgentRunResult,
  AgentWireMessage,
} from "@/types/ipc";

/** One visible line of the agent conversation log. */
export interface AgentChatEntry {
  kind: "user" | "assistant" | "tool" | "notice";
  text: string;
  ok?: boolean;
}

export interface AgentSession {
  /** Agent mode toggle for this tab. */
  agentMode: boolean;
  /** In-flight agent job id (survives hasResults remounts → Stop works). */
  jobId: number | null;
  /** Wire conversation, echoed back to the backend on every run. */
  messages: AgentWireMessage[];
  /** Display log (what the user sees). */
  entries: AgentChatEntry[];
  running: boolean;
  pending: AgentPendingWrite | null;
  lastResult: AgentRunResult | null;
  error: string | null;
}

const EMPTY_SESSION: AgentSession = {
  agentMode: false,
  jobId: null,
  messages: [],
  entries: [],
  running: false,
  pending: null,
  lastResult: null,
  error: null,
};

interface AiAgentState {
  byTab: Record<string, AgentSession>;
  patch: (tabId: string, partial: Partial<AgentSession>) => void;
  clear: (tabId: string) => void;
}

export const useAiAgentStore = create<AiAgentState>((set) => ({
  byTab: {},

  patch: (tabId, partial) =>
    set((state) => ({
      byTab: {
        ...state.byTab,
        [tabId]: { ...(state.byTab[tabId] ?? EMPTY_SESSION), ...partial },
      },
    })),

  clear: (tabId) =>
    set((state) => {
      if (!(tabId in state.byTab)) return state;
      const next = { ...state.byTab };
      // Clearing the conversation must not exit agent mode.
      next[tabId] = { ...EMPTY_SESSION, agentMode: state.byTab[tabId].agentMode };
      return { byTab: next };
    }),
}));

/** Session for a tab (never null — callers read from the fallback). */
export function agentSession(
  byTab: Record<string, AgentSession>,
  tabId: string,
): AgentSession {
  return byTab[tabId] ?? EMPTY_SESSION;
}

// Tab close drops the session entirely (the UI's Clear button keeps the
// agentMode toggle; this must not).
useTabsStore.subscribe((next, prev) => {
  if (next.tabs.length >= prev.tabs.length) return;
  const ids = new Set(next.tabs.map((t) => t.id));
  const state = useAiAgentStore.getState();
  const nextByTab = { ...state.byTab };
  let dropped = false;
  for (const id of Object.keys(nextByTab)) {
    if (!ids.has(id)) {
      delete nextByTab[id];
      dropped = true;
    }
  }
  if (dropped) useAiAgentStore.setState({ byTab: nextByTab });
});
