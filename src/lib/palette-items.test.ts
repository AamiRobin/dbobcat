import { describe, expect, test } from "bun:test";

import type { TKey } from "./i18n";
import {
  COLUMN_POOL_CAP_PER_DB,
  SCORE_EXACT,
  SCORE_FUZZY,
  SCORE_NO_MATCH,
  SCORE_PREFIX,
  SCORE_SUBSTRING,
  SCORE_WORD,
  applyScope,
  buildActionItems,
  buildColumnItems,
  buildHistoryItems,
  buildObjectItems,
  buildRecentItems,
  buildSessionItems,
  parseDbModeQuery,
  parseMode,
  parseScopedQuery,
  scoreItem,
  scoreText,
  selectDbModeItems,
  selectTop,
  sliceRecentHistory,
  type PaletteColumnItem,
  type PaletteItem,
  type PaletteObjectItem,
} from "./palette-items";
import { SESSION_COLORS } from "./session-groups";
import type {
  ColumnMeta,
  DatabaseInfo,
  EventMeta,
  HistoryEntry,
  RoutineMeta,
  SavedSession,
  TableMeta,
  TriggerMeta,
} from "@/types/ipc";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const action = (id: string, labelKey: TKey = "palette.action.newQuery"): PaletteItem => ({
  type: "action",
  id,
  labelKey,
  icon: "file-code",
  kbd: null,
  run: () => {},
});

const session = (id: string, name: string): PaletteItem => ({
  type: "session",
  id,
  name,
  group: null,
  color: null,
  connect: async () => true,
});

const obj = (
  db: string,
  name: string,
  kind: "table" | "view" = "table",
): PaletteObjectItem => ({
  type: "object",
  id: `object:${kind}:${db}.${name}`,
  db,
  name,
  kind,
});

const column = (
  db: string,
  table: string,
  name: string,
  dataType?: string,
  pk?: boolean,
): PaletteColumnItem => ({
  type: "column",
  id: `column:${db}.${table}.${name}`,
  db,
  table,
  name,
  ...(dataType !== undefined ? { dataType } : {}),
  ...(pk ? { pk: true } : {}),
});

const colMeta = (name: string, key: string | null = null): ColumnMeta => ({
  name,
  dataType: "varchar(40)",
  nullable: true,
  key,
});

const history = (
  id: string,
  sql: string,
  connName = "Local",
  executedAt = "2026-01-01T00:00:00Z",
): PaletteItem => ({
  type: "history",
  id: `history:${id}`,
  sql,
  connName,
  executedAt,
});

const savedSession = (overrides: Partial<SavedSession>): SavedSession => ({
  id: "s1",
  name: "Local",
  dbType: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  sslMode: "preferred",
  useSsh: false,
  ...overrides,
});

// ---------------------------------------------------------------------------
// parseMode
// ---------------------------------------------------------------------------

describe("parseMode", () => {
  test("leading > selects commands and strips prefix + one space", () => {
    expect(parseMode(">run")).toEqual({ mode: "commands", query: "run" });
    expect(parseMode("> run")).toEqual({ mode: "commands", query: "run" });
    expect(parseMode(">")).toEqual({ mode: "commands", query: "" });
    expect(parseMode(">   spaced")).toEqual({ mode: "commands", query: "  spaced" });
  });

  test("leading @ selects sessions and strips prefix + one space", () => {
    expect(parseMode("@prod")).toEqual({ mode: "sessions", query: "prod" });
    expect(parseMode("@ prod")).toEqual({ mode: "sessions", query: "prod" });
    expect(parseMode("@")).toEqual({ mode: "sessions", query: "" });
  });

  test("leading # selects history and strips prefix + one space", () => {
    expect(parseMode("#select")).toEqual({ mode: "history", query: "select" });
    expect(parseMode("# select")).toEqual({ mode: "history", query: "select" });
    expect(parseMode("#")).toEqual({ mode: "history", query: "" });
  });

  test("leading db: selects database-scoped mode and strips prefix + one space", () => {
    expect(parseMode("db:shop")).toEqual({ mode: "db", query: "shop" });
    expect(parseMode("db: shop")).toEqual({ mode: "db", query: "shop" });
    expect(parseMode("db:")).toEqual({ mode: "db", query: "" });
    expect(parseMode("db: shop users")).toEqual({
      mode: "db",
      query: "shop users",
    });
  });

  test("plain text stays unified verbatim", () => {
    expect(parseMode("users")).toEqual({ mode: "unified", query: "users" });
    expect(parseMode("  lead")).toEqual({ mode: "unified", query: "  lead" });
    expect(parseMode("a > b")).toEqual({ mode: "unified", query: "a > b" });
    // Only the LEADING character selects a mode.
    expect(parseMode("a #b")).toEqual({ mode: "unified", query: "a #b" });
    expect(parseMode("")).toEqual({ mode: "unified", query: "" });
  });
});

