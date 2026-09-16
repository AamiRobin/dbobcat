import { create } from "zustand";

import type { Lang } from "@/lib/i18n";
import { setLang } from "@/lib/i18n";
import { readPref, writePref } from "@/lib/ui-prefs";

export type Theme = "dark" | "light";
/** User preference: explicit choice, or follow the OS appearance. */
export type ThemePref = "system" | Theme;

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
  /** Persisted preference; `theme` is its resolution ("system" → OS look). */
  themePref: ThemePref;
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
  /** Resume auto-detection: theme follows the OS appearance again. */
  followSystemTheme: () => void;
  /** Re-resolve from the OS after an appearance change while on "system". */
  syncSystemTheme: () => void;
  setLogCollapsed: (collapsed: boolean) => void;
  toggleLogCollapsed: () => void;
  setDataStats: (stats: DataStats) => void;
  clearDataStats: () => void;
  setSessionManagerOpen: (open: boolean, selectId?: string | null) => void;
  setShortcutsOpen: (open: boolean) => void;
  setAboutOpen: (open: boolean) => void;
}

const THEME_PREF_KEY = "dbobcat.themePref";

/**
 * OS appearance query (macOS dark/light auto-switch). Null when matchMedia
 * is unavailable (tests, non-browser envs) so callers fall back to dark.
 */
const systemDarkQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function systemTheme(): Theme {
  return systemDarkQuery?.matches ? "dark" : "light";
}

function resolveTheme(pref: ThemePref): Theme {
  return pref === "system" ? systemTheme() : pref;
}

function loadInitialThemePref(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_PREF_KEY);
    if (stored === "system" || stored === "dark" || stored === "light") return stored;
  } catch {
    // storage unavailable — fall through to the default
  }
  // Default is following the OS. The legacy "dbobcat.theme" key is ignored on
  // purpose: the old code rewrote it on every startup, so its value never
  // reflected a deliberate user choice.
  return "system";
}

function persistThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_PREF_KEY, pref);
  } catch {
    // non-fatal
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
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

const initialThemePref = loadInitialThemePref();

export const useUiStore = create<UiState>((set, get) => ({
  theme: resolveTheme(initialThemePref),
  themePref: initialThemePref,
  lang: "en",
  // Seeded from storage so a collapsed log strip survives restarts without a
  // first-paint flash; every setter below keeps the pref in sync.
  logCollapsed: readPref("logCollapsed") === true,
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
    persistThemePref(theme);
    set({ themePref: theme, theme });
    fadeThemeFlip(theme);
    applyTheme(theme);
  },

  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),

  followSystemTheme: () => {
    const theme = systemTheme();
    persistThemePref("system");
    set({ themePref: "system", theme });
    fadeThemeFlip(theme);
    applyTheme(theme);
  },

  syncSystemTheme: () => {
    if (get().themePref !== "system") return;
    const theme = systemTheme();
    if (theme === get().theme) return;
    set({ theme });
    fadeThemeFlip(theme);
    applyTheme(theme);
  },

  setLogCollapsed: (collapsed) => {
    writePref("logCollapsed", collapsed);
    set({ logCollapsed: collapsed });
  },
  toggleLogCollapsed: () => get().setLogCollapsed(!get().logCollapsed),

  setDataStats: (stats) => set({ dataStats: stats }),
  clearDataStats: () => set({ dataStats: null }),

  setSessionManagerOpen: (sessionManagerOpen, selectId = null) =>
    set({ sessionManagerOpen, sessionManagerSelectId: selectId }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
}));

// Live-follow OS appearance changes (e.g. macOS auto dark/light schedule)
// while the preference is "system"; explicit choices opt out.
systemDarkQuery?.addEventListener("change", () => {
  useUiStore.getState().syncSystemTheme();
});
