import { ipc } from "@/lib/ipc";
import type {
  ApplyChangesRequest,
  ApplyChangesResult,
  ColumnMeta,
  DatabaseInfo,
  DistinctValue,
  FilterSpec,
  FkRefValues,
  QueryPageResult,
  SortSpec,
  TableMeta,
} from "@/types/ipc";

/**
 * Query keys for schema browsing. All tree queries hang off the connection
 * id so a reconnect (new connId) starts with a fresh cache, and Refresh
 * invalidates by prefix.
 */
export const dbKeys = {
  all: (connId: number) => ["db", connId] as const,
  databases: (connId: number) => [...dbKeys.all(connId), "databases"] as const,
  tables: (connId: number, database: string) =>
    [...dbKeys.all(connId), "tables", database] as const,
  columns: (connId: number, database: string, table: string) =>
    [...dbKeys.tables(connId, database), "columns", table] as const,
};

/** Tree queries live for the whole connection; refresh is explicit. */
export const TREE_STALE_TIME = Number.POSITIVE_INFINITY;

export async function fetchDatabases(connId: number): Promise<DatabaseInfo[]> {
  return ipc<DatabaseInfo[]>("db_list_databases", { connId });
}

export async function fetchTables(connId: number, database: string): Promise<TableMeta[]> {
  return ipc<TableMeta[]>("db_list_tables", { connId, db: database });
}

export async function fetchColumns(
  connId: number,
  database: string,
  table: string,
): Promise<ColumnMeta[]> {
  return ipc<ColumnMeta[]>("db_describe_table", { connId, db: database, table });
}

export const isPrimaryKeyColumn = (column: ColumnMeta): boolean => column.key === "PRI";

// ---------------------------------------------------------------------------
// Data grid queries (Phase 2)
// ---------------------------------------------------------------------------

/** Parameters identifying one page fetch; also used as the query key body. */
export interface DataPageParams {
  connId: number;
  db: string;
  table: string;
  pageSize: number;
  offset: number;
  orderBy: SortSpec[];
  filter: FilterSpec | null;
}

export const dataKeys = {
  all: (connId: number) => ["data", connId] as const,
  table: (connId: number, db: string, table: string) =>
    [...dataKeys.all(connId), db, table] as const,
  page: (params: DataPageParams) =>
    [
      ...dataKeys.table(params.connId, params.db, params.table),
      "page",
      { pageSize: params.pageSize, offset: params.offset, orderBy: params.orderBy, filter: params.filter },
    ] as const,
};

export async function fetchDataPage(params: DataPageParams): Promise<QueryPageResult> {
  return ipc<QueryPageResult>("data_query_page", {
    connId: params.connId,
    db: params.db,
    table: params.table,
    pageSize: params.pageSize,
    offset: params.offset,
    orderBy: params.orderBy,
    filter: params.filter,
  });
}

export async function applyDataChanges(
  connId: number,
  req: ApplyChangesRequest,
): Promise<ApplyChangesResult> {
  return ipc<ApplyChangesResult>("data_apply_changes", { connId, req });
}

/** Exact count honouring the filter; null when the backend cannot count. */
export async function fetchRowCount(
  connId: number,
  db: string,
  table: string,
  filter: FilterSpec | null,
): Promise<number | null> {
  return ipc<number | null>("data_count_rows", { connId, db, table, filter });
}

/** Primary-key columns of a described table, in ordinal order. */
export function primaryKeyColumns(columns: ColumnMeta[]): ColumnMeta[] {
  return columns.filter(isPrimaryKeyColumn);
}

// ---------------------------------------------------------------------------
// Grid power features (Phase 9-A)
// ---------------------------------------------------------------------------

/** Distinct values of one column (quick-filter "More values…" dialog). */
export async function fetchDistinctValues(
  connId: number,
  db: string,
  table: string,
  column: string,
  limit: number,
  search: string | null,
): Promise<DistinctValue[]> {
  return ipc<DistinctValue[]>("data_distinct_values", {
    connId,
    db,
    table,
    column,
    limit,
    search,
  });
}

/** Top-N rows of a foreign key's referenced table (grid editor dropdown). */
export async function fetchFkRefValues(
  connId: number,
  db: string,
  table: string,
  fkName: string,
  limit: number,
): Promise<FkRefValues> {
  return ipc<FkRefValues>("data_fk_ref_values", {
    connId,
    db,
    table,
    fkName,
    limit,
  });
}

/** Read the system clipboard as plain text (paste rows / quick filters). */
export function readClipboardText(): Promise<string> {
  return ipc<string>("clipboard_read_text");
}
