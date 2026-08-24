import { describe, expect, test } from "bun:test";

import { parseTsvRows, tsvCellToRowValue } from "@/lib/tsv-paste";

describe("parseTsvRows", () => {
  test("splits rows and cells", () => {
    expect(parseTsvRows("a\tb\tc\n1\t2\t3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  test("handles CRLF and CR line endings (spreadsheet paste)", () => {
    expect(parseTsvRows("a\tb\r\n1\t2\r")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("drops trailing empty lines but keeps interior empties", () => {
    expect(parseTsvRows("a\tb\n\n")).toEqual([["a", "b"]]);
    expect(parseTsvRows("a\tb\n\n1\t2")).toEqual([
      ["a", "b"],
      [""],
      ["1", "2"],
    ]);
  });

  test("keeps empty string cells and ragged rows as-is", () => {
    expect(parseTsvRows("a\t\tx")).toEqual([["a", "", "x"]]);
    expect(parseTsvRows("one-cell")).toEqual([["one-cell"]]);
  });

  test("empty clipboard yields no rows", () => {
    expect(parseTsvRows("")).toEqual([]);
    expect(parseTsvRows("\n\n")).toEqual([]);
  });
});

describe("tsvCellToRowValue", () => {
  test("literal NULL becomes SQL NULL", () => {
    expect(tsvCellToRowValue("NULL")).toEqual({ t: "null" });
    // Anything else is text — including lowercase null.
    expect(tsvCellToRowValue("null")).toEqual({ t: "str", v: "null" });
  });

  test("integers split into int/uint by sign", () => {
    expect(tsvCellToRowValue("42")).toEqual({ t: "uint", v: 42 });
    expect(tsvCellToRowValue("-42")).toEqual({ t: "int", v: -42 });
    expect(tsvCellToRowValue(" 7 ")).toEqual({ t: "uint", v: 7 });
  });

  test("decimals become floats", () => {
    expect(tsvCellToRowValue("2.25")).toEqual({ t: "float", v: 2.25 });
    expect(tsvCellToRowValue("-0.5")).toEqual({ t: "float", v: -0.5 });
  });

  test("empty string stays an empty string", () => {
    expect(tsvCellToRowValue("")).toEqual({ t: "str", v: "" });
  });

  test("text keeps its original spacing and casing", () => {
    expect(tsvCellToRowValue("hello world")).toEqual({ t: "str", v: "hello world" });
    expect(tsvCellToRowValue("2026-08-24")).toEqual({ t: "str", v: "2026-08-24" });
    expect(tsvCellToRowValue("NaN")).toEqual({ t: "str", v: "NaN" });
  });
});
