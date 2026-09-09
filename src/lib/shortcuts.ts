/**
 * Central keyboard-shortcuts registry (Phase 8).
 *
 * One capture-phase `keydown` listener (installed once by `useShortcuts`)
 * matches events against declarative {@link ShortcutDef}s. Bindings are
 * fixed for now, but the registry shape (id + combo strings + handler map)
 * is designed so a settings panel can remap them later without touching
 * call sites.
 *
 * Double-fire rules (how this coexists with CodeMirror keymaps):
 * - F9 / F5 / Mod+Enter are ALSO bound inside the query editor's CodeMirror
 *   keymap (`SqlEditor`). Those defs are marked `fireInEditor: false`
 *   (default): when the event originates inside `.cm-editor` the registry
 *   stands down and lets CodeMirror handle exactly once. Outside the editor
 *   the registry makes them work anywhere in the window.
 * - Global bindings (tabs, refresh, …) opt into firing inside editors via
 *   `fireInEditor: true`; they have no CodeMirror counterpart, so no conflict.
 * - In plain inputs/textarea/contenteditable, non-modifier combos are ignored
 *   (typing "f" must not trigger anything); modifier combos still fire.
 * - Menu items carry no accelerators (see src-tauri lib.rs) — the registry
 *   owns all keyboard handling; native menu clicks arrive as `menu://click`
 *   events and go through the same `dispatchAction` path below.
 */

import { useEffect } from "react";

import { ipc } from "@/lib/ipc";
import { log } from "@/stores/log";
import { useConnectionStore } from "@/stores/connection";
import { useFindDialogStore } from "@/stores/find-dialog";
import { usePaletteStore } from "@/stores/palette";
import { useTabsStore } from "@/stores/tabs";
import { useUiStore } from "@/stores/ui";
import { shouldAskOnQuit, useTransactionStore } from "@/stores/transaction";
import { notify } from "@/lib/toast";

// ---------------------------------------------------------------------------
// Context + types
// ---------------------------------------------------------------------------

/** Live snapshot consulted before every shortcut fires. */
export interface ShortcutContext {
  connected: boolean;
  connId: number | null;
  dialect: string | null;
  tabCount: number;
}

export type ShortcutGroup = "Global" | "Query" | "Dialogs";

