import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Typed IPC wrapper around Tauri's `invoke`.
 *
 * Command naming convention (binding for Phase 1+):
 *  - Commands are `snake_case` and grouped by domain: `<domain>_<verb_object>`.
 *      e.g. `db_list_databases`, `db_list_tables`, `query_page`, `conn_test`
 *  - Breaking payload changes get a new command (e.g. `query_page_v2`) rather
 *    than mutating the existing shape, so old frontend bundles stay compatible.
 *  - Arguments are passed as a single object; the JS side uses camelCase keys,
 *    Rust command parameters use snake_case — Tauri maps between them.
 *  - All commands return serializable payloads from `src/types/ipc.ts` and
 *    errors as serialized `AppError` strings (see src-tauri/src/error.rs).
 */
export type IpcCommand = string;

/** Error raised when an IPC call fails on the Rust side. */
export class IpcError extends Error {
  readonly command: string;

  constructor(command: string, message: string) {
    super(message);
    this.name = "IpcError";
    this.command = command;
  }
}

/**
 * Invoke a Rust command with compile-time-checked argument passing.
 *
 * @example
 * const databases = await ipc<DatabaseInfo[]>("db_list_databases", { connId });
 */
/** Stringify a rejection value; circular/exotic payloads fall back to String(). */
function safeStringify(raw: unknown): string {
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

export async function ipc<T>(
  command: IpcCommand,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    // Tauri rejects with a plain string for serialized errors.
    const message =
      typeof raw === "string"
        ? raw
        : raw instanceof Error
          ? raw.message
          : safeStringify(raw);
    throw new IpcError(command, message);
  }
}

// ---------------------------------------------------------------------------
// Backend event streams (Phase 5 export/import progress)
// ---------------------------------------------------------------------------

/**
 * Subscribe to backend events by name (e.g. `export://progress`). Returns an
 * unlisten function; callers MUST clean up in effects. Errors are logged, not
 * thrown, so a missing permission never crashes the UI.
 */
export async function onBackendEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload)).catch((err) => {
    // Non-fatal: progress UI simply stays idle.
    console.warn(`could not listen to ${event}:`, err);
    return () => {};
  });
}