// ---------------------------------------------------------------------------
// scoreItem
// ---------------------------------------------------------------------------

describe("scoreItem tiers", () => {
  const item = obj("app", "users");

  test("empty query matches everything neutrally", () => {
    expect(scoreItem(item, "")).toBe(0);
    expect(scoreItem(item, "   ")).toBe(0);
  });

  test("exact beats prefix beats word-boundary beats substring", () => {
    // Object text is "<db>.<name>", so pick fixtures where each tier is
    // unambiguous against that shape.
    const exact = session("s0", "billing"); // text === query
    const prefix = obj("billing", "x"); // text starts with query
    const word = obj("db", "x_billing_y"); // a word starts with query
    const substring = obj("db", "xbilling"); // contains query mid-word only

    const scores = [exact, prefix, word, substring].map((i) =>
      scoreItem(i, "billing"),
    );
    expect(scores[0]).toBe(SCORE_EXACT);
    expect(scores[1]).toBe(SCORE_PREFIX);
    expect(scores[2]).toBe(SCORE_WORD);
    expect(scores[3]).toBe(SCORE_SUBSTRING);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThan(scores[i]);
    }
  });

  test("fuzzy subsequence is the literal path's last resort", () => {
    // Regex-valid queries never fall through to fuzzy (regex-first, like
    // compileTreeFilter); an INVALID regex reaches the fuzzy tail.
    const scrambled = obj("db", "b_i_l_i_n_[_g");
    expect(scoreItem(scrambled, "billing")).toBe(SCORE_NO_MATCH);
    expect(scoreItem(scrambled, "bilin[")).toBe(SCORE_FUZZY); // unclosed [ → invalid
  });

  test("word boundaries include dots, underscores and slashes", () => {
    // text is "app.user_logs"; each part starts a word.
    expect(scoreItem(obj("app", "user_logs"), "user")).toBe(SCORE_WORD);
    expect(scoreItem(obj("app", "user_logs"), "logs")).toBe(SCORE_WORD);
    expect(scoreItem(session("s", "Work/Prod"), "prod")).toBe(SCORE_WORD);
  });

  test("non-matching items are excluded", () => {
    expect(scoreItem(item, "zzz-nothing")).toBe(SCORE_NO_MATCH);
  });

  test("invalid regex falls back to literal matching (tree-filter precedent)", () => {
    // "(" alone is an invalid regex — must not throw, must match literally.
    expect(scoreItem(obj("db", "user(s(backup"), "user(s(")).toBe(SCORE_SUBSTRING);
    expect(scoreItem(item, "user(s(")).toBe(SCORE_NO_MATCH);
  });

  test("regex-valid queries are honored without /.../ delimiters", () => {
    // Regex-syntax queries rarely earn a literal tier (the pattern text
    // itself is not a prefix/substring), so pure-regex matches land fuzzy.
    expect(scoreItem(item, "^app\\.us")).toBe(SCORE_FUZZY);
    expect(scoreItem(item, "a.+rs$")).toBe(SCORE_FUZZY);
    expect(scoreItem(item, "^nope$")).toBe(SCORE_NO_MATCH);
    expect(scoreItem(obj("tmp_2024", "x"), "tmp_\\d{4}")).toBe(SCORE_FUZZY);
  });

  test("matching is case-insensitive", () => {
    expect(scoreItem(item, "USERS")).toBe(SCORE_WORD);
    expect(scoreItem(session("s", "Production"), "PROD")).toBe(SCORE_PREFIX);
  });

  test("action items resolve their label through i18n at scoring time", () => {
    // en["palette.action.newQuery"] === "New query tab"
    expect(scoreItem(action("a", "palette.action.newQuery"), "query tab")).toBe(
      SCORE_SUBSTRING,
    );
  });
});

