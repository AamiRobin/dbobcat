import { useQuery } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";
import type { Snippet } from "@/types/ipc";

/**
 * Saved SQL snippets (Phase 9-B helpers panel). Backed by the settings
 * store via `snippet_*` commands — the same pattern as the query history.
 */

export const snippetKeys = {
  all: ["snippets"] as const,
};

export async function fetchSnippets(): Promise<Snippet[]> {
  return ipc<Snippet[]>("snippet_list");
}

export function snippetSave(name: string, sql: string): Promise<Snippet> {
  return ipc<Snippet>("snippet_save", { name, sql });
}

export function snippetDelete(id: string): Promise<void> {
  return ipc<void>("snippet_delete", { id });
}

/** React Query hook used by the helpers panel. */
export function useSnippets() {
  return useQuery({
    queryKey: snippetKeys.all,
    queryFn: fetchSnippets,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
