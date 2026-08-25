/**
 * Tab session restore (Phase 8).
 *
 * Query tabs (id, title, SQL text) are serialized to localStorage on every
 * tabs/query-editor store change (debounced) and restored at launch. Only
 * query tabs are restored: data/designer/tool tabs depend on a live
 * connection and are re-opened from the tree instead. No auto-reconnect
 * happens — restored tabs come alive once the user connects manually.
 *
 * Storage note: this intentionally uses localStorage (like the theme),
 * not the Rust settings store — reads must be synchronous before first
 * paint and writes are tiny JSON blobs.
 */

import { EMPTY_QUERY_TAB, useQueryEditorStore } from "@/stores/query-editor";
import { useTabsStore, type Tab } from "@/stores/tabs";
import { log } from "@/stores/log";

export const STORAGE_KEY = "murmeli.session.tabs.v1";
const SAVE_DEBOUNCE_MS = 500;

/** Indirection so tests can stub storage (bun has no localStorage). */
function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

interface PersistedSession {
  version: 1;
  activeId: string | null;
  /** Query-tab descriptors in display order. */
  tabs: Array<Pick<Tab, "id" | "title" | "icon" | "meta">>;
  /** SQL text per restored tab id. */
  sqlByTab: Record<string, string>;
}

export function persistTabsNow(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const tabsState = useTabsStore.getState();
    const { tabs, activeId } = tabsState;
    const editor = useQueryEditorStore.getState().byTab;
    const payload: PersistedSession = {
      version: 1,
      activeId,
      tabs: tabs
        .filter((t) => t.type === "query")
        .map(({ id, title, icon, meta }) => ({ id, title, icon, meta })),
      sqlByTab: Object.fromEntries(
        Object.entries(editor)
          .filter(([id]) => tabs.some((t) => t.id === id && t.type === "query"))
          .map(([id, s]) => [id, s.sql]),
      ),
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage full/unavailable — restore simply won't happen.
  }
}
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistTabsNow();
  }, SAVE_DEBOUNCE_MS);
}

/** Subscribe both stores; call once at app bootstrap. */
export function installTabPersistence(): () => void {
  const unsubTabs = useTabsStore.subscribe(schedulePersist);
  const unsubEditor = useQueryEditorStore.subscribe(schedulePersist);
  return () => {
    unsubTabs();
    unsubEditor();
    if (saveTimer) clearTimeout(saveTimer);
  };
}

/**
 * Restore previously persisted query tabs. Returns true when anything was
 * restored. Safe on first launch (no stored payload) or corrupted payloads.
 */
export function restoreTabs(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;

  try {
    const parsed = JSON.parse(raw) as PersistedSession;
    if (parsed.version !== 1 || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
      return false;
    }

    const { replaceTabs } = useTabsStore.getState();
    const { patch } = useQueryEditorStore.getState();

    // Rehydrate tab descriptors; guard against junk persisted in meta.
    const tabs: Tab[] = parsed.tabs
      .filter((t) => typeof t?.id === "string" && t.id !== "")
      .map((t) => ({
        id: t.id,
        type: "query" as const,
        title: typeof t.title === "string" ? t.title : "Query",
        icon: typeof t.icon === "string" ? t.icon : "file-code",
        closable: true,
        meta: (t.meta && typeof t.meta === "object" ? t.meta : {}) as Record<string, unknown>,
      }));
    if (tabs.length === 0) return false;

    const sqlByTab = parsed.sqlByTab ?? {};
    for (const tab of tabs) {
      const sql = sqlByTab[tab.id];
      patch(tab.id, { sql: typeof sql === "string" ? sql : EMPTY_QUERY_TAB.sql });
    }

    const activeId =
      typeof parsed.activeId === "string" && tabs.some((t) => t.id === parsed.activeId)
        ? parsed.activeId
        : tabs[tabs.length - 1].id;

    replaceTabs(tabs, activeId);
    log("info", `Restored ${tabs.length} query tab(s) from your last session.`);
    return true;
  } catch {
    log("warn", "Saved tab session was unreadable — starting fresh.");
    return false;
  }
}
