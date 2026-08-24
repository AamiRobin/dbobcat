import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

import {
  COMMON_TYPES,
  joinDataType,
  primaryKeyColumns,
  splitDataType,
} from "@/components/designer/column-utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ColumnDef, DefaultKind, IndexMeta } from "@/types/ipc";

/**
 * Editable columns grid: name/type/length/unsigned/null/default/AI/comment
 * per row with PK toggling (synced into the indexes list via onTogglePk),
 * reorder arrows and delete. Rows are edited immutably so preserved
 * attributes survive round-trips.
 */
export function ColumnsTab({
  columns,
  indexes,
  onChange,
  onTogglePk,
}: {
  columns: ColumnDef[];
  indexes: IndexMeta[];
  onChange: (columns: ColumnDef[]) => void;
  onTogglePk: (columnName: string, checked: boolean) => void;
}) {
  const pkColumns = primaryKeyColumns(indexes);

  const update = (i: number, patch: Partial<ColumnDef>) => {
    onChange(columns.map((col, idx) => (idx === i ? { ...col, ...patch } : col)));
  };

  const move = (i: number, delta: -1 | 1) => {
    const target = i + delta;
    if (target < 0 || target >= columns.length) return;
    const next = [...columns];
    [next[i], next[target]] = [next[target], next[i]];
    onChange(next);
  };

  const remove = (i: number) => onChange(columns.filter((_, idx) => idx !== i));

  return (
    <div className="h-full overflow-auto p-2">
      <datalist id="designer-type-options">
        {COMMON_TYPES.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Length / Values</TableHead>
            <TableHead className="w-14 text-center">Unsigned</TableHead>
            <TableHead className="w-10 text-center">PK</TableHead>
            <TableHead className="w-14 text-center">Null</TableHead>
            <TableHead>Default</TableHead>
            <TableHead className="w-10 text-center">AI</TableHead>
            <TableHead>Comment</TableHead>
            <TableHead className="w-16" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {columns.map((col, i) => (
            <ColumnRow
              key={`${col.previousName ?? col.name}:${i}`}
              column={col}
              isPk={pkColumns.has(col.name)}
              index={i}
              rowCount={columns.length}
              onUpdate={(patch) => update(i, patch)}
              onTogglePk={(checked) => onTogglePk(col.name, checked)}
              onMove={move}
              onRemove={() => remove(i)}
            />
          ))}
        </TableBody>
      </Table>
      {columns.length === 0 && (
        <p className="p-4 text-center text-xs text-muted-foreground">
          No columns — add one with “Column” in the header.
        </p>
      )}
    </div>
  );
}

interface ColumnRowProps {
  column: ColumnDef;
  isPk: boolean;
  index: number;
  rowCount: number;
  onUpdate: (patch: Partial<ColumnDef>) => void;
  onTogglePk: (checked: boolean) => void;
  onMove: (index: number, delta: -1 | 1) => void;
  onRemove: () => void;
}

function ColumnRow({
  column,
  isPk,
  index,
  rowCount,
  onUpdate,
  onTogglePk,
  onMove,
  onRemove,
}: ColumnRowProps) {
  const split = splitDataType(column.dataType);
  const hasArgs = /\(/.test(column.dataType);
  const defaultIsNull = column.defaultKind === "null";

  const setTypeParts = (base: string, args: string | null, unsigned: boolean) => {
    onUpdate({ dataType: joinDataType(base || "varchar", args, unsigned) });
  };

  return (
    <TableRow>
      <TableCell className="text-[10px] tabular-nums text-muted-foreground">{index + 1}</TableCell>
      <TableCell>
        <Input
          value={column.name}
          onChange={(e) =>
            onUpdate({ name: e.target.value, previousName: column.previousName ?? undefined })
          }
          className="h-6 w-32 px-1.5 font-mono text-xs"
          aria-label="Column name"
        />
      </TableCell>
      <TableCell>
        <Input
          list="designer-type-options"
          value={split.base}
          onChange={(e) => setTypeParts(e.target.value, split.args, split.unsigned)}
          className="h-6 w-28 px-1.5 font-mono text-xs"
          aria-label="Type"
        />
      </TableCell>
      <TableCell>
        <Input
          value={split.args ?? ""}
          placeholder={/^enum|^set/i.test(split.base) ? "'a','b'" : "length"}
          disabled={!hasArgs && !supportsLength(split.base)}
          onChange={(e) => setTypeParts(split.base, e.target.value || null, split.unsigned)}
          className="h-6 w-24 px-1.5 font-mono text-xs disabled:opacity-40"
          aria-label="Length or values"
        />
      </TableCell>
      <TableCell className="text-center">
        <Checkbox
          checked={split.unsigned}
          onCheckedChange={(v) => setTypeParts(split.base, split.args, v === true)}
          aria-label="Unsigned"
        />
      </TableCell>
      <TableCell className="text-center">
        <Checkbox checked={isPk} onCheckedChange={(v) => onTogglePk(v === true)} aria-label="Primary key" />
      </TableCell>
      <TableCell className="text-center">
        <Checkbox
          checked={column.nullable}
          onCheckedChange={(v) => onUpdate({ nullable: v === true })}
          aria-label="Nullable"
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Input
            value={column.defaultValue ?? ""}
            disabled={defaultIsNull}
            onChange={(e) =>
              onUpdate({ defaultValue: e.target.value, defaultKind: "value" as DefaultKind })
            }
            className="h-6 w-28 px-1.5 font-mono text-xs disabled:opacity-40"
            aria-label="Default value"
          />
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Checkbox
              checked={defaultIsNull}
              onCheckedChange={(v) =>
                onUpdate({
                  defaultKind: v ? ("null" as DefaultKind) : ("none" as DefaultKind),
                  defaultValue: null,
                })
              }
              aria-label="Default NULL"
            />
            NULL
          </label>
        </div>
      </TableCell>
      <TableCell className="text-center">
        <Checkbox
          checked={column.autoIncrement}
          onCheckedChange={(v) => onUpdate({ autoIncrement: v === true })}
          aria-label="Auto increment"
        />
      </TableCell>
      <TableCell>
        <Input
          value={column.comment ?? ""}
          onChange={(e) => onUpdate({ comment: e.target.value || null })}
          className="h-6 w-36 px-1.5 text-xs"
          aria-label="Comment"
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-0.5">
          <button
            type="button"
            onClick={() => onMove(index, -1)}
            disabled={index === 0}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
            aria-label="Move up"
          >
            <ArrowUp className="size-3" />
          </button>
          <button
            type="button"
            onClick={() => onMove(index, 1)}
            disabled={index === rowCount - 1}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
            aria-label="Move down"
          >
            <ArrowDown className="size-3" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
            aria-label="Delete column"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/** Types that accept a parenthesized length/values argument. */
function supportsLength(base: string): boolean {
  return /^(varchar|char|binary|varbinary|decimal|enum|set|bit|tinyint|smallint|mediumint|int|bigint|time|datetime|timestamp)$/i.test(
    base.trim(),
  );
}
