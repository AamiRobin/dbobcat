import { describe, expect, test } from "bun:test";

import type { TKey } from "./i18n";
import {
  SCORE_EXACT,
  SCORE_FUZZY,
  SCORE_NO_MATCH,
  SCORE_PREFIX,
  SCORE_SUBSTRING,
  SCORE_WORD,
  buildActionItems,
  buildObjectItems,
  buildSessionItems,
  parseMode,
  scoreItem,
  selectTop,
  type PaletteItem,
} from "./palette-items";
import { SESSION_COLORS } from "./session-groups";
import type { DatabaseInfo, SavedSession, TableMeta } from "@/types/ipc";

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

const obj = (db: string, name: string, kind: "table" | "view" = "table"): PaletteItem => ({
  type: "object",
  id: `object:${kind}:${db}.${name}`,
  db,
  name,
  kind,
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

  test("plain text stays unified verbatim", () => {
    expect(parseMode("users")).toEqual({ mode: "unified", query: "users" });
    expect(parseMode("  lead")).toEqual({ mode: "unified", query: "  lead" });
    expect(parseMode("a > b")).toEqual({ mode: "unified", query: "a > b" });
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

  test("v1 scope keeps tables/views only (exotics skipped)", () => {
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
});
