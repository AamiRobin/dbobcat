import { create } from "zustand";

/**
 * Pending import-wizard request (Phase 5). Entry points preselect the
 * target database/table when invoked from a tree node or data tab.
 */

export interface ImportRequest {
  connId: number;
  db?: string;
  table?: string;
}

interface ImportDialogState {
  request: ImportRequest | null;
  open: (req: ImportRequest) => void;
  close: () => void;
}

export const useImportDialogStore = create<ImportDialogState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/** Imperative helper usable from toolbars outside React. */
export function openImportWizard(req: ImportRequest): void {
  useImportDialogStore.getState().open(req);
}
