import { describe, expect, test } from "bun:test";

import {
  buildForwardJumpFilters,
  buildReverseJumpFilters,
  fkGroupsByColumn,
  prettyFilterLabel,
} from "./fk-navigation";
import type { ForeignKeyMeta, RowValue } from "@/types/ipc";

const childNames = ["id", "customer_id", "region_id", "note"] as const;

const childRow: RowValue[] = [
  { t: "uint", v: 42 },
  { t: "int", v: 7 },
  { t: "str", v: "eu" },
  { t: "null" },
];

const simpleFk: ForeignKeyMeta = {
  name: "fk_orders_customers",
  columns: ["customer_id"],
  refTable: "customers",
  refColumns: ["id"],
};

const compositeFk: ForeignKeyMeta = {
  name: "fk_orders_regions",
  columns: ["region_id", "note"],
  refTable: "regions",
  refColumns: ["code", "label"],
};

describe("buildForwardJumpFilters", () => {
  test("maps typed child values onto referenced columns", () => {
    expect(buildForwardJumpFilters(simpleFk, childRow, childNames)).toEqual([
      { column: "id", op: "in", value: null, values: [{ t: "int", v: 7 }] },
    ]);
  });

  test("returns null when any FK component is NULL (short-circuit)", () => {
    const withNull: RowValue[] = [...childRow];
    withNull[1] = { t: "null" };
    expect(buildForwardJumpFilters(simpleFk, withNull, childNames)).toBeNull();
  });

  test("composite FK produces one AND term per column, in order", () => {
    const row: RowValue[] = [
      { t: "uint", v: 42 },
      { t: "int", v: 7 },
      { t: "str", v: "eu" },
      { t: "str", v: "Europe" },
    ];
    expect(buildForwardJumpFilters(compositeFk, row, childNames)).toEqual([
      { column: "code", op: "in", value: null, values: [{ t: "str", v: "eu" }] },
      { column: "label", op: "in", value: null, values: [{ t: "str", v: "Europe" }] },
    ]);
  });

  test("composite FK with any NULL component refuses to jump", () => {
    const row: RowValue[] = [childRow[0], childRow[1], { t: "null" }, { t: "str", v: "x" }];
    expect(buildForwardJumpFilters(compositeFk, row, ["id", "customer_id", "region_id", "note"])).toBeNull();
  });

  test("unknown column name returns null instead of guessing", () => {
    expect(buildForwardJumpFilters(simpleFk, childRow, ["id"])).toBeNull();
  });
});

describe("buildReverseJumpFilters", () => {
  const parentNames = ["id", "code", "label"] as const;
  const parentRow: RowValue[] = [
    { t: "int", v: 7 },
    { t: "str", v: "eu" },
    { t: "str", v: "Europe" },
  ];

  test("maps parent referenced cells onto child FK columns", () => {
    expect(buildReverseJumpFilters(compositeFk, parentRow, parentNames)).toEqual([
      { column: "region_id", op: "in", value: null, values: [{ t: "str", v: "eu" }] },
      { column: "note", op: "in", value: null, values: [{ t: "str", v: "Europe" }] },
    ]);
  });

  test("NULL parent key component short-circuits (children cannot reference it)", () => {
    expect(
      buildReverseJumpFilters(simpleFk, [{ t: "null" }, { t: "str", v: "eu" }, { t: "null" }], parentNames),
    ).toBeNull();
  });
});

describe("fkGroupsByColumn", () => {
  test("groups every constraint per participating column", () => {
    const groups = fkGroupsByColumn([simpleFk, compositeFk]);
    expect(Object.keys(groups).sort()).toEqual(["customer_id", "note", "region_id"]);
    expect(groups.customer_id).toEqual([simpleFk]);
    expect(groups.note).toEqual([compositeFk]);
  });

  test("knownColumns filter skips columns outside the grid", () => {
    const groups = fkGroupsByColumn([simpleFk, compositeFk], new Set(["customer_id"]));
    expect(groups.customer_id).toEqual([simpleFk]);
    expect(groups.region_id).toBeUndefined();
  });

  test("two constraints on one column both land in the group in order", () => {
    const second: ForeignKeyMeta = { ...simpleFk, name: "also_customer", refTable: "people" };
    const groups = fkGroupsByColumn([simpleFk, second]);
    expect(groups.customer_id).toEqual([simpleFk, second]);
  });
});

describe("prettyFilterLabel", () => {
  test("singleton IN renders as equality", () => {
    expect(
      prettyFilterLabel({ column: "id", op: "in", value: null, values: [{ t: "int", v: 7 }] }),
    ).toBe("id = 7");
  });

  test("multi-item IN keeps the count form", () => {
    expect(
      prettyFilterLabel({
        column: "id",
        op: "in",
        value: null,
        values: [{ t: "int", v: 1 }, { t: "int", v: 2 }],
      }),
    ).toBe("id IN (2)");
  });

  test("scalar ops render operator and quoted value", () => {
    expect(prettyFilterLabel({ column: "name", op: "eq", value: "bob", values: [] })).toBe(
      "name = 'bob'",
    );
    expect(prettyFilterLabel({ column: "score", op: "gt_e", value: "5", values: [] })).toBe(
      "score ≥ '5'",
    );
  });

  test("NULL predicates render without a value", () => {
    expect(prettyFilterLabel({ column: "x", op: "is_null", value: null, values: [] })).toBe(
      "x IS NULL",
    );
  });
});
