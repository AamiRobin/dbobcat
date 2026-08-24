import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { ipc } from "@/lib/ipc";

/**
 * Per-session tree favorites (Phase 9-B). Persisted in the settings store
 * under `favorites.<sessionId>` as an array of `"db.table"` strings. The
 * TanStack cache mirrors the store so toggles feel instant.
 */

export function favoritesSettingKey(sessionId: string): string {
  return `favorites.${sessionId}`;
}

/** Split a favorite key back into its db/table parts. */
export function parseFavoriteKey(key: string): { db: string; table: string } | null {
  const idx = key.indexOf(".");
  if (idx <= 0 || idx === key.length - 1) return null;
  return { db: key.slice(0, idx), table: key.slice(idx + 1) };
}

async function readFavorites(sessionId: string | null): Promise<string[]> {
  if (!sessionId) return [];
  const value = await ipc<string[] | null>("app_settings_get", {
    key: favoritesSettingKey(sessionId),
  });
  return Array.isArray(value) ? value : [];
}

/**
 * Favorites of the active session plus an optimistic toggle. Returns a
 * `Set<"db.table">` so row renders are cheap membership checks.
 */
export function useTreeFavorites(sessionId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["tree-favorites", sessionId],
    queryFn: () => readFavorites(sessionId),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const favorites = useMemo(
    () => new Set(query.data ?? []),
    [query.data],
  );

  const toggleFavorite = useCallback(
    (db: string, table: string) => {
      if (!sessionId) return;
      const key = `${db}.${table}`;
      const current = new Set(queryClient.getQueryData<string[]>(["tree-favorites", sessionId]) ?? []);
      if (!current.delete(key)) current.add(key);
      const next = [...current];
      queryClient.setQueryData(["tree-favorites", sessionId], next);
      // Persist best-effort; the cache already shows the new state.
      void ipc("app_settings_set", {
        key: favoritesSettingKey(sessionId),
        value: next,
      }).catch((err) =>
        console.warn("could not persist favorites:", err),
      );
    },
    [queryClient, sessionId],
  );

  return { favorites, toggleFavorite };
}
