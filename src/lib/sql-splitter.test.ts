import { describe, expect, test } from "bun:test";

import { splitStatements, statementAtOffset } from "./sql-splitter";

const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

describe("splitStatements", () => {
  test("splits on semicolons and keeps text", () => {
    expect(texts("SELECT 1; SELECT 2 ;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("trailing statement without semicolon is kept", () => {
    expect(texts("SELECT 1")).toEqual(["SELECT 1"]);
    expect(texts("SELECT 1;\nSELECT 'a'")).toEqual(["SELECT 1", "SELECT 'a'"]);
  });

  test("semicolons inside strings do not split", () => {
    expect(texts("SELECT 'a;b'; SELECT \"x;y\";")).toEqual([
      "SELECT 'a;b'",
      'SELECT "x;y"',
    ]);
  });

  test("escaped quotes and doubled quotes stay in literal", () => {
    expect(texts(String.raw`SELECT 'it\'s; ok'); SELECT 'a''b';`)).toEqual([
      String.raw`SELECT 'it\'s; ok')`,
      "SELECT 'a''b'",
    ]);
  });

  test("backtick identifiers with semicolons do not split", () => {
    expect(texts("SELECT `we;ird` FROM `t``x`;")).toEqual([
      "SELECT `we;ird` FROM `t``x`",
    ]);
    // Backslash is literal inside backticks: boundary right after it.
    expect(texts("SELECT `a\\`; SELECT 1")).toEqual(["SELECT `a\\`", "SELECT 1"]);
  });

  test("line comments are not executed", () => {
    expect(
      texts("SELECT 1 -- comment; with semicolon\n; SELECT 2"),
    ).toEqual(["SELECT 1 -- comment; with semicolon", "SELECT 2"]);
    expect(texts("# whole line;\nSELECT 3")).toEqual(["# whole line;\nSELECT 3"]);
  });

  test("double dash without space is an operator", () => {
    expect(texts("SELECT 5--2;")).toEqual(["SELECT 5--2"]);
  });

  test("block comments never split", () => {
    expect(texts("SELECT /* a;b;c */ 1;")).toEqual(["SELECT /* a;b;c */ 1"]);
    // Unterminated block comment swallows everything.
    expect(texts("SELECT 1; /* open")).toEqual(["SELECT 1"]);
  });

  test("comment-only chunks are dropped", () => {
    expect(texts("-- nothing\n; /* also nothing */ ;;")).toEqual([]);
    expect(texts("")).toEqual([]);
    expect(texts("   \n\t ")).toEqual([]);
  });

  test("empty statements between semicolons skipped", () => {
    expect(texts(";;SELECT 1;; ;SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });
});

describe("statementAtOffset", () => {
  const sql = "SELECT 1;\nSELECT a FROM b;\n";

  test("returns the statement under the caret", () => {
    const s = statementAtOffset(sql, 12); // inside second statement
    expect(s?.text).toBe("SELECT a FROM b");
    // Offsets map back into the source document.
    expect(sql.slice(s!.start, s!.end)).toBe("SELECT a FROM b");
  });

  test("caret before the semicolon selects that statement", () => {
    expect(statementAtOffset(sql, 8)?.text).toBe("SELECT 1");
  });

  test("caret on/after the semicolon selects the next statement", () => {
    expect(statementAtOffset(sql, 9)?.text).toBe("SELECT a FROM b");
    expect(statementAtOffset(sql, sql.length)?.text).toBe("SELECT a FROM b");
  });

  test("returns null for comment-only or empty regions", () => {
    expect(statementAtOffset("-- just a comment\n", 5)).toBeNull();
    expect(statementAtOffset("", 0)).toBeNull();
  });

  test("works with strings containing semicolons", () => {
    const tricky = "SELECT ';x' FROM t";
    expect(statementAtOffset(tricky, 9)?.text).toBe(tricky);
  });
});
