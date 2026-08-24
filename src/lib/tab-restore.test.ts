import { afterEach, describe, expect, test } from "bun:test";

import { t, en, setLang } from "@/lib/i18n";
import { persistTabsNow, restoreTabs, STORAGE_KEY } from "@/lib/tab-restore";
import { useQueryEditorStore } from "@/stores/query-editor";
import { useTabsStore, type Tab } from "@/stores/tabs";

// Minimal localStorage stand-in (bun does not ship one).
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

function installStorage() {
  const storage = new MemoryStorage();
  (globalThis as Record<string, unknown>).localStorage = storage;
  return storage as unknown as Storage;
}

function queryTab(id: string): Tab {
  return { id, type: "query", title: `Query ${id}`, icon: "file-code", closable: true, meta: {} };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
  useTabsStore.getState().replaceTabs([], null);
});

describe("i18n", () => {
  test("interpolates variables and falls back to english", () => {
    expect(t("session.saved", { name: "local" })).toBe(
      en["session.saved"].split("{name}").join("local"),
    );
    setLang("en");
    expect(t("dialog.cancel")).toBe("Cancel");
  });
});

describe("tab restore", () => {
  test("returns false without storage or payload", () => {
    expect(restoreTabs()).toBe(false);
    installStorage();
    expect(restoreTabs()).toBe(false);
  });

  test("ignores corrupted payloads without crashing", () => {
    const storage = installStorage();
    storage.setItem(STORAGE_KEY, "{not json");
    const logBefore = restoreTabs();
    expect(logBefore).toBe(false);
  });

  test("persists only query tabs and restores them with SQL", () => {
    const storage = installStorage();

    const tabs = [queryTab("a"), queryTab("b")];
    tabs[0].type = "data"; // must NOT survive persistence
    useTabsStore.getState().replaceTabs(tabs, "b");
    useQueryEditorStore.getState().patch("b", { sql: "SELECT 1;" });
    persistTabsNow();

    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    expect(raw.tabs).toHaveLength(1);
    expect(raw.tabs[0].id).toBe("b");

    // Reset stores, then restore.
    useTabsStore.getState().replaceTabs([], null);
    expect(restoreTabs()).toBe(true);
    const restored = useTabsStore.getState().tabs;
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe("b");
    expect(useQueryEditorStore.getState().stateFor("b").sql).toBe("SELECT 1;");
  });
});
