import { ipc } from "@/lib/ipc";
import type {
  AlterResult,
  CreateTableRequest,
  DropObjectRequest,
  EventMeta,
  ForeignKeyMeta,
  IndexMeta,
  MaintenanceOp,
  MaintenanceResult,
  ObjectOpResult,
  RoutineKind,
  RoutineMeta,
  ShowCreateResult,
  TableDdl,
  TriggerMeta,
} from "@/types/ipc";

/**
 * Server state for the table designer and object editors (Phase 4).
 * DDL snapshots are cached per object and invalidated explicitly after
 * successful applies; listing queries for routines/triggers/events back the
 * lazy tree groups.
 */

export const objKeys = {
  all: (connId: number) => ["obj", connId] as const,
  ddl: (connId: number, db: string, table: string) =>
    [...objKeys.all(connId), "ddl", db, table] as const,
  routines: (connId: number, db: string) =>
    [...objKeys.all(connId), "routines", db] as const,
  routineDdl: (connId: number, db: string, name: string, kind: RoutineKind) =>
    [...objKeys.routines(connId, db), "ddl", name, kind] as const,
  triggers: (connId: number, db: string) =>
    [...objKeys.all(connId), "triggers", db] as const,
  triggerDdl: (connId: number, db: string, name: string) =>
    [...objKeys.triggers(connId, db), "ddl", name] as const,
  viewDdl: (connId: number, db: string, name: string) =>
    [...objKeys.all(connId), "view-ddl", db, name] as const,
  events: (connId: number, db: string) =>
    [...objKeys.all(connId), "events", db] as const,
  eventDdl: (connId: number, db: string, name: string) =>
    [...objKeys.events(connId, db), "ddl", name] as const,
};

/** Tree/listing queries live for the whole connection; refresh is explicit. */
export const OBJECT_STALE_TIME = Number.POSITIVE_INFINITY;

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

export function fetchTableDdl(connId: number, db: string, table: string): Promise<TableDdl> {
  return ipc<TableDdl>("obj_get_table_ddl", { connId, db, table });
}

export async function fetchIndexes(
  connId: number,
  db: string,
  table: string,
): Promise<IndexMeta[]> {
  return ipc<IndexMeta[]>("obj_list_indexes", { connId, db, table });
}

export async function fetchForeignKeys(
  connId: number,
  db: string,
  table: string,
): Promise<ForeignKeyMeta[]> {
  return ipc<ForeignKeyMeta[]>("obj_list_foreign_keys", { connId, db, table });
}

export function fetchRoutines(connId: number, db: string): Promise<RoutineMeta[]> {
  return ipc<RoutineMeta[]>("obj_list_routines", { connId, db });
}

export function fetchRoutineDdl(
  connId: number,
  db: string,
  name: string,
  kind: RoutineKind,
): Promise<ShowCreateResult> {
  return ipc<ShowCreateResult>("obj_get_routine_ddl", { connId, db, name, kind });
}

export function fetchTriggers(connId: number, db: string): Promise<TriggerMeta[]> {
  return ipc<TriggerMeta[]>("obj_list_triggers", { connId, db });
}

export function fetchTriggerDdl(
  connId: number,
  db: string,
  name: string,
): Promise<ShowCreateResult> {
  return ipc<ShowCreateResult>("obj_get_trigger_ddl", { connId, db, name });
}

export function fetchViewDdl(
  connId: number,
  db: string,
  name: string,
): Promise<ShowCreateResult> {
  return ipc<ShowCreateResult>("obj_get_view_ddl", { connId, db, name });
}

export function fetchEvents(connId: number, db: string): Promise<EventMeta[]> {
  return ipc<EventMeta[]>("obj_list_events", { connId, db });
}

export function fetchEventDdl(
  connId: number,
  db: string,
  name: string,
): Promise<ShowCreateResult> {
  return ipc<ShowCreateResult>("obj_get_event_ddl", { connId, db, name });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function createTable(
  connId: number,
  db: string,
  req: CreateTableRequest,
): Promise<string> {
  return ipc<string>("obj_create_table", { connId, db, req });
}

export function alterTable(
  connId: number,
  db: string,
  table: string,
  desiredDdl: TableDdl,
  dryRun: boolean,
): Promise<AlterResult> {
  return ipc<AlterResult>("obj_alter_table", {
    connId,
    db,
    table,
    desiredDdl,
    dryRun,
  });
}

export function dropObjects(
  connId: number,
  requests: DropObjectRequest[],
): Promise<ObjectOpResult[]> {
  return ipc<ObjectOpResult[]>("obj_drop_objects", { connId, requests });
}

export function renameTable(
  connId: number,
  db: string,
  table: string,
  newName: string,
  /** Target database for MySQL cross-schema renames; omit = same schema. */
  newDb?: string,
): Promise<void> {
  return ipc<void>("obj_rename_table", { connId, db, table, newName, newDb });
}

export function emptyCloneTable(
  connId: number,
  db: string,
  table: string,
  newDb: string,
  newName: string,
): Promise<void> {
  return ipc<void>("obj_empty_clone_table", { connId, db, table, newDb, newName });
}

/**
 * Full table copy on the same connection (Phase 9-B): CREATE from the
 * source DDL honoring the copy flags plus an optional INSERT…SELECT.
 * Returns the number of rows copied (0 = structure only).
 */
export function copyTable(
  connId: number,
  srcDb: string,
  srcTable: string,
  dstDb: string,
  dstName: string,
  copyData: boolean,
  copyIndexes: boolean,
  copyFks: boolean,
): Promise<number> {
  return ipc<number>("obj_copy_table", {
    connId,
    srcDb,
    srcTable,
    dstDb,
    dstName,
    copyData,
    copyIndexes,
    copyFks,
  });
}

export function truncateTables(
  connId: number,
  db: string,
  names: string[],
): Promise<ObjectOpResult[]> {
  return ipc<ObjectOpResult[]>("obj_truncate_tables", { connId, db, names });
}

export function runMaintenance(
  connId: number,
  db: string,
  tables: string[],
  op: MaintenanceOp,
): Promise<MaintenanceResult[]> {
  return ipc<MaintenanceResult[]>("obj_maintenance", { connId, db, tables, op });
}

/** Apply one raw statement (no client-side splitting). */
export function executeObjectSql(connId: number, sql: string): Promise<void> {
  return ipc<void>("obj_execute_sql", { connId, sql });
}
