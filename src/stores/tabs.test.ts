import { beforeEach, describe, expect, test } from "bun:test";

import type { Tab, TabType } from "./tabs";
import { activeTableKeyFor, activeTableRef, tableKey, useTabsStore } from "./tabs";

function tab(id: string, type: TabType, meta: Record<string, unknown> = {}): Tab {
  return { id, type, title: id, icon: "table", closable: true, meta };
}

/** Data tab pre-filled with a full table reference. */
function dataTab(id: string, connId = 1, db = "shop", table = "users"): Tab {
  return tab(id, "data", { connId, db, table });
}

beforeEach(() => {
  useTabsStore.setState({ tabs: [], activeId: null });
});

describe("activeTableRef", () => {
  test("returns the table ref of the active data tab", () => {
    useTabsStore.setState({ tabs: [dataTab("a")], activeId: "a" });
    expect(activeTableRef(useTabsStore.getState())).toEqual({
      connId: 1,
      db: "shop",
      table: "users",
    });
  });

  test("returns null when no tab is active", () => {
    useTabsStore.setState({ tabs: [dataTab("a")], activeId: null });
    expect(activeTableRef(useTabsStore.getState())).toBeNull();
  });

  test("returns null when the active tab is not a table-bearing view", () => {
    useTabsStore.setState({
      tabs: [tab("q", "query", { connId: 1 }), dataTab("a")],
      activeId: "q",
    });
    expect(activeTableRef(useTabsStore.getState())).toBeNull();
  });

  test("reads designer tabs that target a table", () => {
    useTabsStore.setState({
      tabs: [tab("d", "designer", { connId: 1, db: "shop", table: "users" })],
      activeId: "d",
    });
    expect(activeTableRef(useTabsStore.getState())?.table).toBe("users");
  });

  test("returns null for create-mode designers (no table target)", () => {
    useTabsStore.setState({
      tabs: [tab("d", "designer", { connId: 1, db: "shop", table: undefined })],
      activeId: "d",
    });
    expect(activeTableRef(useTabsStore.getState())).toBeNull();
  });

  test("returns null when activeId points at a closed tab", () => {
    useTabsStore.setState({ tabs: [], activeId: "ghost" });
    expect(activeTableRef(useTabsStore.getState())).toBeNull();
  });
});

describe("activeTableKeyFor", () => {
  test("matches the key built by tableKey for the same connection", () => {
    useTabsStore.setState({ tabs: [dataTab("a")], activeId: "a" });
    expect(activeTableKeyFor(useTabsStore.getState(), 1)).toBe(tableKey(1, "shop", "users"));
  });

  test("returns null for tables on another connection", () => {
    useTabsStore.setState({ tabs: [dataTab("a", 2)], activeId: "a" });
    expect(activeTableKeyFor(useTabsStore.getState(), 1)).toBeNull();
    // The unscoped ref still reports it (callers choose their own scope).
    expect(activeTableRef(useTabsStore.getState())?.connId).toBe(2);
  });

  test("follows the active tab as it moves", () => {
    const tabs = [dataTab("a", 1, "shop", "users"), dataTab("b", 1, "shop", "orders")];
    useTabsStore.setState({ tabs, activeId: "a" });
    expect(activeTableKeyFor(useTabsStore.getState(), 1)).toBe(tableKey(1, "shop", "users"));
    useTabsStore.setState({ activeId: "b" });
    expect(activeTableKeyFor(useTabsStore.getState(), 1)).toBe(tableKey(1, "shop", "orders"));
  });
});

describe("tableKey", () => {
  test("separates identifiers unambiguously", () => {
    // db "a:b" + table "c" must not collide with db "a" + table "b:c".
    expect(tableKey(1, "a:b", "c")).not.toBe(tableKey(1, "a", "b:c"));
  });
});
