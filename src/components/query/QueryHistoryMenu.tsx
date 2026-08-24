import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HISTORY_STALE_TIME,
  clearHistory,
  fetchHistory,
  formatRelativeTime,
  historyKeys,
  snippet,
} from "@/lib/query-queries";
import { log } from "@/stores/log";

/** Maximum rows shown in the menu; the store keeps up to 500. */
const VISIBLE_ENTRIES = 20;

/**
 * Toolbar history: recent scripts (newest first). Clicking an entry appends
 * it to the editor; "Clear" wipes the persisted list.
 */
export function QueryHistoryMenu({ onSelect }: { onSelect: (sql: string) => void }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const history = useQuery({
    queryKey: historyKeys.all,
    queryFn: fetchHistory,
    staleTime: HISTORY_STALE_TIME,
    enabled: open, // only hit the backend when the menu is actually opened
  });

  const entries = open ? (history.data ?? []).slice(0, VISIBLE_ENTRIES) : [];

  const onClear = async () => {
    try {
      await clearHistory();
      await queryClient.invalidateQueries({ queryKey: historyKeys.all });
      log("info", "Query history cleared.");
    } catch (err) {
      log("error", `Could not clear history: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" aria-label="Query history">
          <History data-icon="inline-start" />
          History
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-96">
        {entries.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            {history.isLoading ? "Loading…" : "No queries executed yet."}
          </div>
        ) : (
          entries.map((entry) => (
            <DropdownMenuItem
              key={entry.id}
              onClick={() => {
                onSelect(entry.sql);
                setOpen(false);
              }}
              className="flex-col items-start gap-0.5 py-1.5"
            >
              <span className="w-full truncate font-mono text-xs">
                {snippet(entry.sql)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {entry.connName || "unknown"} · {formatRelativeTime(entry.executedAt)}
              </span>
            </DropdownMenuItem>
          ))
        )}
        {entries.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void onClear()}>
              <Trash2 />
              Clear history
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
