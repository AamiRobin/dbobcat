import { create } from "zustand";

/**
 * GitHub star prompt (launch-milestone nudge). Entirely local state — no
 * telemetry, and starred-ness is unverifiable by design: a "Star" click is
 * treated as terminal, so the prompt can never nag someone who already did.
 *
 * State machine:
 * - `launches` counts app boots (recorded once per launch in the App
 *   bootstrap; inert under dev so development never counts).
 * - The prompt becomes due on the first launch reaching its milestone and,
 *   after each dismissal, again SNOOZE_GAP launches later. Re-shows use
 *   `>=` so an impression missed while the app was killed mid-prompt is
 *   delivered on the next launch instead of being lost.
 * - After MAX_DISMISSALS dismissals (i.e. MAX_DISMISSALS + 1 impressions)
 *   or a star click, `status` flips to "done" and the prompt never returns.
 *
 * Persistence follows the theme/tab conventions: plain localStorage with a
 * `dbobcat.` key and a defensive parse, so a corrupt payload can never wedge
 * the machine.
 */

export const STAR_STORAGE_KEY = "dbobcat.starPrompt";

/** Launch on which the first impression fires. */
export const FIRST_MILESTONE = 5;
/** Launches added to the milestone after each dismissal. */
export const SNOOZE_GAP = 5;
/** Dismissals before the prompt retires for good (impressions = 1 + this). */
export const MAX_DISMISSALS = 2;

export type StarPromptStatus = "active" | "done";

export interface StarPromptSnapshot {
  launches: number;
  snoozes: number;
  status: StarPromptStatus;
}

export const DEFAULT_SNAPSHOT: StarPromptSnapshot = {
  launches: 0,
  snoozes: 0,
  status: "active",
};

/** Defensive parse of the stored payload; anything odd resets to defaults. */
export function parseSnapshot(raw: string | null): StarPromptSnapshot {
  if (raw === null) return DEFAULT_SNAPSHOT;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_SNAPSHOT;
    const v = value as Record<string, unknown>;
    const count = (n: unknown) =>
      typeof n === "number" && Number.isFinite(n) && n > 0
        ? Math.floor(n)
        : 0;
    return {
      launches: count(v.launches),
      snoozes: count(v.snoozes),
      status: v.status === "done" ? "done" : "active",
    };
  } catch {
    return DEFAULT_SNAPSHOT;
  }
}

/** Due from the launch that reaches the current milestone, not only on it. */
export function isDue(s: StarPromptSnapshot): boolean {
  return (
    s.status === "active" &&
    s.launches >= FIRST_MILESTONE + s.snoozes * SNOOZE_GAP
  );
}

/** Pure transition for any close that is not a star click. */
export function snapshotAfterDismiss(s: StarPromptSnapshot): StarPromptSnapshot {
  const snoozes = s.snoozes + 1;
  return snoozes >= MAX_DISMISSALS ? { ...s, status: "done" } : { ...s, snoozes };
}

interface StarPromptStore extends StarPromptSnapshot {
  /** Once per real app launch; a no-op under dev. */
  recordLaunch: () => void;
  /** Prompt closed without starring (button, ESC, overlay or close icon). */
  dismiss: () => void;
  /** Star button pressed — terminal even though the star is unverifiable. */
  starClicked: () => void;
}

function persist(s: StarPromptSnapshot): void {
  try {
    localStorage.setItem(STAR_STORAGE_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable — in-memory state still drives this launch
  }
}

function snapshotOf(s: StarPromptSnapshot): StarPromptSnapshot {
  return { launches: s.launches, snoozes: s.snoozes, status: s.status };
}

const initial =
  typeof globalThis.localStorage === "undefined"
    ? DEFAULT_SNAPSHOT
    : parseSnapshot(globalThis.localStorage.getItem(STAR_STORAGE_KEY));

export const useStarPromptStore = create<StarPromptStore>((set, get) => ({
  ...initial,

  recordLaunch: () => {
    if (import.meta.env.DEV) return;
    set((s) => ({ launches: s.launches + 1 }));
    persist(snapshotOf(get()));
  },

  dismiss: () => {
    set(snapshotAfterDismiss(get()));
    persist(snapshotOf(get()));
  },

  starClicked: () => {
    set({ status: "done" });
    persist(snapshotOf(get()));
  },
}));
