import { ipc } from "@/lib/ipc";
import type {
  AlterUserRequest,
  CreateUserRequest,
  FindTextRequest,
  FindTextResult,
  GrantDetail,
  GrantRequest,
  ProcessInfo,
  ServerVariable,
  StatusVariable,
  UserMeta,
} from "@/types/ipc";

/**
 * Server tools IPC (Phase 7): user administration, process list, variables
 * / status dashboards and the find-text-on-server scanner. Progress flows
 * through the `find://progress` event — see `onBackendEvent` in lib/ipc.ts.
 */

/** Query-key families for TanStack Query caches. */
export const serverKeys = {
  all: (connId: number) => ["server", connId] as const,
  users: (connId: number) => [...serverKeys.all(connId), "users"] as const,
  grants: (connId: number, user: string, host: string | null) =>
    [...serverKeys.all(connId), "grants", user, host ?? "%"] as const,
  processes: (connId: number) => [...serverKeys.all(connId), "processes"] as const,
  variables: (connId: number) => [...serverKeys.all(connId), "variables"] as const,
  status: (connId: number) => [...serverKeys.all(connId), "status"] as const,
};

// ---------------------------------------------------------------------------
// User manager
// ---------------------------------------------------------------------------

export async function fetchUsers(connId: number): Promise<UserMeta[]> {
  return ipc<UserMeta[]>("user_list", { connId });
}

export async function fetchUserGrants(
  connId: number,
  user: string,
  host: string | null,
): Promise<GrantDetail> {
  return ipc<GrantDetail>("user_grants_detail", { connId, user, host });
}

export function createUser(connId: number, req: CreateUserRequest): Promise<void> {
  return ipc<void>("user_create", { connId, req });
}

export function alterUser(
  connId: number,
  user: string,
  host: string | null,
  req: AlterUserRequest,
): Promise<void> {
  return ipc<void>("user_alter", { connId, user, host, req });
}

export function dropUser(connId: number, user: string, host: string | null): Promise<void> {
  return ipc<void>("user_drop", { connId, user, host });
}

export function grantRevoke(connId: number, req: GrantRequest): Promise<void> {
  return ipc<void>("user_grant_revoke", { connId, req });
}

// ---------------------------------------------------------------------------
// Processes / variables / status
// ---------------------------------------------------------------------------

export async function fetchProcesses(connId: number): Promise<ProcessInfo[]> {
  return ipc<ProcessInfo[]>("process_list", { connId });
}

export function killProcess(
  connId: number,
  processId: number,
  queryOnly: boolean,
): Promise<void> {
  return ipc<void>("process_kill", { connId, processId, queryOnly });
}

export async function fetchVariables(connId: number): Promise<ServerVariable[]> {
  return ipc<ServerVariable[]>("variables_list", { connId });
}

export async function fetchStatus(connId: number): Promise<StatusVariable[]> {
  return ipc<StatusVariable[]>("status_list", { connId });
}

// ---------------------------------------------------------------------------
// Find text on server
// ---------------------------------------------------------------------------

export function findTextStart(
  connId: number,
  req: FindTextRequest,
): Promise<FindTextResult> {
  return ipc<FindTextResult>("find_text_start", { connId, req });
}

/** Cooperatively cancel a running scan; true when the run existed. */
export function findTextCancel(id: number): Promise<boolean> {
  return ipc<boolean>("find_text_cancel", { id });
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** `user@host` label for MySQL accounts; bare name for PG roles. */
export function userLabel(meta: Pick<UserMeta, "user" | "host">): string {
  return meta.host ? `${meta.user}@${meta.host}` : meta.user;
}

/** Common privileges offered by the Add-privilege dialog. */
export const COMMON_PRIVILEGES_MYSQL = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "INDEX",
  "REFERENCES",
  "CREATE VIEW",
  "SHOW VIEW",
  "CREATE ROUTINE",
  "ALTER ROUTINE",
  "EXECUTE",
  "TRIGGER",
  "EVENT",
  "LOCK TABLES",
  "CREATE TEMPORARY TABLES",
  "ALL PRIVILEGES",
] as const;

export const COMMON_PRIVILEGES_POSTGRES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "CREATE",
  "CONNECT",
  "TEMPORARY",
  "EXECUTE",
  "USAGE",
  "ALL PRIVILEGES",
] as const;

export function commonPrivileges(dialect: string): readonly string[] {
  return dialect === "postgres"
    ? COMMON_PRIVILEGES_POSTGRES
    : COMMON_PRIVILEGES_MYSQL;
}

/**
 * Parse a rendered PK string back into a single-column filter value.
 * Returns null for multi-column PKs ("a|b") or empty strings — the data tab
 * can only pre-filter on one column.
 */
export function singlePkFilterValue(rowPk: string): string | null {
  if (rowPk === "" || rowPk.includes("|")) return null;
  return rowPk;
}

/** Format PG/MySQL uptime seconds as a compact human string. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
