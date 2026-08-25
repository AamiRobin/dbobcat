import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { ipc } from "@/lib/ipc";

/**
 * Per-session palette recents (Phase 2). Persisted in the settings store
 * under `palette.recents.<sessionId>` as an array of object descriptors,
 * most-recently-opened first. The TanStack cache mirrors the store so a
 * palette activation re-renders instantly; writes are best-effort like the
 * tree favorites.
 *
 * Recents track OBJECT opens only (tables/views/routines/triggers/events)
 * — sessions, actions and history rows are not recorded. On render the
 * descriptors are resolved against the CURRENT object pools; anything that
 * no longer exists is dropped from view and pruned on the next write.
 */

/** Serializable descriptor stored in settings. */
export interface RecentDescriptor {
  kind: "table" | "view" | "routine" | "trigger" | "event";
  db: string;
  name: string;
  /** ISO timestamp of the last palette activation. */
  lastOpenedAt: string;
}

export const PALETTE_RECENTS_CAP = 15;

export function recentsSettingKey(sessionId: string): string {
  return `palette.recents.${sessionId}`;
}

/** Stable identity used for dedupe + pool resolution ("kind:db.name"). */
export function recentIdentity(d: {
  kind: string;
  db: string;
  name: string;
}): string {
  return `${d.kind}:${d.db}.${d.name}`;
}

const RECENT_KINDS = new Set(["table", "view", "routine", "trigger", "event"]);

/**
 * Defensive parse of a raw settings value: keep only well-formed
 * descriptors so a corrupt or foreign payload can never break rendering.
 */
export function parseRecents(value: unknown): RecentDescriptor[] {
  if (!Array.isArray(value)) return [];
  const out: RecentDescriptor[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const d = entry as Record<string, unknown>;
    if (
      typeof d.kind === "string" &&
      RECENT_KINDS.has(d.kind) &&
      typeof d.db === "string" &&
      d.db !== "" &&
      typeof d.name === "string" &&
      d.name !== "" &&
      typeof d.lastOpenedAt === "string"
    ) {
      out.push({
        kind: d.kind as RecentDescriptor["kind"],
        db: d.db,
        name: d.name,
        lastOpenedAt: d.lastOpenedAt,
      });
    }
  }
  return out;
}

/**
 * LRU update: move-to-front (or insert at front), dedupe by identity,
 * stamp `lastOpenedAt`, prune beyond the cap. Pure — returns a new array.
 */
export function touchRecent(
  list: RecentDescriptor[],
  entry: { kind: RecentDescriptor["kind"]; db: string; name: string },
  now: string = new Date().toISOString(),
  cap: number = PALETTE_RECENTS_CAP,
): RecentDescriptor[] {
  const id = recentIdentity(entry);
  const rest = list.filter((d) => recentIdentity(d) !== id);
  return [{ ...entry, lastOpenedAt: now }, ...rest].slice(0, cap);
}

/**
 * Resolve descriptors against the live object pools: drop entries whose
 * identity is not in `known` (the caller derives the set from currently
 * loaded tables/routines/triggers/events). Order is preserved.
 */
export function filterResolved(
  list: RecentDescriptor[],
  known: Set<string>,
): RecentDescriptor[] {
  return list.filter((d) => known.has(recentIdentity(d)));
}

async function readRecents(sessionId: string | null): Promise<RecentDescriptor[]> {
  if (!sessionId) return [];
  const value = await ipc<unknown>("app_settings_get", {
    key: recentsSettingKey(sessionId),
  });
  return parseRecents(value);
}

/**
 * Recents of the active session plus an optimistic LRU recorder. When no
 * session is connected the hook stays inert (`recents` empty, recording
 * no-ops) — recents are skipped entirely while disconnected.
 */
export function usePaletteRecents(sessionId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["palette-recents", sessionId],
    queryFn: () => readRecents(sessionId),
    enabled: sessionId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const recordRecent = useCallback(
    (entry: { kind: RecentDescriptor["kind"]; db: string; name: string }) => {
      if (!sessionId) return;
      const key = ["palette-recents", sessionId] as const;
      const current =
        queryClient.getQueryData<RecentDescriptor[]>(key) ?? [];
      const next = touchRecent(current, entry);
      queryClient.setQueryData(key, next);
      // Persist best-effort; the cache already shows the new state.
      void ipc("app_settings_set", {
        key: recentsSettingKey(sessionId),
        value: next,
      }).catch((err) => console.warn("could not persist recents:", err));
    },
    [queryClient, sessionId],
  );

  return { recents: query.data ?? [], recordRecent };
}
