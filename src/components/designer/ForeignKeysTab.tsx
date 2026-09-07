import { Plus, Trash2 } from "lucide-react";

import { emptyForeignKey } from "@/components/designer/column-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ColumnDef, ForeignKeyMeta } from "@/types/ipc";

const FK_ACTIONS = ["CASCADE", "SET NULL", "NO ACTION", "RESTRICT", "SET DEFAULT"];

/**
 * Foreign key editor: name, local columns (chips from table columns),
 * referenced db/table/columns and the ON DELETE / ON UPDATE actions.
 */
export function ForeignKeysTab({
  foreignKeys,
  columns,
  onChange,
}: {
  foreignKeys: ForeignKeyMeta[];
  columns: ColumnDef[];
  onChange: (foreignKeys: ForeignKeyMeta[]) => void;
}) {
  const update = (i: number, patch: Partial<ForeignKeyMeta>) =>
    onChange(foreignKeys.map((fk, idx) => (idx === i ? { ...fk, ...patch } : fk)));

  return (
    <div className="flex flex-col gap-3 p-3">
      <datalist id="designer-fk-column-options">
        {columns.map((c) => (
          <option key={c.name} value={c.name} />
        ))}
      </datalist>

      {foreignKeys.length === 0 && (
        <p className="text-xs text-muted-foreground">No foreign keys defined.</p>
      )}

      {foreignKeys.map((fk, i) => (
        <div key={`${fk.name}:${i}`} className="rounded-md border bg-card/40 p-2.5">
          <div className="flex items-center gap-2">
            <Input
              value={fk.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="constraint_name"
              className="h-6 w-48 px-2 font-mono text-xs"
              aria-label="Foreign key name"
            />
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              onClick={() => onChange(foreignKeys.filter((_, idx) => idx !== i))}
              aria-label="Delete foreign key"
            >
              <Trash2 />
            </Button>
          </div>

          {/* columns */}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="text-xs text-muted-foreground">Columns:</span>
            {fk.columns.map((colName) => (
              <span
                key={colName}
                className="flex items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs"
              >
                {colName}
                <button
                  type="button"
                  onClick={() =>
                    update(i, { columns: fk.columns.filter((c) => c !== colName) })
                  }
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${colName}`}
                >
                  ×
                </button>
              </span>
            ))}
            <Select
              value=""
              onValueChange={(name) => {
                if (!fk.columns.includes(name))
                  update(i, { columns: [...fk.columns, name] });
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Add local column"
                className="h-6 font-mono text-xs data-placeholder:font-sans"
              >
                <SelectValue placeholder="+ column…" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {columns
                    .filter((c) => !fk.columns.includes(c.name))
                    .map((c) => (
                      <SelectItem key={c.name} value={c.name} className="text-xs">
                        {c.name}
                      </SelectItem>
                    ))}

                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
            <span>References</span>
            <div className="flex items-center gap-1">
              <Input
                value={fk.refDb ?? ""}
                onChange={(e) => update(i, { refDb: e.target.value || null })}
                placeholder="(same db)"
                className="h-6 w-28 px-1.5 font-mono text-xs"
                aria-label="Referenced database"
              />
              <span>·</span>
              <Input
                list="designer-fk-table-options"
                value={fk.refTable}
                onChange={(e) => update(i, { refTable: e.target.value })}
                placeholder="ref_table"
                className="h-6 w-36 px-1.5 font-mono text-xs"
                aria-label="Referenced table"
              />
              <Input
                value={fk.refColumns.join(", ")}
                onChange={(e) =>
                  update(i, {
                    refColumns: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="ref columns (comma separated)"
                className="h-6 w-44 px-1.5 font-mono text-xs"
                aria-label="Referenced columns"
              />
            </div>

            <span>ON DELETE</span>
            {/* Action-selects below are controlled to "" so the placeholder
                persists; Radix forbids empty-string SelectItem values. */}
            <Select
              value={fk.onDelete ?? ""}
              onValueChange={(v) => update(i, { onDelete: v || null })}
            >
              <SelectTrigger size="sm" className="h-6 w-40 text-xs">
                <SelectValue placeholder="(default)" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {FK_ACTIONS.map((a) => (
                    <SelectItem key={a} value={a} className="text-xs">
                      {a}
                    </SelectItem>
                  ))}

                </SelectGroup>
              </SelectContent>
            </Select>

            <span>ON UPDATE</span>
            <Select
              value={fk.onUpdate ?? ""}
              onValueChange={(v) => update(i, { onUpdate: v || null })}
            >
              <SelectTrigger size="sm" className="h-6 w-40 text-xs">
                <SelectValue placeholder="(default)" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {FK_ACTIONS.map((a) => (
                    <SelectItem key={a} value={a} className="text-xs">
                      {a}
                    </SelectItem>
                  ))}

                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
      ))}

      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...foreignKeys, { ...emptyForeignKey(), name: `fk_${foreignKeys.length + 1}` }])}
      >
        <Plus data-icon="inline-start" /> Add foreign key
      </Button>
    </div>
  );
}