export interface ShortcutDef {
  id: string;
  /** Accepted combos, e.g. `["Mod+T"]` or `["Mod+/", "Mod+?", "?"]`. */
  combos: string[];
  label: string;
  group: ShortcutGroup;
  /** Extra gate (connection required, sqlite-gated tools, …). */
  when?: (ctx: ShortcutContext) => boolean;
  /**
   * Fire even when the event target sits inside a CodeMirror editor.
   * Default `false` — reserved for combos the editor's own keymap handles.
   */
  fireInEditor?: boolean;
  /**
   * Fire even while typing in a plain input/textarea. Default: allowed only
   * for combos containing a modifier.
   */
  alwaysFire?: boolean;
  /** May return a promise; the dispatcher tracks it instead of discarding. */
  handler: () => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Combo parsing / matching
// ---------------------------------------------------------------------------

const MODIFIER_KEYS = new Set(["mod", "ctrl", "alt", "shift", "meta"]);

export interface ParsedCombo {
  mods: Set<string>;
  key: string;
}

/** `"Mod+Shift+F"` → `{ mods: {"mod","shift"}, key: "f" }`. */
export function parseCombo(combo: string): ParsedCombo {
  const mods = new Set<string>();
  let key = "";
  for (const partRaw of combo.split("+")) {
    const part = partRaw.trim().toLowerCase();
    if (MODIFIER_KEYS.has(part)) mods.add(part);
    else key = part;
  }
  return { mods, key };
}

function hasModifier(c: ParsedCombo): boolean {
  // Plain "shift" alone (e.g. "?" on most layouts) does not count.
  return c.mods.has("mod") || c.mods.has("ctrl") || c.mods.has("alt");
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad/.test(navigator.platform ?? "") ||
    /Mac/.test(navigator.userAgent ?? ""));

/**
 * Canonical combo strings for a keyboard event, e.g. `"mod+f"`, `"f9"`,
 * `"mod+shift+f"`. On macOS `Mod` = Cmd; elsewhere `Mod` = Ctrl.
 */
export function eventCombos(e: KeyboardEvent): string[] {
  const parts: string[] = [];
  if (IS_MAC) {
    if (e.metaKey) parts.push("mod");
    if (e.ctrlKey) parts.push("ctrl");
  } else {
    if (e.ctrlKey) parts.push("mod");
    if (e.metaKey) parts.push("meta");
  }
  if (e.altKey) parts.push("alt");

  const raw = e.key;
  const key = raw.toLowerCase();

  // Single non-alphanumeric characters are punctuation ("?", "/", "…"):
  // use verbatim without a shift part. "?" additionally aliases to "/" so
  // Mod+/ matches on every layout shift-state.
  if (raw.length === 1 && !/[a-z0-9]/.test(raw)) {
    const direct = [...parts, key].join("+");
    return raw === "?" ? [direct, [...parts, "/"].join("+")] : [direct];
  }

  if (e.shiftKey) parts.push("shift");
  return [[...parts, key].join("+")];
}

/** True when any parsed event combo equals the registered combo exactly. */
export function matches(parsed: ParsedCombo[], combo: string): boolean {
  const c = parseCombo(combo);
  return parsed.some(
    (p) =>
      p.key === c.key &&
      p.mods.size === c.mods.size &&
      Array.from(c.mods).every((m) => p.mods.has(m)),
  );
}

/** Human-readable combo for the current platform ("⌘T" / "Ctrl+T"). */
export function formatCombo(combo: string): string {
  if (IS_MAC) {
    return combo
      .split("+")
      .map((p) => {
        switch (p.toLowerCase()) {
          case "mod":
            return "⌘";
          case "ctrl":
            return "⌃";
          case "alt":
            return "⌥";
          case "shift":
            return "⇧";
          default:
            return p.length === 1 ? p.toUpperCase() : capitalize(p);
        }
      })
      .join("");
  }
  return combo
    .split("+")
    .map((p) => {
      switch (p.toLowerCase()) {
        case "mod":
          return "Ctrl";
        case "meta":
          return "Win";
        default:
          return p.length === 1 ? p.toUpperCase() : capitalize(p);
      }
    })
    .join("+");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Active query runner bridge
// ---------------------------------------------------------------------------

export type RunKind = "all" | "selection";

type QueryRunner = (kind: RunKind) => void;

let activeQueryRunner: QueryRunner | null = null;

/**
 * Called by the active QueryView on mount so F9/F5/Mod+Enter work even when
 * focus lives outside the editor. Only the topmost mounted query tab wins.
 */
export function setActiveQueryRunner(runner: QueryRunner | null): void {
  activeQueryRunner = runner;
}

function runActiveQuery(kind: RunKind): void {
  if (!activeQueryRunner) {
    log("info", "No query tab is open — create one with Ctrl+T.");
    return;
  }
  activeQueryRunner(kind);
}

// ---------------------------------------------------------------------------
// AI bar focus bridge (same latest-wins pattern as the query runner)
// ---------------------------------------------------------------------------

type AiBarFocus = () => void;

let aiBarFocus: AiBarFocus | null = null;

/**
 * Called by the active QueryView's AI bar on mount so Mod+I focuses its
 * input from anywhere, including inside the CodeMirror editor.
 */
export function setAiBarFocus(focus: AiBarFocus | null): void {
  aiBarFocus = focus;
}

// ---------------------------------------------------------------------------
// Actions (shared by keyboard registry and native-menu clicks)
// ---------------------------------------------------------------------------

export async function dispatchAction(actionId: string): Promise<void> {
  switch (actionId) {
    case "session-manager.open":
      useUiStore.getState().setSessionManagerOpen(true);
      break;
    case "palette.open":
      usePaletteStore.getState().toggle("unified");
      break;
    case "palette.commands":
      usePaletteStore.getState().toggle("commands");
      break;
    case "tab.new-query":
      useTabsStore.getState().openTab("query");
      break;
    case "tab.close-active": {
      const { activeId, closeTab } = useTabsStore.getState();
      if (activeId) closeTab(activeId);
      break;
    }
    case "tab.next":
      cycleTabs(1);
      break;
    case "tab.previous":
      cycleTabs(-1);
      break;
    case "tree.refresh":
      await refreshTree();
      break;
    case "app.quit": {
      // Transactions Phase 1: resolve an open transaction before quitting.
      const tx = useTransactionStore.getState().tx;
      if (shouldAskOnQuit(tx)) {
        useTransactionStore.getState().requestAsk("quit");
        break;
      }
      await ipc("app_exit").catch((err) =>
        log(
          "error",
          `Quit failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      break;
    }
    case "find-text.open": {
      const connId = useConnectionStore.getState().connId;
      if (connId !== null) useFindDialogStore.getState().open({ connId });
      break;
    }
    case "view.toggle-theme":
      useUiStore.getState().toggleTheme();
      break;
    case "view.system-theme":
      useUiStore.getState().followSystemTheme();
      break;
    case "view.toggle-log":
      useUiStore.getState().toggleLogCollapsed();
      break;
    case "query.run-all":
      runActiveQuery("all");
      break;
    case "query.run-selection":
      runActiveQuery("selection");
      break;
    case "help.shortcuts":
      useUiStore.getState().setShortcutsOpen(true);
      break;
    case "help.about":
      useUiStore.getState().setAboutOpen(true);
      break;
    case "help.check-updates":
      void checkForUpdates();
      break;
    default:
      // Unknown action ids are ignored (forward compatibility with menus).
      break;
  }
}

/** Move active-tab focus one step forward/backward (wraps around). */
export function cycleTabs(direction: 1 | -1): void {
  const { tabs, activeId, setActive } = useTabsStore.getState();
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeId);
  const next = idx === -1 ? 0 : (idx + direction + tabs.length) % tabs.length;
  setActive(tabs[next].id);
}

/** Refresh the DB tree for the active connection. */
export async function refreshTree(): Promise<void> {
  const { status, connId } = useConnectionStore.getState();
  if (status !== "connected" || connId === null) {
    log("info", "Nothing to refresh yet — connect to a server first.");
    return;
  }
  const { queryClient } = await import("@/lib/query-client");
  const { dbKeys } = await import("@/lib/db-queries");
  await queryClient.invalidateQueries({ queryKey: dbKeys.all(connId) });
  log("info", "Refreshing database tree…");
}

/**
 * Check the update server. The updater plugin is only configured in signed
 * release builds (see `tauri.updater.conf.json`); locally this surfaces a
 * friendly note instead of an error.
 */
export async function checkForUpdates(): Promise<void> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      notify.info("You are up to date.");
      return;
    }
    notify.info(`Downloading update ${update.version}…`);
    await update.downloadAndInstall();
    notify.success(`Update ${update.version} installed — restart to apply.`);
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    const restart = await confirm("Update installed. Restart now?", {
      title: "Restart DBobcat",
      kind: "info",
    });
    if (restart) {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      "warn",
      `Auto-update unavailable (${message}). Release builds bundle the updater endpoint.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

function ctxFromStores(): ShortcutContext {
  const conn = useConnectionStore.getState();
  return {
    connected: conn.status === "connected",
    connId: conn.connId,
    dialect: conn.serverInfo?.dialect ?? null,
    tabCount: useTabsStore.getState().tabs.length,
  };
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/** Definitions in display/match order. Fixed for P8; remappable later. */
export const SHORTCUTS: ShortcutDef[] = [
  // -- global ---------------------------------------------------------------
  {
    id: "shortcut.palette.open",
    combos: ["Mod+K"],
    label: "Open command palette",
    group: "Global",
    fireInEditor: true,
    handler: async () => {
      await dispatchAction("palette.open");
    },
  },
  {
    id: "shortcut.palette.commands",
    combos: ["Mod+Shift+P"],
    label: "Open command palette (commands)",
    group: "Global",
    fireInEditor: true,
    handler: async () => {
      await dispatchAction("palette.commands");
    },
  },
  {
    id: "shortcut.session-manager",
    combos: ["Mod+O"],
    label: "Open session manager",
    group: "Global",
    handler: async () => {
      await dispatchAction("session-manager.open");
    },
  },
  {
    id: "shortcut.tab.new-query",
    combos: ["Mod+T"],
    label: "New query tab",
    group: "Global",
    fireInEditor: true,
    handler: async () => {
      await dispatchAction("tab.new-query");
    },
  },
  {
    id: "shortcut.tab.close",
    combos: ["Mod+W"],
    label: "Close active tab",
    group: "Global",
    fireInEditor: true,
    handler: async () => {
      await dispatchAction("tab.close-active");
    },
  },
  {
    id: "shortcut.tab.next",
    combos: ["Mod+Tab"],
    label: "Next tab",
    group: "Global",
    fireInEditor: true,
    handler: async () => {
      await dispatchAction("tab.next");
    },
  },
  {
    id: "shortcut.tab.previous",
    combos: ["Mod+Shift+Tab"],
    label: "Previous tab",
    group: "Global",
    fireInEditor: true,
    handler: async () => {
      await dispatchAction("tab.previous");
    },
  },
  {
    id: "shortcut.tree.refresh",
    combos: ["Mod+R"],
    label: "Refresh database tree",
    group: "Global",
    fireInEditor: true,
    handler: async () => {
      await dispatchAction("tree.refresh");
    },
  },
  {
    id: "shortcut.find-text",
    combos: ["Mod+Shift+F"],
    label: "Find text on server",
    group: "Global",
    fireInEditor: true,
    when: (ctx) =>
      ctx.connected && ctx.connId !== null && ctx.dialect !== "sqlite",
    handler: async () => {
      await dispatchAction("find-text.open");
    },
  },
  {
    id: "shortcut.app.quit",
    combos: ["Mod+Q"],
    label: "Quit",
    group: "Global",
    fireInEditor: true,
    handler: async () => {
      await dispatchAction("app.quit");
    },
  },

  // -- query --------------------------------------------------------------
  {
    id: "shortcut.query.run-all-f9",
    combos: ["F9"],
    label: "Run script",
    group: "Query",
    handler: async () => {
      await dispatchAction("query.run-all");
    },
  },
  {
    id: "shortcut.query.run-all-f5",
    combos: ["F5"],
    label: "Run script (alternate)",
    group: "Query",
    handler: async () => {
      await dispatchAction("query.run-all");
    },
  },
  {
    id: "shortcut.query.run-selection",
    combos: ["Mod+Enter"],
    label: "Run selection (or whole script)",
    group: "Query",
    handler: async () => {
      await dispatchAction("query.run-selection");
    },
  },
  {
    id: "shortcut.ai.ask",
    combos: ["Mod+I"],
    label: "Ask the AI assistant",
    group: "Query",
    fireInEditor: true,
    handler: async () => {
      if (!aiBarFocus) {
        log("info", "No query tab is open — create one with Ctrl+T.");
        return;
      }
      aiBarFocus();
    },
  },

  // -- help -----------------------------------------------------------------
  {
    id: "shortcut.help.shortcuts",
    combos: ["Mod+/", "Mod+?", "?"],
    label: "Show keyboard shortcuts",
    group: "Dialogs",
    handler: async () => {
      await dispatchAction("help.shortcuts");
    },
  },
];

/**
 * Install the single capture-phase keydown listener. Returns a cleanup fn.
 * Handlers read zustand stores imperatively, so the listener never goes stale.
 */
export function installShortcutListener(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const parsed = eventCombos(e)
      .map((combo) => parseCombo(combo))
      .filter((c) => c.key !== "");

    if (parsed.length === 0) return;

    // First def whose combo list contains the pressed combination; keep the
    // matched combo so input-guarding reflects what the user actually typed.
    let def: ShortcutDef | undefined;
    let matchedCombo: string | undefined;
    for (const candidate of SHORTCUTS) {
      const combo = candidate.combos.find((c) => matches(parsed, c));
      if (combo) {
        def = candidate;
        matchedCombo = combo;
        break;
      }
    }
    if (!def || !matchedCombo) return;

    // While the command palette is open it owns the keyboard: every def
    // except its own stands down (Mod+R / Mod+T / … must not fire under
    // the dialog). The palette defs keep firing so Mod+K can toggle shut.
    if (
      usePaletteStore.getState().open &&
      !def.id.startsWith("shortcut.palette.")
    ) {
      return;
    }

    const target = e.target;
    const inCodeMirror =
      target instanceof HTMLElement && !!target.closest(".cm-editor");

    // Inside CodeMirror the editor keymap owns F9/F5/Mod+Enter — stand down.
    if (inCodeMirror && !def.fireInEditor) return;

    const editable = isEditable(target);
    const modifierCombo = hasModifier(parseCombo(matchedCombo));
    if (editable && !inCodeMirror && !def.alwaysFire && !modifierCombo) {
      return;
    }

    if (def.when && !def.when(ctxFromStores())) return;

    // Stop the webview default for handled combos (F5 would reload the page,
    // Ctrl+Q/W/O have browser meanings too) and keep other listeners out.
    e.preventDefault();
    e.stopPropagation();
    void Promise.resolve(def.handler()).catch((err) => {
      // A rejecting handler must not surface as an unhandled rejection.
      log("error", err instanceof Error ? err.message : String(err));
    });
  };

  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () =>
    window.removeEventListener("keydown", onKeyDown, { capture: true });
}

/**
 * React hook: installs the global shortcut listener for the App lifetime.
 */
export function useShortcuts(): void {
  useEffect(() => installShortcutListener(), []);
}