// ---------------------------------------------------------------------------
// selectTop
// ---------------------------------------------------------------------------

describe("selectTop", () => {
  test("caps results and reports omittedCount", () => {
    const items = Array.from({ length: 7 }, (_, i) => obj("db", `t${i}`));
    const result = selectTop(items, "", 3);
    expect(result.items.length).toBe(3);
    expect(result.omittedCount).toBe(4);
  });

  test("empty query preserves composition order (sections, not scoring)", () => {
    const items = [action("a2"), action("a1"), session("s1", "Prod"), obj("db", "zeta"), obj("db", "v", "view")];
    const result = selectTop(items, "");
    expect(result.items.map((i) => i.id)).toEqual([
      "a2",
      "a1",
      "s1",
      "object:table:db.zeta",
      "object:view:db.v",
    ]);
    expect(result.omittedCount).toBe(0);
  });

  test("ranks by score across kinds", () => {
    const items = [session("s1", "userish"), obj("app", "users"), action("a1")];
    const result = selectTop(items, "users");
    // app.users hits the word-boundary tier. "userish" does not contain the
    // regex "users" and regex-valid queries never reach fuzzy; the action's
    // English label has no match either.
    expect(result.items.map((i) => i.id)).toEqual(["object:table:app.users"]);
  });

  test("deterministic tiebreak: table > view > action > session, then input order", () => {
    // Every fixture lands on the PREFIX tier for "pro" ("Process list"
    // resolves via i18n), so kind priority alone decides.
    const items = [
      session("s1", "ProdA"),
      session("s2", "ProdB"),
      action("a-proc", "palette.action.processList"),
      obj("prod", "b", "view"),
      obj("prod", "a", "table"),
    ];
    const first = selectTop(items, "pro");
    expect(first.items.map((i) => i.type)).toEqual([
      "object",
      "object",
      "action",
      "session",
      "session",
    ]);
    expect(first.items[0]?.id).toBe("object:table:prod.a");
    // Same kind sequence under a different input order — priority beats
    // composition, input order only settles same-kind ties.
    const reordered = selectTop([...items].reverse(), "PRO");
    expect(reordered.items.map((i) => i.type)).toEqual(first.items.map((i) => i.type));
  });

  test("phase-2 tiebreak extension: table > view > routine > trigger > event … history last", () => {
    // Every fixture lands on the WORD tier for "alpha" ("db.alpha",
    // "x-alpha", and a snippet containing the word) so only rankPriority
    // separates them.
    const items: PaletteItem[] = [
      history("h1", "SELECT alpha FROM t"),
      session("s1", "x-alpha"),
      {
        type: "object",
        id: "object:event:db.alpha",
        db: "db",
        name: "alpha",
        kind: "event",
      },
      {
        type: "object",
        id: "object:trigger:db.alpha",
        db: "db",
        name: "alpha",
        kind: "trigger",
      },
      {
        type: "object",
        id: "object:routine:db.alpha",
        db: "db",
        name: "alpha",
        kind: "routine",
      },
      obj("db", "alpha_view", "view"), // "db.alpha_view": word "alpha…" → word tier too
      obj("db", "alpha_table", "table"),
    ];
    const ranked = selectTop(items, "alpha").items;
    expect(ranked.map((i) => (i.type === "object" ? i.kind : i.type))).toEqual([
      "table",
      "view",
      "routine",
      "trigger",
      "event",
      "session",
      "history",
    ]);
  });

  test("cap applies after ranking, omittedCount counts ranked survivors", () => {
    const items = [
      session("s1", "bbb"), // prefix 80
      obj("db", "abb"), // substring 40
      session("s2", "bbc"), // prefix 80
    ];
    const result = selectTop(items, "bb", 2);
    expect(result.items.map((i) => i.id)).toEqual(["s1", "s2"]);
    expect(result.omittedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

describe("buildActionItems", () => {
  const idsOf = (ctx: Parameters<typeof buildActionItems>[0]) =>
    buildActionItems(ctx).map((i) => i.id);

  test("disconnected: offers connect, hides disconnect + connection-gated tools", () => {
    const ids = idsOf({ connected: false, connId: null, dialect: null });
    expect(ids).toContain("action.connect");
    expect(ids).not.toContain("action.disconnect");
    expect(ids).not.toContain("action.users");
    expect(ids).not.toContain("action.processes");
    expect(ids).not.toContain("action.variables");
    expect(ids).not.toContain("action.export");
    expect(ids).not.toContain("action.import");
    expect(ids).not.toContain("action.find-text");
  });

  test("connected mysql: full set incl. server tools, export/import, find-text", () => {
    const ids = idsOf({ connected: true, connId: 7, dialect: "mysql" });
    expect(ids).toContain("action.disconnect");
    expect(ids).not.toContain("action.connect");
    expect(ids).toContain("action.users");
    expect(ids).toContain("action.export");
    expect(ids).toContain("action.find-text");
  });

  test("connected sqlite: no sqlite-incompatible entries", () => {
    const ids = idsOf({ connected: true, connId: 3, dialect: "sqlite" });
    expect(ids).not.toContain("action.find-text");
    expect(ids).not.toContain("action.users");
    expect(ids).toContain("action.import");
  });

  test("items store the i18n KEY plus kbd hints from the registry", () => {
    const items = buildActionItems({ connected: false, connId: null, dialect: null });
    const newQuery = items.find((i) => i.id === "action.new-query")!;
    expect(newQuery.labelKey).toMatch(/^palette\.action\./);
    expect(newQuery.kbd).toBe("Mod+T");
    const about = items.find((i) => i.id === "action.about")!;
    expect(typeof about.run).toBe("function");
  });
});

describe("buildSessionItems", () => {
  test("maps name/group/color and binds connect", () => {
    const [item] = buildSessionItems([
      savedSession({ id: "s9", name: "Prod box", group: " Work/Prod ", color: SESSION_COLORS[5] }),
    ]);
    expect(item.type).toBe("session");
    expect(item.name).toBe("Prod box");
    expect(item.group).toBe("Work/Prod");
    expect(item.color).toBe(SESSION_COLORS[5]);
    expect(typeof item.connect).toBe("function");
  });

  test("unknown colors resolve to null and empty groups to null", () => {
    const [item] = buildSessionItems([savedSession({ color: "#ff0000", group: "" })]);
    expect(item.color).toBeNull();
    expect(item.group).toBeNull();
  });
});

describe("buildObjectItems", () => {
  const dbs: DatabaseInfo[] = [{ name: "app" }, { name: "shop" }];
  const tablesByDb: Record<string, TableMeta[] | undefined> = {
    app: [
      { name: "users", kind: "table" },
      { name: "v_orders", kind: "view" },
      { name: "mysql_internals", kind: "system_table" },
      { name: "mv_stats", kind: "materialized_view" },
    ],
    shop: [{ name: "orders", kind: "table" }],
    missing: [{ name: "ghost", kind: "table" }],
  };

  test("flattens dbs × tables into rows with kind from TableMeta", () => {
    const items = buildObjectItems(dbs, tablesByDb);
    expect(items.map((i) => `${i.db}.${i.name}`)).toEqual([
      "app.users",
      "app.v_orders",
      "shop.orders",
    ]);
    expect(items.find((i) => i.name === "v_orders")?.kind).toBe("view");
  });

  test("exotics stay skipped (system tables, materialized views)", () => {
    const items = buildObjectItems(dbs, tablesByDb);
    expect(items.some((i) => i.name === "mysql_internals")).toBe(false);
    expect(items.some((i) => i.name === "mv_stats")).toBe(false);
  });

  test("ids are unique per kind+db+name", () => {
    const items = buildObjectItems([{ name: "db" }], {
      db: [
        { name: "x", kind: "table" },
        { name: "x", kind: "view" },
      ],
    });
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });

  test("second wave fans out routines (with routineKind), triggers and events", () => {
    const routinesByDb: Record<string, RoutineMeta[] | undefined> = {
      app: [
        { name: "calc_total", kind: "function" },
        { name: "do_sync", kind: "procedure" },
      ],
    };
    const triggersByDb: Record<string, TriggerMeta[] | undefined> = {
      shop: [{ name: "orders_audit", timing: "AFTER", event: "INSERT", table: "orders" }],
    };
    const eventsByDb: Record<string, EventMeta[] | undefined> = {
      shop: [{ name: "nightly_rollup", status: "ENABLED" }],
    };

    const items = buildObjectItems(dbs, tablesByDb, routinesByDb, triggersByDb, eventsByDb);
    const routineItems = items.filter((i) => i.kind === "routine");
    expect(routineItems.map((i) => `${i.db}.${i.name}`)).toEqual([
      "app.calc_total",
      "app.do_sync",
    ]);
    expect(routineItems[0]?.routineKind).toBe("function");
    expect(routineItems[1]?.routineKind).toBe("procedure");

    const triggerItem = items.find((i) => i.kind === "trigger");
    expect(triggerItem?.db).toBe("shop");
    expect(triggerItem?.name).toBe("orders_audit");
    // Triggers carry no routineKind.
    expect(triggerItem?.routineKind).toBeUndefined();

    const eventItem = items.find((i) => i.kind === "event");
    expect(eventItem?.name).toBe("nightly_rollup");

    // All ids remain unique across kinds.
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  test("omitted second-wave pools simply contribute no rows", () => {
    const items = buildObjectItems(dbs, tablesByDb);
    expect(items.every((i) => i.kind === "table" || i.kind === "view")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// History builders
// ---------------------------------------------------------------------------

describe("history builders", () => {
  const entry = (
    id: string,
    sql: string,
    executedAt: string,
    connName = "Local",
  ): HistoryEntry => ({ id, sql, connName, executedAt });

  test("buildHistoryItems maps entries to namespaced palette rows", () => {
    const [item] = buildHistoryItems([entry("e1", "SELECT 1", "2026-01-01T00:00:00Z", "Prod")]);
    expect(item.type).toBe("history");
    expect(item.id).toBe("history:e1");
    expect(item.sql).toBe("SELECT 1");
    expect(item.connName).toBe("Prod");
    expect(item.executedAt).toBe("2026-01-01T00:00:00Z");
  });

  test("sliceRecentHistory keeps the newest entries regardless of input order", () => {
    const entries = [
      entry("old", "SELECT 1", "2025-06-01T00:00:00Z"),
      entry("newest", "SELECT 4", "2026-03-01T00:00:00Z"),
      entry("mid", "SELECT 3", "2026-02-01T00:00:00Z"),
      entry("older", "SELECT 2", "2025-12-01T00:00:00Z"),
    ];
    const sliced = sliceRecentHistory(entries, 2);
    expect(sliced.map((e) => e.id)).toEqual(["newest", "mid"]);
  });

  test("sliceRecentHistory default limit is 8", () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      entry(`e${i}`, `SELECT ${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );
    expect(sliceRecentHistory(entries)).toHaveLength(8);
  });

  test("history rows flow through scoreItem/selectTop like everything else", () => {
    const item = history("h", "SELECT * FROM user_logs LIMIT 10", "Prod box");
    // Underscores are word separators, so "logs" hits the word tier…
    expect(scoreItem(item, "logs")).toBe(SCORE_WORD);
    // …while the full "user_logs" matches mid-text (substring).
    expect(scoreItem(item, "user_logs")).toBe(SCORE_SUBSTRING);
    // The connection name participates in matching too.
    expect(scoreItem(item, "prod")).toBe(SCORE_WORD);

    const ranked = selectTop([session("s", "unrelated"), item], "user_logs");
    expect(ranked.items.map((i) => i.id)).toEqual(["history:h"]);
  });
});

// ---------------------------------------------------------------------------
// Recents → palette rows
// ---------------------------------------------------------------------------

describe("buildRecentItems", () => {
  test("maps descriptors to object rows stamped with lastOpenedAt", () => {
    const items = buildRecentItems([
      { kind: "view", db: "app", name: "v_orders", lastOpenedAt: "2026-08-01T10:00:00Z" },
      { kind: "table", db: "shop", name: "orders", lastOpenedAt: "2026-08-02T09:00:00Z" },
    ]);
    expect(items.map((i) => i.id)).toEqual([
      "object:view:app.v_orders",
      "object:table:shop.orders",
    ]);
    expect(items.every((i) => i.lastOpenedAt !== undefined)).toBe(true);
  });

  test("recents keep descriptor order (LRU order passes straight through)", () => {
    const items = buildRecentItems([
      { kind: "table", db: "a", name: "z_first", lastOpenedAt: "2026-01-01T00:00:00Z" },
      { kind: "table", db: "b", name: "a_second", lastOpenedAt: "2025-01-01T00:00:00Z" },
    ]);
    expect(items[0]?.name).toBe("z_first");
  });
});

// ---------------------------------------------------------------------------
// Phase 3: scoped queries (`db.object` / `db.object.column`)
// ---------------------------------------------------------------------------

describe("parseScopedQuery", () => {
  const dbs = ["shop", "app", "MyDb"];

  test("two segments scope objects to a known db with the remainder as query", () => {
    expect(parseScopedQuery("shop.ord", dbs)).toEqual({
      kind: "objects",
      db: "shop",
      query: "ord",
    });
  });

  test("trailing dot = empty remainder (list everything in the db)", () => {
    expect(parseScopedQuery("shop.", dbs)).toEqual({
      kind: "objects",
      db: "shop",
      query: "",
    });
    expect(parseScopedQuery("shop", dbs)).toBeNull(); // no dot → plain
  });

  test("three segments scope columns to db.table", () => {
    expect(parseScopedQuery("shop.users.email", dbs)).toEqual({
      kind: "columns",
      db: "shop",
      table: "users",
      query: "email",
    });
    // Lenient trailing dot lists all columns of the table.
    expect(parseScopedQuery("app.users.", dbs)).toEqual({
      kind: "columns",
      db: "app",
      table: "users",
      query: "",
    });
  });

  test("unknown db falls back to plain unified matching (no dead end)", () => {
    expect(parseScopedQuery("zzz.ord", dbs)).toBeNull();
    expect(parseScopedQuery("users.email", dbs)).toBeNull(); // users is no db
  });

  test("malformed input falls back: 4 segments, empty middle, whitespace, quotes", () => {
    expect(parseScopedQuery("shop.users.email.x", dbs)).toBeNull();
    expect(parseScopedQuery("shop..x", dbs)).toBeNull();
    expect(parseScopedQuery("sh op.x", dbs)).toBeNull();
    expect(parseScopedQuery("`shop`.x", dbs)).toBeNull();
    expect(parseScopedQuery('"shop".x', dbs)).toBeNull();
  });

  test("db segment matches case-insensitively and returns the known spelling", () => {
    expect(parseScopedQuery("SHOP.ord", dbs)).toEqual({
      kind: "objects",
      db: "shop",
      query: "ord",
    });
    expect(parseScopedQuery("mydb.x", dbs)).toEqual({
      kind: "objects",
      db: "MyDb",
      query: "x",
    });
  });

  test("identifier segments allow unicode letters, digits, _ and $", () => {
    expect(parseScopedQuery("app.order_items.$total", dbs)).not.toBeNull();
    expect(parseScopedQuery("app.café.x", dbs)).not.toBeNull();
  });

  test("applyScope filters objects by canonical db", () => {
    const objects = [obj("shop", "orders"), obj("app", "users")];
    const scope = parseScopedQuery("shop.", dbs)!;
    expect(applyScope(scope, objects, []).map((i) => i.id)).toEqual([
      "object:table:shop.orders",
    ]);
  });

  test("applyScope filters columns by db + case-insensitive table", () => {
    const columns = [
      column("shop", "orders", "id"),
      column("shop", "Users", "email"),
      column("app", "users", "name"),
    ];
    const scope = parseScopedQuery("shop.users.", dbs)!;
    expect(applyScope(scope, [], columns).map((i) => i.id)).toEqual([
      "column:shop.Users.email",
    ]);
  });

  test("scoped ranking stays inside the db: selectTop over applyScope output", () => {
    const objects = [obj("shop", "orders"), obj("shop", "ord_history"), obj("app", "ord")];
    const scope = parseScopedQuery("shop.ord", dbs)!;
    const ranked = selectTop(applyScope(scope, objects, []), scope.query);
    // Both shop hits land on the word tier ("ord" starts both words); the
    // app.ord row is scoped out entirely, and the equal-tier tie falls to
    // composition order.
    expect(ranked.items.map((i) => i.id)).toEqual([
      "object:table:shop.orders",
      "object:table:shop.ord_history",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: column items
// ---------------------------------------------------------------------------

describe("buildColumnItems", () => {
  const dbs: DatabaseInfo[] = [{ name: "app" }, { name: "shop" }];
  const tablesByDb: Record<string, TableMeta[] | undefined> = {
    app: [
      { name: "users", kind: "table" },
      { name: "v_orders", kind: "view" }, // views have no column children
      { name: "mysql_internals", kind: "system_table" },
    ],
    shop: [{ name: "orders", kind: "table" }],
  };
  const columnsByDb = {
    app: { users: [colMeta("id", "PRI"), colMeta("email")] },
    shop: { orders: [colMeta("total")] },
  };

  test("flattens landed dbs × tables into rows carrying dataType + pk flag", () => {
    const items = buildColumnItems(dbs, tablesByDb, columnsByDb);
    expect(items.map((i) => `${i.db}.${i.table}.${i.name}`)).toEqual([
      "app.users.id",
      "app.users.email",
      "shop.orders.total",
    ]);
    const pk = items[0];
    expect(pk?.pk).toBe(true);
    expect(pk?.dataType).toBe("varchar(40)");
    expect(items[1]?.pk).toBeUndefined();
  });

  test("ids are unique", () => {
    const items = buildColumnItems(dbs, tablesByDb, columnsByDb);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  test("dbs whose tables wave has not landed contribute nothing (no crash)", () => {
    const items = buildColumnItems([{ name: "ghost" }], {}, columnsByDb);
    expect(items).toEqual([]);
  });

  test("per-db cap truncates deterministically without touching other dbs", () => {
    const manyTables: Record<string, TableMeta[] | undefined> = {
      big: [
        { name: "a", kind: "table" },
        { name: "b", kind: "table" },
      ],
      small: [{ name: "s", kind: "table" }],
    };
    const columns = {
      big: { a: [colMeta("a1"), colMeta("a2")], b: [colMeta("b1"), colMeta("b2")] },
      small: { s: [colMeta("s1")] },
    };
    const dbsBoth: DatabaseInfo[] = [{ name: "small" }, { name: "big" }];
    const items = buildColumnItems(dbsBoth, manyTables, columns, 3);
    // The cap is PER DB: small keeps its single column, big fills 3 slots
    // across tables in tree order and b2 spills past the cap.
    expect(items.map((i) => i.name)).toEqual(["s1", "a1", "a2", "b1"]);
    expect(items.some((i) => i.name === "b2")).toBe(false);
    // Default cap constant is the documented 2000.
    expect(COLUMN_POOL_CAP_PER_DB).toBe(2000);
  });

  test("columns flow through scoreItem via their dotted path text", () => {
    const item = column("shop", "users", "email");
    expect(scoreItem(item, "email")).toBe(SCORE_WORD); // dots start words
    expect(scoreItem(item, "users")).toBe(SCORE_WORD);
    expect(scoreItem(item, "shop")).toBe(SCORE_PREFIX);
    expect(scoreItem(item, "zzz")).toBe(SCORE_NO_MATCH);
  });

  test("tiebreak chain: column ranks below event but above action/session/history", () => {
    // Every fixture lands on the WORD tier for "tab" (action label "New
    // query tab" resolves via i18n) so only rankPriority separates them.
    const items: PaletteItem[] = [
      history("h1", "SELECT tab FROM t"),
      session("s1", "x-tab"),
      action("a-tab", "palette.action.newQuery"),
      column("db", "t", "tab_col"),
      obj("db", "tab_view", "view"),
      {
        type: "object",
        id: "object:event:db.tab",
        db: "db",
        name: "tab",
        kind: "event",
      },
      {
        type: "object",
        id: "object:trigger:db.tab",
        db: "db",
        name: "tab",
        kind: "trigger",
      },
      {
        type: "object",
        id: "object:routine:db.tab",
        db: "db",
        name: "tab",
        kind: "routine",
      },
      obj("db", "tab_table", "table"),
    ];
    const ranked = selectTop(items, "tab").items;
    expect(ranked.map((i) => (i.type === "object" ? i.kind : i.type))).toEqual([
      "table",
      "view",
      "routine",
      "trigger",
      "event",
      "column",
      "action",
      "session",
      "history",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: `db:` mode
// ---------------------------------------------------------------------------

describe("parseDbModeQuery", () => {
  test("first token selects the db, the rest filters within it", () => {
    expect(parseDbModeQuery("shop")).toEqual({ dbToken: "shop", rest: "" });
    expect(parseDbModeQuery("shop users email")).toEqual({
      dbToken: "shop",
      rest: "users email",
    });
    expect(parseDbModeQuery("  shop   users ")).toEqual({
      dbToken: "shop",
      rest: "users",
    });
    expect(parseDbModeQuery("")).toEqual({ dbToken: "", rest: "" });
  });
});

describe("selectDbModeItems", () => {
  const objects = [obj("app", "users"), obj("shop", "orders"), obj("shop", "order_lines")];
  const columns = [column("shop", "orders", "total"), column("app", "users", "email")];

  test("empty query lists object sections in composition order, never columns", () => {
    const result = selectDbModeItems(objects, columns, "");
    expect(result.items.map((i) => i.id)).toEqual(objects.map((o) => o.id));
    expect(result.omittedCount).toBe(0);

    const capped = selectDbModeItems(objects, columns, " ", 2);
    expect(capped.items.length).toBe(2);
    expect(capped.omittedCount).toBe(1);
  });

  test("db token narrows objects AND columns of matching dbs", () => {
    const result = selectDbModeItems(objects, columns, "shop");
    expect(result.items.map((i) => i.id)).toContain("object:table:shop.orders");
    expect(result.items.map((i) => i.id)).toContain("column:shop.orders.total");
    expect(
      result.items.some((i) => (i.type === "object" || i.type === "column") && i.db === "app"),
    ).toBe(false);
  });

  test("rest filters within the matched dbs (multi-token AND)", () => {
    const result = selectDbModeItems(objects, columns, "shop order");
    expect(result.items.map((i) => i.id)).toEqual([
      "object:table:shop.orders",
      "object:table:shop.order_lines",
      "column:shop.orders.total",
    ]);
  });

  test("no db matching the token dead-ends honestly (explicit mode)", () => {
    expect(selectDbModeItems(objects, columns, "zzz").items).toEqual([]);
  });

  test("columns tiebreak below objects within one db", () => {
    const tightObjects = [obj("shop", "email_archive")];
    const tightColumns = [column("shop", "users", "email")];
    const result = selectDbModeItems(tightObjects, tightColumns, "shop email");
    // Same WORD tier for both — object first per rankPriority.
    expect(result.items.map((i) => i.type)).toEqual(["object", "column"]);
  });
});

describe("scoreText", () => {
  test("scores bare text with the same tiers as scoreItem", () => {
    expect(scoreText("billing", "billing")).toBe(SCORE_EXACT);
    expect(scoreText("billing.profiles", "billing")).toBe(SCORE_PREFIX);
    expect(scoreText("x_billing_y", "billing")).toBe(SCORE_WORD);
    expect(scoreText("xbilling", "billing")).toBe(SCORE_SUBSTRING);
    expect(scoreText("nothing", "zzz")).toBe(SCORE_NO_MATCH);
    expect(scoreText("anything", "")).toBe(0);
  });
});
