import { describe, expect, test } from "bun:test";

import { detectQueryTable } from "@/lib/query-table-detect";

describe("detectQueryTable", () => {
  test("plain unqualified select", () => {
    expect(detectQueryTable("SELECT * FROM users")).toEqual({
      db: null,
      table: "users",
    });
  });

  test("qualified db.table", () => {
    expect(detectQueryTable("SELECT id FROM shop.users WHERE id > 3")).toEqual({
      db: "shop",
      table: "users",
    });
  });

  test("quoted identifiers with embedded spaces", () => {
    expect(
      detectQueryTable("SELECT `my col` FROM `my db`.`my table`"),
    ).toEqual({ db: "my db", table: "my table" });
  });

  test("alias without AS", () => {
    expect(detectQueryTable("SELECT u.* FROM users u LIMIT 10 OFFSET 5")).toEqual({
      db: null,
      table: "users",
    });
  });

  test("alias with AS and WHERE clause", () => {
    expect(
      detectQueryTable("select name as n from users AS u where u.id = 1"),
    ).toEqual({ db: null, table: "users" });
  });

  test("comments are stripped", () => {
    expect(
      detectQueryTable(
        "-- lookup\nSELECT * /* all cols */ FROM users -- latest\n",
      ),
    ).toEqual({ db: null, table: "users" });
  });

  test("rejects explicit joins", () => {
    expect(detectQueryTable("SELECT * FROM users JOIN orders ON orders.user_id = users.id")).toBeNull();
    expect(detectQueryTable("SELECT * FROM users u LEFT JOIN orders o ON o.uid = u.id")).toBeNull();
  });

  test("rejects comma joins", () => {
    expect(detectQueryTable("SELECT * FROM users, orders")).toBeNull();
  });

  test("rejects subqueries in FROM", () => {
    expect(detectQueryTable("SELECT * FROM (SELECT id FROM users) t")).toBeNull();
  });

  test("rejects WITH (CTEs)", () => {
    expect(
      detectQueryTable("WITH recent AS (SELECT id FROM users) SELECT * FROM recent"),
    ).toBeNull();
  });

  test("rejects UNION / set operations", () => {
    expect(detectQueryTable("SELECT id FROM users UNION SELECT id FROM admins")).toBeNull();
  });

  test("rejects subquery inside WHERE", () => {
    expect(
      detectQueryTable(
        "SELECT name FROM users WHERE id IN (SELECT user_id FROM banned)",
      ),
    ).toBeNull();
  });

  test("rejects non-SELECT statements", () => {
    expect(detectQueryTable("UPDATE users SET name = 'x'")).toBeNull();
    expect(detectQueryTable("DELETE FROM users")).toBeNull();
    expect(detectQueryTable("")).toBeNull();
  });

  test("accepts simple WHERE over the same table", () => {
    expect(
      detectQueryTable("SELECT id, name FROM shop.users WHERE active = 1 AND id < 100"),
    ).toEqual({ db: "shop", table: "users" });
  });
});
