import { create } from "zustand";

import type { Lang } from "@/lib/i18n";
import { setLang } from "@/lib/i18n";

export type Theme = "dark" | "light";

/** Snapshot of the active data grid or query run, shown in the status bar. */
export interface DataStats {
  rowsLoaded: number;
  totalRowsEstimate: number | null;
  elapsedMs: number | null;
  /** True while a query/data fetch is in flight (status bar shows activity). */
  running?: boolean;
}

interface UiState {
  theme: Theme;
  /** UI language (Phase 8 i18n groundwork; only "en" ships for now). */
  lang: Lang;
  logCollapsed: boolean;
  /** Stats from the active data tab; null when none is showing data. */
  dataStats: DataStats | null;
  // Global dialogs, openable from toolbar / shortcuts / native menu.
  sessionManagerOpen: boolean;
  /**
   * Session row to preselect when the manager opens externally (palette
   * Shift+Enter). Null = no preselection; always cleared on close/plain
   * opens so a stale id can never hijack a later manual open.
   */
  sessionManagerSelectId: string | null;
  shortcutsOpen: boolean;
  aboutOpen: boolean;
  setLang: (lang: Lang) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setLogCollapsed: (collapsed: boolean) => void;
  toggleLogCollapsed: () => void;
  setDataStats: (stats: DataStats) => void;
  clearDataStats: () => void;
  setSessionManagerOpen: (open: boolean, selectId?: string | null) => void;
  setShortcutsOpen: (open: boolean) => void;
  setAboutOpen: (open: boolean) => void;
}

const THEME_KEY = "murmeli.theme";

function loadInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // storage unavailable — fall through to default
  }
  return "dark"; // dark mode by default on first launch
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // non-fatal
  }
}

/**
 * Cross-fade surface colors while the `.dark` class flips: a temporary
 * `theme-fade` class on <html> enables background/border/text transitions for
 * one toggle (see index.css). Only added when the theme actually changes, so
 * first paint stays instant; skipped under reduced motion.
 */
let themeFadeTimer: ReturnType<typeof setTimeout> | null = null;

function fadeThemeFlip(theme: Theme): void {
  const root = document.documentElement;
  if (root.classList.contains("dark") === (theme === "dark")) return;
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch {
    // matchMedia unavailable — fall through to instant switch
    return;
  }
  root.classList.add("theme-fade");
  if (themeFadeTimer) clearTimeout(themeFadeTimer);
  themeFadeTimer = setTimeout(() => root.classList.remove("theme-fade"), 220);
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: loadInitialTheme(),
  lang: "en",
  logCollapsed: false,
  dataStats: null,
  sessionManagerOpen: false,
  sessionManagerSelectId: null,
  shortcutsOpen: false,
  aboutOpen: false,

  setLang: (lang) => {
    setLang(lang);
    set({ lang });
  },

  setTheme: (theme) => {
    // Commit store state first so subscribers observe the new value in the
    // same tick; DOM/localStorage application follows as a pure side effect.
    set({ theme });
    fadeThemeFlip(theme);
    applyTheme(theme);
  },

  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),

  setLogCollapsed: (collapsed) => set({ logCollapsed: collapsed }),
  toggleLogCollapsed: () => set((s) => ({ logCollapsed: !s.logCollapsed })),

  setDataStats: (stats) => set({ dataStats: stats }),
  clearDataStats: () => set({ dataStats: null }),

  setSessionManagerOpen: (sessionManagerOpen, selectId = null) =>
    set({ sessionManagerOpen, sessionManagerSelectId: selectId }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
}));
