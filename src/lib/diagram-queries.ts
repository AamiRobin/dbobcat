import { ipc } from "@/lib/ipc";
import { TREE_STALE_TIME, fetchColumns, fetchTables } from "@/lib/db-queries";
import { fetchForeignKeys } from "@/lib/object-queries";
import type { ColumnMeta, ForeignKeyMeta, TableMeta, TableSchemaData } from "@/types/ipc";

/**
 * ER diagram data (Phase 11). Batch-first: one IPC per schema for columns
 * and one for foreign keys. If a batch command fails (older backend,
 * driver gap) transparent wrappers fan out through the cached per-table
 * fetchers the tree/designer already use.
 */

export const diaKeys = {
  all: (connId: number) => ["dia", connId] as const,
  columns: (connId: number, db: string) => [...diaKeys.all(connId), "columns", db] as const,
  foreignKeys: (connId: number, db: string) => [...diaKeys.all(connId), "fks", db] as const,
};

export async function fetchDiagramColumns(
  connId: number,
  db: string,
): Promise<TableSchemaData[]> {
  return ipc<TableSchemaData[]>("dia_describe_tables", { connId, db });
}

export async function fetchDiagramForeignKeys(
  connId: number,
  db: string,
): Promise<ForeignKeyMeta[]> {
  return ipc<ForeignKeyMeta[]>("dia_list_foreign_keys", { connId, db });
}

// ---------------------------------------------------------------------------
// Fan-out fallbacks (per-table, reusing the cached tree/designer fetchers)
// ---------------------------------------------------------------------------

/** Base tables of `db` only — views are out of the Phase 1 diagram scope. */
export function baseTablesOf(tables: TableMeta[]): TableMeta[] {
  return tables.filter((table) => table.kind === "table");
}

/** Columns for every table via `db_describe_table` (batch fallback). */
export async function fetchDiagramColumnsFallback(
  connId: number,
  db: string,
): Promise<TableSchemaData[]> {
  const tables = baseTablesOf(await fetchTables(connId, db));
  const settled = await Promise.allSettled(
    tables.map(async (table): Promise<ColumnMeta[]> =>
      fetchColumns(connId, db, table.name),
    ),
  );
  return tables
    .map((table, i): TableSchemaData | null =>
      settled[i].status === "fulfilled" ? { table: table.name, columns: settled[i].value } : null,
    )
    .filter((entry): entry is TableSchemaData => entry !== null);
}

/** Foreign keys for every table via `obj_list_foreign_keys` (batch fallback). */
export async function fetchDiagramForeignKeysFallback(
  connId: number,
  db: string,
): Promise<ForeignKeyMeta[]> {
  const tables = baseTablesOf(await fetchTables(connId, db));
  const settled = await Promise.allSettled(
    tables.map((table) => fetchForeignKeys(connId, db, table.name)),
  );
  // Forward listings leave `table` unset (the owning DDL carries it); the
  // diagram needs the child owner on every edge.
  return settled.flatMap((result, i) =>
    result.status === "fulfilled"
      ? result.value.map((fk) => ({ ...fk, refDb: fk.refDb ?? null, table: tables[i].name }))
      : [],
  );
}

/** Batch with transparent per-table fallback. */
export async function fetchDiagramColumnsWithFallback(
  connId: number,
  db: string,
): Promise<TableSchemaData[]> {
  try {
    return await fetchDiagramColumns(connId, db);
  } catch (err) {
    console.warn("dia_describe_tables failed; falling back per-table:", err);
    return fetchDiagramColumnsFallback(connId, db);
  }
}

/** Batch with transparent per-table fallback. */
export async function fetchDiagramForeignKeysWithFallback(
  connId: number,
  db: string,
): Promise<ForeignKeyMeta[]> {
  try {
    return await fetchDiagramForeignKeys(connId, db);
  } catch (err) {
    console.warn("dia_list_foreign_keys failed; falling back per-table:", err);
    return fetchDiagramForeignKeysFallback(connId, db);
  }
}

/** Diagram queries live for the whole connection like the tree's. */
export const DIAGRAM_STALE_TIME = TREE_STALE_TIME;
