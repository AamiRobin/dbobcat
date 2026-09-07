import { describe, expect } from "bun:test";
import { test } from "bun:test";

import {
  findCellMatches,
  inputValueToTemporal,
  joinSetValues,
  parseEnumSetValues,
  reorderColumnNames,
  replaceInCell,
  temporalKind,
  temporalToInputValue,
} from "./grid-columns";
import type { ColumnMeta, RowValue } from "@/types/ipc";

const meta = (dataType: string, name = "c"): ColumnMeta => ({
  name,
  dataType,
  nullable: true,
});

describe("parseEnumSetValues", () => {
  test("parses simple enum", () => {
    expect(parseEnumSetValues("enum('pending','paid','shipped')")).toEqual({
      kind: "enum",
      values: ["pending", "paid", "shipped"],
    });
  });

  test("parses unquoted-escape and commas inside strings", () => {
    expect(parseEnumSetValues("enum('a,b','it''s')")).toEqual({
      kind: "enum",
      values: ["a,b", "it's"],
    });
  });

  test("parses set case-insensitively", () => {
    expect(parseEnumSetValues("SET('x','y')")).toEqual({
      kind: "set",
      values: ["x", "y"],
    });
  });

  test("returns null for non-enum/set types", () => {
    expect(parseEnumSetValues("varchar(255)")).toBeNull();
    expect(parseEnumSetValues("int unsigned")).toBeNull();
  });
});

describe("temporalKind + conversions", () => {
  test("classifies temporal kinds", () => {
    expect(temporalKind("datetime")).toBe("datetime");
    expect(temporalKind("timestamp")).toBe("datetime");
    expect(temporalKind("date")).toBe("date");
    expect(temporalKind("time")).toBe("time");
    expect(temporalKind("varchar(10)")).toBeNull();
  });

  test("datetime round-trips through the datetime-local input", () => {
    const stored = "2026-04-11 09:05:00";
    const input = temporalToInputValue("datetime", stored);
    expect(input).toBe("2026-04-11T09:05:00");
    expect(inputValueToTemporal("datetime", input)).toBe(stored);
  });

  test("datetime without seconds normalizes on the way back", () => {
    expect(inputValueToTemporal("datetime", "2026-04-11T09:05")).toBe("2026-04-11 09:05:00");
  });

  test("time normalizes minute-only inputs", () => {
    expect(temporalToInputValue("time", "09:05")).toBe("09:05:00");
    expect(inputValueToTemporal("time", "09:05")).toBe("09:05:00");
    expect(inputValueToTemporal("time", "23:59:59")).toBe("23:59:59");
  });

  test("date round-trips", () => {
    expect(temporalToInputValue("date", "2026-04-11")).toBe("2026-04-11");
    expect(inputValueToTemporal("date", "2026-04-11")).toBe("2026-04-11");
  });
});

describe("joinSetValues", () => {
  test("joins selections comma-separated", () => {
    expect(joinSetValues(["a", "b"])).toBe("a,b");
    expect(joinSetValues([])).toBe("");
  });
});

describe("findCellMatches", () => {
  const rows: RowValue[][] = [
    [{ t: "int", v: 1 }, { t: "str", v: "Alice" }, { t: "null" }],
    [{ t: "int", v: 2 }, { t: "str", v: "Bob" }, { t: "str", v: "alice@x" }],
  ];

  test("finds case-insensitive matches across visible columns", () => {
    expect(findCellMatches(rows, [0, 1, 2], "alice")).toEqual([
      { rowIndex: 0, colIndex: 1 },
      { rowIndex: 1, colIndex: 2 },
    ]);
  });

  test("respects caseSensitive", () => {
    expect(findCellMatches(rows, [1], "alice", true)).toEqual([]);
    expect(findCellMatches(rows, [1], "Alice", true)).toEqual([{ rowIndex: 0, colIndex: 1 }]);
  });

  test("skips hidden columns and empty queries", () => {
    expect(findCellMatches(rows, [0], "alice")).toEqual([]);
    expect(findCellMatches(rows, [0, 1], "")).toEqual([]);
  });

  test("renders NULL as searchable text like the grid does", () => {
    // The grid displays NULL literally, so searching it must match.
    expect(findCellMatches(rows, [2], "null")).toEqual([{ rowIndex: 0, colIndex: 2 }]);
  });
});

describe("replaceInCell", () => {
  test("replaces text and keeps string type", () => {
    const row: RowValue[] = [{ t: "int", v: 1 }, { t: "str", v: "Alice Smith" }];
    const next = replaceInCell(row, 1, meta("varchar(100)"), "Alice", "Alicia");
    expect(next).toEqual({ t: "str", v: "Alicia Smith" });
  });

  test("replaces all occurrences case-insensitively by default", () => {
    const row: RowValue[] = [{ t: "str", v: "Foo foo FOO" }];
    const next = replaceInCell(row, 0, meta("text"), "foo", "bar");
    expect(next).toEqual({ t: "str", v: "bar bar bar" });
  });

  test("parses numeric results through the column type", () => {
    const row: RowValue[] = [{ t: "int", v: 12 }, { t: "str", v: "$3.50" }];
    const next = replaceInCell(row, 1, meta("decimal(10,2)"), "$", "");
    expect(next).toEqual({ t: "float", v: 3.5 });
  });

  test("returns null when the cell does not match", () => {
    const row: RowValue[] = [{ t: "str", v: "zzz" }];
    expect(replaceInCell(row, 0, meta("varchar(10)"), "alice", "x")).toBeNull();
  });

  test("never rewrites NULL cells to empty strings", () => {
    const row: RowValue[] = [{ t: "null" }];
    expect(replaceInCell(row, 0, meta("varchar(10)"), "null", "")).toBeNull();
  });
});

describe("reorderColumnNames", () => {
  test("applies the persisted order head-first", () => {
    expect(reorderColumnNames(["a", "b", "c"], ["c", "a"])).toEqual(["c", "a", "b"]);
  });

  test("keeps unnamed columns in original relative order", () => {
    expect(reorderColumnNames(["a", "b", "c", "d"], ["d", "b"])).toEqual(["d", "b", "a", "c"]);
  });

  test("drops stale order entries (renamed/dropped columns)", () => {
    expect(reorderColumnNames(["a", "b"], ["z", "y", "a"])).toEqual(["a", "b"]);
  });

  test("empty order keeps the original order", () => {
    expect(reorderColumnNames(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });

  test("duplicate order entries collapse", () => {
    expect(reorderColumnNames(["a", "b", "c"], ["b", "b", "c"])).toEqual(["b", "c", "a"]);
  });
});
