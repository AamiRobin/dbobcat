import { create } from "zustand";

import type { DdlObjectRequest, RowValue } from "@/types/ipc";

/**
 * Pending export-dialog request (Phase 5). Entry points populate one slot;
 * the `ExportDialogHost` mounted at the app root consumes and clears it.
 */

/** Grid/query-result export: either a server-side source or client rows. */
export interface GridExportRequest {
  kind: "grid";
  connId: number;
  /** Context database (source schema). */
  db: string;
  table?: string;
  /** Arbitrary SELECT (query tabs); streamed server-side. */
  sql?: string;
  /** Column names for client-side selections. */
  columns?: string[];
  /** Client-side rows (grid selection / fetched query result page). */
  rows?: RowValue[][];
  /** File-name suggestion for the save dialog. */
  suggestedName?: string;
}

export interface DumpExportRequest {
  kind: "dump";
  connId: number;
  dbs: string[];
  /** null = every base table of each db (server resolves the list). */
  tables: string[] | null;
}

export interface DdlExportRequest {
  kind: "ddl";
  connId: number;
  requests: DdlObjectRequest[];
}

export type ExportRequest =
  | GridExportRequest
  | DumpExportRequest
  | DdlExportRequest;

interface ExportDialogState {
  request: ExportRequest | null;
  open: (req: ExportRequest) => void;
  close: () => void;
}

export const useExportDialogStore = create<ExportDialogState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/** Imperative helper usable from context menus outside React. */
export function openExportDialog(req: ExportRequest): void {
  useExportDialogStore.getState().open(req);
}
