import { create } from "zustand";

import { fetchAiKeyStatus } from "@/lib/ai-queries";

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
