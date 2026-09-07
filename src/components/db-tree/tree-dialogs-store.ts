import { create } from "zustand";

import type { MaintenanceOp } from "@/types/ipc";

/**
 * Pending tree-dialog state (Phase 4). Context menus populate one slot;
 * the dialog components rendered at the DbTree root consume and clear it.
 */

export interface BulkDialogRequest {
  /** What will run per selected table. */
  op: "truncate" | "drop";
  db: string;
}

export interface MaintenanceDialogRequest {
  db: string;
  tables: string[];
  /** Pre-selected operation from a leaf submenu; still changeable in-dialog. */
  op: MaintenanceOp;
}

export interface PromptDialogRequest {
  kind: "rename" | "clone";
  db: string;
  table: string;
}

/** "Create table copy…" request (Phase 9-B). */
export interface CopyTableRequest {
  db: string;
  table: string;
}

interface TreeDialogsState {
  bulk: BulkDialogRequest | null;
  maintenance: MaintenanceDialogRequest | null;
  prompt: PromptDialogRequest | null;
  copyTable: CopyTableRequest | null;
  /** "Bulk Table Editor…" (MySQL/MariaDB parity). */
  bulkAlter: { db: string } | null;

  openBulk: (req: BulkDialogRequest) => void;
  openMaintenance: (req: MaintenanceDialogRequest) => void;
  openPrompt: (req: PromptDialogRequest) => void;
  openCopyTable: (req: CopyTableRequest) => void;
  openBulkAlter: (req: { db: string }) => void;
  closeAll: () => void;
}

export const useTreeDialogsStore = create<TreeDialogsState>((set) => ({
  bulk: null,
  maintenance: null,
  prompt: null,
  copyTable: null,
  bulkAlter: null,

  openBulk: (bulk) => set({ bulk }),
  openMaintenance: (maintenance) => set({ maintenance }),
  openPrompt: (prompt) => set({ prompt }),
  openCopyTable: (copyTable) => set({ copyTable }),
  openBulkAlter: (bulkAlter) => set({ bulkAlter }),
  closeAll: () =>
    set({ bulk: null, maintenance: null, prompt: null, copyTable: null, bulkAlter: null }),
}));
