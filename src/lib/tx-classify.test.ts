import { describe, expect, test } from "bun:test";

import { classify, hasImplicitCommitDdl, leadingKeywords } from "./tx-classify";

/**
 * Mirrors `src-tauri/src/connections/tx.rs` unit tests — the statement
 * corpus below MUST stay identical on both sides (dual maintenance, like
 * script.rs ↔ sql-splitter.ts).
 */
describe("classify (mirror of Rust tx.rs tests)", () => {
  test("is case and whitespace tolerant", () => {
    expect(classify("mysql", "  select 1")).toBe("select");
    expect(classify("mysql", "\n\tINSERT INTO t VALUES (1)")).toBe("dml");
    expect(classify("postgres", "commit")).toBe("tcl");
  });

  test("skips leading comments", () => {
    expect(classify("mysql", "-- note\n# hash\n/* block */ SELECT 1")).toBe("select");
    expect(classify("mysql", " /* c */ UPDATE t SET x = 1")).toBe("dml");
    // `--x` is code, not a comment.
    expect(classify("mysql", "--x SELECT 1")).toBe("other");
  });

  test("comment-only and empty input classify other", () => {
    expect(classify("mysql", "-- nothing")).toBe("other");
    expect(classify("mysql", "   ")).toBe("other");
    expect(classify("mysql", "")).toBe("other");
  });

  test("transaction control statements", () => {
    expect(classify("mysql", "START TRANSACTION")).toBe("tcl");
    expect(classify("mysql", "BEGIN")).toBe("tcl");
    expect(classify("mysql", "BEGIN WORK")).toBe("tcl");
    expect(classify("postgres", "END")).toBe("tcl");
    expect(classify("postgres", "ROLLBACK")).toBe("tcl");
    expect(classify("postgres", "ABORT")).toBe("tcl");
    expect(classify("mysql", "SAVEPOINT sp1")).toBe("tcl");
  });

  test("MySQL DDL implies commit", () => {
    expect(classify("mysql", "CREATE TABLE t (id int)")).toBe("ddl-commit");
    expect(classify("mysql", "alter table t add c int")).toBe("ddl-commit");
    expect(classify("mysql", "DROP INDEX ix ON t")).toBe("ddl-commit");
    expect(classify("mysql", "RENAME TABLE a TO b")).toBe("ddl-commit");
    expect(classify("mysql", "truncate table t")).toBe("ddl-commit");
  });

  test("MySQL TEMPORARY exceptions", () => {
    expect(classify("mysql", "CREATE TEMPORARY TABLE t (id int)")).toBe("ddl");
    expect(classify("mysql", "DROP TEMPORARY TABLE IF EXISTS t")).toBe("ddl");
    // ALTER TEMPORARY is treated as committing like any other ALTER.
    expect(classify("mysql", "ALTER TEMPORARY TABLE t ADD x int")).toBe("ddl-commit");
  });

  test("PostgreSQL DDL never commits implicitly", () => {
    expect(classify("postgres", "CREATE TABLE t (id int)")).toBe("ddl");
    expect(classify("postgres", "CREATE TEMPORARY TABLE t (id int)")).toBe("ddl");
    expect(classify("postgres", "TRUNCATE t")).toBe("ddl");
    expect(classify("postgres", "drop table t")).toBe("ddl");
  });

  test("misc statements classify other (documented gaps)", () => {
    expect(classify("mysql", "SET autocommit = 0")).toBe("other");
    expect(classify("mysql", "SHOW TABLES")).toBe("other");
    expect(classify("mysql", "USE shop")).toBe("other");
    expect(classify("mysql", "LOCK TABLES t WRITE")).toBe("other");
    expect(classify("mysql", "CALL do_stuff()")).toBe("other");
  });

  test("WITH leading CTE counts as select", () => {
    expect(classify("mysql", "WITH x AS (SELECT 1) SELECT * FROM x")).toBe("select");
  });
});

describe("leadingKeywords", () => {
  test("returns up to count uppercased keywords across comments", () => {
    expect(leadingKeywords("/* c */ create temporary table x", 2)).toEqual([
      "CREATE",
      "TEMPORARY",
    ]);
    expect(leadingKeywords("-- hi\nSELECT", 1)).toEqual(["SELECT"]);
    expect(leadingKeywords("", 2)).toEqual([]);
  });
});

describe("hasImplicitCommitDdl", () => {
  const script = [
    "UPDATE accounts SET balance = balance - 10",
    "CREATE TABLE audit_log (id int)", // implicit commit on MySQL
    "INSERT INTO audit_log VALUES (1)",
  ];

  test("flags MySQL scripts containing committing DDL", () => {
    expect(hasImplicitCommitDdl(script, "mysql")).toBe(true);
  });

  test("PostgreSQL DDL does not trigger the warning", () => {
    expect(hasImplicitCommitDdl(script, "postgres")).toBe(false);
  });

  test("temporary-table DDL does not trigger the warning", () => {
    expect(
      hasImplicitCommitDdl(["CREATE TEMPORARY TABLE scratch (id int)"], "mysql"),
    ).toBe(false);
  });

  test("plain DML scripts stay clean", () => {
    expect(
      hasImplicitCommitDdl(["DELETE FROM t WHERE id = 1", "SELECT 1"], "mysql"),
    ).toBe(false);
    expect(hasImplicitCommitDdl([], "mysql")).toBe(false);
  });
});
