import { describe, expect, test } from "bun:test";

import {
  generateDelete,
  generateInsert,
  generateSelect,
  generateUpdate,
  placeholder,
  qualifyTable,
  quoteIdent,
} from "./query-generate";

describe("quoteIdent", () => {
  test("mysql uses backticks with doubling", () => {
    expect(quoteIdent("users", "mysql")).toBe("`users`");
    expect(quoteIdent("we`ird", "mysql")).toBe("`we``ird`");
    expect(quoteIdent("my table", "mysql")).toBe("`my table`");
  });

  test("postgres and sqlite double double-quotes", () => {
    for (const dialect of ["postgres", "sqlite"] as const) {
      expect(quoteIdent("users", dialect)).toBe('"users"');
      expect(quoteIdent('a"b', dialect)).toBe('"a""b"');
    }
  });
});

describe("qualifyTable", () => {
  test("quotes both parts", () => {
    expect(qualifyTable("shop", "orders", "mysql")).toBe("`shop`.`orders`");
    expect(qualifyTable("public", "orders", "postgres")).toBe('"public"."orders"');
  });
});

describe("placeholder", () => {
  test("question marks except numbered postgres marks", () => {
    expect(placeholder("mysql", 3)).toBe("?");
    expect(placeholder("sqlite", 7)).toBe("?");
    expect(placeholder("postgres", 1)).toBe("$1");
    expect(placeholder("postgres", 12)).toBe("$12");
  });
});

describe("generateSelect", () => {
  test("lists checked columns in order", () => {
    const sql = generateSelect(
      { db: "shop", table: "orders", columns: ["id", "total"] },
      "mysql",
    );
    expect(sql).toBe("SELECT `id`, `total`\nFROM `shop`.`orders`;");
  });

  test("no checked columns selects star", () => {
    const sql = generateSelect({ db: "shop", table: "orders", columns: [] }, "postgres");
    expect(sql).toBe('SELECT *\nFROM "shop"."orders";');
  });
});

describe("generateInsert", () => {
  test("one placeholder per column, numbered on postgres", () => {
    const sql = generateInsert(
      { db: "shop", table: "items", columns: ["name", "price"] },
      "postgres",
    );
    expect(sql).toBe('INSERT INTO "shop"."items" ("name", "price")\nVALUES ($1, $2);');
  });

  test("mysql repeats question marks", () => {
    const sql = generateInsert(
      { db: "shop", table: "items", columns: ["a", "b"] },
      "mysql",
    );
    expect(sql).toContain("VALUES (?, ?);");
  });

  test("empty selection generates nothing", () => {
    expect(generateInsert({ db: "d", table: "t", columns: [] }, "mysql")).toBe("");
  });
});

describe("generateUpdate", () => {
  test("sets every checked column to its own placeholder", () => {
    const sql = generateUpdate(
      { db: "shop", table: "items", columns: ["price", "note"] },
      "sqlite",
    );
    expect(sql).toBe(
      'UPDATE "shop"."items"\nSET "price" = ?, "note" = ?\nWHERE <condition>;',
    );
  });

  test("empty selection generates nothing", () => {
    expect(generateUpdate({ db: "d", table: "t", columns: [] }, "mysql")).toBe("");
  });
});

describe("generateDelete", () => {
  test("always carries a WHERE guard", () => {
    const sql = generateDelete({ db: "shop", table: "items", columns: [] }, "mysql");
    expect(sql).toBe("DELETE FROM `shop`.`items`\nWHERE <condition>;");
  });
});
