import { create } from "zustand";

/**
 * Pending find-text-on-server request (Phase 7). Toolbar / shortcuts
 * populate the slot; the `FindTextDialog` mounted at the app root consumes
 * and clears it — same pattern as export/import dialogs.
 */

export interface FindDialogRequest {
  connId: number;
  /** Database preselected in the scope picker (e.g. current tree db). */
  db?: string;
}

interface FindDialogState {
  request: FindDialogRequest | null;
  open: (req: FindDialogRequest) => void;
  close: () => void;
}

export const useFindDialogStore = create<FindDialogState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/** Imperative helper usable from toolbars/shortcuts outside React. */
export function openFindTextDialog(req: FindDialogRequest): void {
  useFindDialogStore.getState().open(req);
}
