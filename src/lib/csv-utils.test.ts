import { describe, expect, test } from "bun:test";

import {
  guessDelimiter,
  looksLikeHeader,
} from "@/lib/csv-utils";
import {
  autoMapColumns,
  guessColumnTypes,
  summarizeImport,
} from "@/lib/import-queries";
import { defaultExportFileName, defaultSqlDumpOptions } from "@/lib/export-queries";

describe("guessDelimiter", () => {
  test("picks comma for plain csv", () => {
    expect(guessDelimiter("a,b,c\n1,2,3\n4,5,6\n")).toBe(",");
  });

  test("picks semicolon when commas are rare", () => {
    expect(guessDelimiter("a;b;c\n1;2;3\n")).toBe(";");
  });

  test("detects tabs", () => {
    expect(guessDelimiter("a\tb\tc\n1\t2\t3\n")).toBe("\t");
  });

  test("delimiters inside quotes do not count", () => {
    // The comma inside quotes must not make comma the winner.
    const text = 'name;note\n"Doe, Jane";x\n"Smith, John";y\n';
    expect(guessDelimiter(text)).toBe(";");
  });

  test("falls back to comma for unstructured text", () => {
    expect(guessDelimiter("just one long line of text")).toBe(",");
  });
});

describe("looksLikeHeader", () => {
  test("identifier row counts as header", () => {
    expect(looksLikeHeader("id,name,score", ",")).toBe(true);
  });

  test("numeric first row does not", () => {
    expect(looksLikeHeader("1,2,3", ",")).toBe(false);
  });
});

describe("autoMapColumns", () => {
  test("maps case-insensitively and leaves unknowns unmapped", () => {
    const mapping = autoMapColumns(
      ["ID", "Name", "extra"],
      [{ name: "id" }, { name: "name" }],
    );
    expect(mapping).toEqual(["id", "name", null]);
  });
});

describe("guessColumnTypes", () => {
  test("samples int, float and text", () => {
    const cols = guessColumnTypes(
      ["n", "f", "t"],
      [
        ["1", "1.5", "abc"],
        ["42", "-2.25", null],
        ["7", "3", ""],
      ],
    );
    expect(cols).toEqual([
      { name: "n", dataType: "INT" },
      { name: "f", dataType: "DOUBLE" },
      { name: "t", dataType: "TEXT" },
    ]);
  });

  test("empty samples fall back to TEXT", () => {
    const cols = guessColumnTypes(["e"], [[null], [""]]);
    expect(cols[0].dataType).toBe("TEXT");
  });
});

describe("summarizeImport", () => {
  test("mentions skipped rows only when present", () => {
    const summary = summarizeImport({
      inserted: 120,
      skipped: 3,
      errors: [],
      elapsedMs: 45,
    });
    expect(summary).toContain("120 row(s) inserted");
    expect(summary).toContain("3 skipped");

    const clean = summarizeImport({ inserted: 5, skipped: 0, errors: [], elapsedMs: 9 });
    expect(clean).not.toContain("skipped");
  });
});

describe("dump option marshaling", () => {
  test("default options carry heidi-like values per db", () => {
    const opts = defaultSqlDumpOptions(["shop", "shop2"]);
    expect(opts.dbs).toEqual(["shop", "shop2"]);
    expect(opts.what).toBe("structure_and_data");
    expect(opts.dropAdd).toBe(true);
    expect(opts.extendedInserts).toBe(true);
    expect(opts.includeRoutines).toBe(false);
  });

  test("file names sanitize stems and track format extensions", () => {
    expect(defaultExportFileName("order items!", "csv")).toBe("order_items_export.csv");
    expect(defaultExportFileName("users", "sql_inserts")).toBe("users_export.sql");
    expect(defaultExportFileName("r", "markdown")).toBe("r_export.md");
  });
});
