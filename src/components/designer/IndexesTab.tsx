import { ArrowDown, ArrowUp, Copy, Plus, Trash2, X } from "lucide-react";

import { emptyIndex } from "@/components/designer/column-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ColumnDef, IndexKind, IndexMeta } from "@/types/ipc";

const KIND_LABELS: Record<IndexKind, string> = {
  primary: "PRIMARY",
  unique: "UNIQUE",
  index: "INDEX",
  fulltext: "FULLTEXT",
  spatial: "SPATIAL",
};

/**
 * Index editor: one card per index with kind dropdown, ordered column chips
 * (add from the table's columns, reorder, remove), name and duplicate/delete.
 */
export function IndexesTab({
  columns,
  indexes,
  onChange,
}: {
  columns: ColumnDef[];
  indexes: IndexMeta[];
  onChange: (indexes: IndexMeta[]) => void;
}) {
  const update = (i: number, patch: Partial<IndexMeta>) =>
    onChange(indexes.map((ix, idx) => (idx === i ? { ...ix, ...patch } : ix)));

  const moveColumn = (ixIndex: number, colIndex: number, delta: -1 | 1) => {
    const ix = indexes[ixIndex];
    const target = colIndex + delta;
    if (target < 0 || target >= ix.columns.length) return;
    const cols = [...ix.columns];
    [cols[colIndex], cols[target]] = [cols[target], cols[colIndex]];
    update(ixIndex, { columns: cols });
  };

  const addIndex = () => {
    let n = indexes.length + 1;
    while (indexes.some((ix) => ix.name === `idx_${n}`)) n += 1;
    onChange([...indexes, emptyIndex("index", `idx_${n}`)]);
  };

  const duplicate = (i: number) => {
    const src = indexes[i];
    let n = 2;
    while (indexes.some((ix) => ix.name === `${src.name}_${n}`)) n += 1;
    const copy: IndexMeta =
      src.kind === "primary"
        ? { ...emptyIndex("index", `copy_of_${src.name}`), columns: [...src.columns] }
        : { ...src, name: `${src.name}_${n}`, columns: [...src.columns] };
    if (src.kind === "primary") copy.kind = "index";
    onChange([...indexes, copy]);
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <datalist id="designer-index-column-options">
        {columns.map((c) => (
          <option key={c.name} value={c.name} />
        ))}
      </datalist>

      {indexes.map((ix, i) => {
        const available = columns
          .map((c) => c.name)
          .filter((name) => !ix.columns.includes(name));
        return (
          <div key={`${ix.name}:${i}`} className="rounded-md border bg-card/40 p-2.5">
            <div className="flex items-center gap-2">
              <Select
                value={ix.kind}
                onValueChange={(kind) =>
                  update(i, {
                    kind: kind as IndexKind,
                    name: kind === "primary" ? "PRIMARY" : ix.name === "PRIMARY" ? `idx_${i + 1}` : ix.name,
                  })
                }
              >
                <SelectTrigger size="sm" className="h-6 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(Object.keys(KIND_LABELS) as IndexKind[])
                      .filter((k) => k !== "primary" || ix.kind === "primary")
                      .map((k) => (
                        <SelectItem key={k} value={k} className="text-xs">
                          {KIND_LABELS[k]}
                        </SelectItem>
                      ))}

                  </SelectGroup>
                </SelectContent>
              </Select>

              <Input
                value={ix.name}
                disabled={ix.kind === "primary"}
                onChange={(e) => update(i, { name: e.target.value })}
                className="h-6 w-44 px-2 font-mono text-xs"
                aria-label="Index name"
              />

              <div className="ml-auto flex items-center gap-0.5">
                <Button variant="ghost" size="icon-xs" onClick={() => duplicate(i)} aria-label="Duplicate index">
                  <Copy />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onChange(indexes.filter((_, idx) => idx !== i))}
                  aria-label="Delete index"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>

            {/* ordered column chips */}
            <ul className="flex flex-col gap-0.5 mt-2">
              {ix.columns.map((colName, ci) => (
                <li key={colName} className="flex items-center gap-1">
                  <span className="w-5 text-right text-[10px] tabular-nums text-muted-foreground">{ci + 1}</span>
                  <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{colName}</span>
                  <button
                    type="button"
                    onClick={() => moveColumn(i, ci, -1)}
                    disabled={ci === 0}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                    aria-label={`Move ${colName} up`}
                  >
                    <ArrowUp className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveColumn(i, ci, 1)}
                    disabled={ci === ix.columns.length - 1}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                    aria-label={`Move ${colName} down`}
                  >
                    <ArrowDown className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => update(i, { columns: ix.columns.filter((c) => c !== colName) })}
                    className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                    aria-label={`Remove ${colName}`}
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>

            {available.length > 0 && (
              <div className="mt-2">
                {/* Action-select: controlled to "" so the placeholder persists
                    after each pick; empty item values are forbidden by Radix. */}
                <Select
                  value=""
                  onValueChange={(name) => update(i, { columns: [...ix.columns, name] })}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="Add column to index"
                    className="h-6 w-full font-mono text-xs data-placeholder:font-sans"
                  >
                    <SelectValue placeholder="+ add column…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {available.map((name) => (
                        <SelectItem key={name} value={name} className="text-xs">
                          {name}
                        </SelectItem>
                      ))}

                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        );
      })}

      <Button variant="outline" size="sm" onClick={addIndex}>
        <Plus data-icon="inline-start" /> Add index
      </Button>
    </div>
  );
}
