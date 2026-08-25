import type { FilterSpec, ForeignKeyMeta, RowValue } from "@/types/ipc";

import { cellDisplayText } from "@/lib/grid-columns";

/**
 * Pure helpers behind FK navigation (Phase 10): grouping FK constraints per
 * grid column and translating a row's cells into server-side filter terms.
 *
 * Jump terms use the single-item `in` operator with TYPED `RowValue`s taken
 * straight from the row — never stringified — so they reuse the typed bind
 * path end to end and avoid driver-side text coercion surprises. A composite
 * FK becomes one term per column, ANDed together. Any NULL key component
 * short-circuits to `null`: the row simply has no counterpart on the other
 * side of the constraint.
 */

/**
 * Group FK constraints by every participating column. When `knownColumns` is
 * given, columns outside it are skipped (the grid shows a subset only).
 * First-listed constraint stays first per column, so callers can treat
 * `[0]` as "the" FK of that column.
 */
export function fkGroupsByColumn(
  foreignKeys: ForeignKeyMeta[],
  knownColumns?: ReadonlySet<string>,
): Record<string, ForeignKeyMeta[]> {
  const groups: Record<string, ForeignKeyMeta[]> = {};
  for (const fk of foreignKeys) {
    for (const col of fk.columns) {
      if (knownColumns && !knownColumns.has(col)) continue;
      (groups[col] ??= []).push(fk);
    }
  }
  return groups;
}

/** Non-NULL cell of one named column, or null when absent/NULL. */
function typedCell(
  rowData: RowValue[],
  columnNames: readonly string[],
  column: string,
): RowValue | null {
  const idx = columnNames.indexOf(column);
  if (idx < 0) return null;
  const value = rowData[idx];
  if (!value || value.t === "null") return null;
  return value;
}

/**
 * Filters locating the referenced (parent) row of a child FK cell:
 * `{refColumn[i]} IN [childValueOf(columns[i])]`, one term per FK column.
 * Returns null when any key component is NULL or missing from `rowData`.
 */
export function buildForwardJumpFilters(
  fk: ForeignKeyMeta,
  childRowData: RowValue[],
  childColumnNames: readonly string[],
): FilterSpec[] | null {
  const filters: FilterSpec[] = [];
  for (let i = 0; i < fk.columns.length; i++) {
    const refColumn = fk.refColumns[i];
    if (!refColumn) return null; // malformed constraint — refuse to guess
    const value = typedCell(childRowData, childColumnNames, fk.columns[i]);
    if (!value) return null;
    filters.push({ column: refColumn, op: "in", value: null, values: [value] });
  }
  return filters;
}

/**
 * Filters locating the child rows referencing a parent row: maps the
 * parent's `{refColumns[i]}` cell onto the child's `{columns[i]}` column.
 * Returns null when any referenced cell is NULL (children can never point at
 * a NULL key).
 */
export function buildReverseJumpFilters(
  fk: ForeignKeyMeta,
  parentRowData: RowValue[],
  parentColumnNames: readonly string[],
): FilterSpec[] | null {
  const filters: FilterSpec[] = [];
  for (let i = 0; i < fk.columns.length; i++) {
    const refColumn = fk.refColumns[i];
    if (!refColumn) return null;
    const value = typedCell(parentRowData, parentColumnNames, refColumn);
    if (!value) return null;
    filters.push({ column: fk.columns[i], op: "in", value: null, values: [value] });
  }
  return filters;
}

const OP_LABELS: Record<string, string> = {
  eq: "=",
  not_eq: "<>",
  lt: "<",
  lt_e: "≤",
  gt: ">",
  gt_e: "≥",
  like: "LIKE",
  not_like: "NOT LIKE",
};

/** Compact human label for a filter chip: singleton `in` renders as `=`. */
export function prettyFilterLabel(filter: FilterSpec): string {
  if (filter.op === "in") {
    const values = filter.values ?? [];
    return values.length === 1
      ? `${filter.column} = ${cellDisplayText(values[0])}`
      : `${filter.column} IN (${values.length})`;
  }
  if (filter.op === "is_null") return `${filter.column} IS NULL`;
  if (filter.op === "is_not_null") return `${filter.column} IS NOT NULL`;
  const op = OP_LABELS[filter.op] ?? filter.op.toUpperCase();
  return `${filter.column} ${op}${filter.value != null && filter.value !== "" ? ` '${filter.value}'` : ""}`;
}
