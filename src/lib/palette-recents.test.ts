import { describe, expect, test } from "bun:test";

import {
  PALETTE_RECENTS_CAP,
  filterResolved,
  parseRecents,
  recentIdentity,
  recentsSettingKey,
  touchRecent,
  type RecentDescriptor,
} from "./palette-recents";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const desc = (
  kind: RecentDescriptor["kind"],
  db: string,
  name: string,
  lastOpenedAt = "2026-08-01T00:00:00Z",
): RecentDescriptor => ({ kind, db, name, lastOpenedAt });

// ---------------------------------------------------------------------------
// Keys + identity
// ---------------------------------------------------------------------------

describe("recentsSettingKey / recentIdentity", () => {
  test("setting key is namespaced per session", () => {
    expect(recentsSettingKey("sess-1")).toBe("palette.recents.sess-1");
  });

  test("identity is kind:db.name", () => {
    expect(recentIdentity({ kind: "table", db: "app", name: "users" })).toBe(
      "table:app.users",
    );
    expect(recentIdentity({ kind: "view", db: "app", name: "users" })).toBe(
      "view:app.users",
    );
    // Same name in another db is a different object.
    expect(recentIdentity({ kind: "table", db: "shop", name: "users" })).not.toBe(
      "table:app.users",
    );
  });
});

// ---------------------------------------------------------------------------
// parseRecents (defensive settings decode)
// ---------------------------------------------------------------------------

describe("parseRecents", () => {
  test("null / non-array values yield an empty list", () => {
    expect(parseRecents(null)).toEqual([]);
    expect(parseRecents(undefined)).toEqual([]);
    expect(parseRecents("nope")).toEqual([]);
    expect(parseRecents({ kind: "table" })).toEqual([]);
  });

  test("malformed entries are dropped, valid ones kept in order", () => {
    const value = [
      desc("table", "app", "users"),
      { kind: "table", db: "app" }, // missing name/timestamp
      { kind: "banana", db: "a", name: "b", lastOpenedAt: "x" }, // bad kind
      { kind: "table", db: "", name: "x", lastOpenedAt: "x" }, // empty db
      { kind: "routine", db: "app", name: "calc", lastOpenedAt: 42 }, // bad ts
      "junk",
      null,
      desc("trigger", "shop", "t_audit", "2026-01-02T00:00:00Z"),
    ];
    expect(parseRecents(value)).toEqual([
      desc("table", "app", "users"),
      desc("trigger", "shop", "t_audit", "2026-01-02T00:00:00Z"),
    ]);
  });

  test("all five object kinds are accepted", () => {
    const kinds = ["table", "view", "routine", "trigger", "event"] as const;
    expect(parseRecents(kinds.map((k) => desc(k, "db", "x")))).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// touchRecent (LRU)
// ---------------------------------------------------------------------------

describe("touchRecent", () => {
  test("inserts a new entry at the front with the given timestamp", () => {
    const list = [desc("table", "app", "a"), desc("table", "app", "b")];
    const next = touchRecent(list, { kind: "view", db: "shop", name: "v" }, "T1");
    expect(next.map((d) => d.name)).toEqual(["v", "a", "b"]);
    expect(next[0]?.lastOpenedAt).toBe("T1");
  });

  test("re-activating moves the entry to the front and re-stamps it (dedupe)", () => {
    const list = [
      desc("table", "app", "a", "OLD-A"),
      desc("table", "app", "b", "OLD-B"),
      desc("table", "app", "c", "OLD-C"),
    ];
    const next = touchRecent(list, { kind: "table", db: "app", name: "c" }, "NOW");
    expect(next.map((d) => d.name)).toEqual(["c", "a", "b"]);
    expect(next[0]?.lastOpenedAt).toBe("NOW");
    expect(next).toHaveLength(3);
  });

  test("identity — not just name — decides the dedupe", () => {
    const list = [desc("table", "app", "users")];
    const next = touchRecent(list, { kind: "view", db: "app", name: "users" }, "T");
    // Different kind → different identity → both kept.
    expect(next).toHaveLength(2);
  });

  test("prunes beyond the cap, keeping the most recent", () => {
    let list: RecentDescriptor[] = [];
    for (let i = 0; i < PALETTE_RECENTS_CAP + 5; i++) {
      list = touchRecent(list, { kind: "table", db: "db", name: `t${i}` }, `T${i}`);
    }
    expect(list).toHaveLength(PALETTE_RECENTS_CAP);
    expect(list[0]?.name).toBe(`t${PALETTE_RECENTS_CAP + 4}`);
    expect(list[list.length - 1]?.name).toBe("t5"); // oldest survivors
  });

  test("does not mutate the input array", () => {
    const list = [desc("table", "app", "a")];
    const snapshot = [...list];
    touchRecent(list, { kind: "table", db: "app", name: "b" }, "T");
    expect(list).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// filterResolved (pool resolution)
// ---------------------------------------------------------------------------

describe("filterResolved", () => {
  test("drops descriptors whose object no longer exists, preserving order", () => {
    const list = [
      desc("table", "app", "alive"),
      desc("table", "app", "dropped"),
      desc("routine", "app", "calc"),
      desc("view", "gone_db", "v"),
    ];
    const known = new Set([
      "table:app.alive",
      "routine:app.calc",
    ]);
    expect(filterResolved(list, known)).toEqual([
      desc("table", "app", "alive"),
      desc("routine", "app", "calc"),
    ]);
  });

  test("an empty pool resolves to nothing (disconnected / nothing loaded)", () => {
    const list = [desc("table", "app", "users")];
    expect(filterResolved(list, new Set())).toEqual([]);
  });
});
