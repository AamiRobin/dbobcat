import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { fetchDistinctValues } from "@/lib/db-queries";
import { cellDisplayText } from "@/lib/grid-columns";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { RowValue } from "@/types/ipc";

/** How many distinct values the dialog fetches per search. */
const DISTINCT_LIMIT = 200;

/**
 * "More values…" quick-filter dialog (Phase 9-A): shows the column's most
 * frequent values with counts; picking rows applies a bound
 * `column IN (…)` filter. Independent of any existing grid filter.
 */
export function DistinctValuesDialog({
  connId,
  db,
  table,
  column,
  onClose,
  onApply,
}: {
  connId: number;
  db: string;
  table: string;
  column: string;
  onClose: () => void;
  /** Called with the selected values (in display order). */
  onApply: (values: RowValue[]) => void;
}) {
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const values = useQuery({
    queryKey: ["distinct-values", connId, db, table, column, search],
    queryFn: () => fetchDistinctValues(connId, db, table, column, DISTINCT_LIMIT, search || null),
  });

  // A new search invalidates prior selections.
  useEffect(() => {
    setSelected(new Set());
  }, [search]);

  const rows = values.data ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(valueKey(r.value)));

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => valueKey(r.value))));
    }
  };

  const toggleOne = (value: RowValue) => {
    const key = valueKey(value);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const apply = () => {
    const picked = rows.filter((r) => selected.has(valueKey(r.value)));
    if (picked.length === 0) return;
    onApply(picked.map((r) => r.value));
    onClose();
  };

  const totalRows = useMemo(
    () => rows.reduce((sum, r) => sum + r.count, 0),
    [rows],
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {t("grid.distinct.title", { column })}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {table} · {rows.length} / {totalRows.toLocaleString()} rows
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            value={searchDraft}
            placeholder={t("grid.distinct.searchPlaceholder")}
            className="h-8 text-xs"
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setSearch(searchDraft.trim());
            }}
            onBlur={() => setSearch(searchDraft.trim())}
          />

          <div className="flex items-center gap-2 border-b pb-1 text-xs text-muted-foreground">
            <Checkbox
              id="distinct-select-all"
              checked={allSelected}
              onCheckedChange={toggleAll}
              aria-label={t("grid.distinct.selectAll")}
            />
            <label htmlFor="distinct-select-all" className="cursor-pointer select-none">
              {t("grid.distinct.selectAll")}
            </label>
          </div>

          <ScrollArea className="h-64">
            {values.isPending ? (
              <div className="flex items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
                <Spinner className="size-3" /> {t("grid.distinct.loading")}
              </div>
            ) : rows.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">
                {t("grid.distinct.none")}
              </p>
            ) : (
              rows.map((row) => {
                const key = valueKey(row.value);
                return (
                  <label
                    key={key}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent",
                      selected.has(key) && "bg-accent/40",
                    )}
                  >
                    <Checkbox
                      checked={selected.has(key)}
                      onCheckedChange={() => toggleOne(row.value)}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {cellDisplayText(row.value)}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {row.count.toLocaleString()}
                    </span>
                  </label>
                );
              })
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button size="sm" disabled={selected.size === 0} onClick={apply}>
            {t("grid.distinct.apply", { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Stable identity for a RowValue across re-renders (selection keys). */
function valueKey(value: RowValue): string {
  return value.t === "null" ? "null" : `${value.t}:${String(value.v)}`;
}
