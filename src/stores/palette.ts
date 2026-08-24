import { create } from "zustand";

import type { PaletteMode } from "@/lib/palette-items";

/**
 * Command-palette visibility (kept out of ui.ts on purpose: the shortcuts
 * registry consults this store on EVERY keystroke to decide whether to stand
 * down, so it stays tiny and dependency-free apart from the mode type).
 */
interface PaletteState {
  open: boolean;
  /** Mode the palette should open in; consumed once when it mounts/opens. */
  initialMode: PaletteMode;
  setOpen: (open: boolean, mode?: PaletteMode) => void;
  /** Open (optionally in a mode) or close — Mod+K while open closes. */
  toggle: (mode?: PaletteMode) => void;
}

export const usePaletteStore = create<PaletteState>((set, get) => ({
  open: false,
  initialMode: "unified",

  setOpen: (open, mode) =>
    set((s) => ({
      open,
      initialMode: open ? (mode ?? s.initialMode) : s.initialMode,
    })),

  toggle: (mode) => {
    if (get().open) {
      set({ open: false });
      return;
    }
    set((s) => ({ open: true, initialMode: mode ?? s.initialMode }));
  },
}));
