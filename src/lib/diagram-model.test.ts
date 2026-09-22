import { describe, expect, test } from "bun:test";

import {
  CARD_FOOTER_HEIGHT,
  CARD_HEADER_HEIGHT,
  COLLAPSE_THRESHOLD,
  MAX_CARD_ROWS,
  ROW_HEIGHT,
  buildDiagramModel,
  cardHeight,
  visibleRows,
} from "./diagram-model";
import type { ColumnMeta, ForeignKeyMeta, TableMeta } from "@/types/ipc";

function table(name: string): TableMeta {
  return { name, kind: "table", rows: null, sizeBytes: null, comment: null, engine: null };
}

function view(name: string): TableMeta {
  return { ...table(name), kind: "view" };
}

function column(name: string, opts: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    dataType: "int",
    nullable: false,
    key: null,
    defaultValue: null,
    extra: null,
    comment: null,
    ...opts,
  };
}

const columnsByTable = {
  customers: [column("id", { key: "PRI" }), column("name", { dataType: "varchar(80)", nullable: true })],
  orders: [
    column("id", { key: "PRI" }),
    column("customer_id", { nullable: true }),
    column("total", { dataType: "decimal(10,2)" }),
  ],
  orphans: [column("id", { key: "PRI" }), column("missing_ref")],
};

function fk(name: string, child: string, col: string, parent: string, extra: Partial<ForeignKeyMeta> = {}): ForeignKeyMeta {
  return {
    name,
    columns: [col],
    refDb: null,
    refTable: parent,
    refColumns: ["id"],
    onUpdate: "NO ACTION",
    onDelete: "CASCADE",
    table: child,
    ...extra,
  };
}

describe("buildDiagramModel", () => {
  test("filters views and sorts nodes by name", () => {
    const model = buildDiagramModel(
      [view("a_view"), table("orders"), table("customers")],
      columnsByTable,
      [],
    );
    expect(model.nodes.map((n) => n.id)).toEqual(["customers", "orders"]);
  });

  test("builds parent→child edges from FKs", () => {
    const model = buildDiagramModel(
      [table("customers"), table("orders")],
      columnsByTable,
      [fk("fk_orders_customers", "orders", "customer_id", "customers")],
    );
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0].source).toBe("customers");
    expect(model.edges[0].target).toBe("orders");
    expect(model.edges[0].nullableChild).toBe(true); // customer_id IS NULLable
  });

  test("marks PK columns and collects FK + referenced anchors", () => {
    const model = buildDiagramModel(
      [table("customers"), table("orders")],
      columnsByTable,
      [fk("fk_orders_customers", "orders", "customer_id", "customers")],
    );
    const orders = model.nodes.find((n) => n.id === "orders");
    const customers = model.nodes.find((n) => n.id === "customers");
    expect(orders?.pkNames).toEqual(["id"]);
    expect([...(orders?.fkColumns ?? [])]).toEqual(["customer_id"]);
    // Parent side collects the referenced column for its source handle.
    expect([...(customers?.referencedColumns ?? [])]).toEqual(["id"]);
  });

  test("skips edges with a missing endpoint (orphan FK)", () => {
    const model = buildDiagramModel(
      [table("orphans")],
      columnsByTable,
      [fk("fk_orphans_ghost", "orphans", "missing_ref", "ghost_table")],
    );
    expect(model.edges).toHaveLength(0);
    expect(model.crossDbCount).toBe(0);
  });

  test("counts but excludes cross-database references", () => {
    const model = buildDiagramModel(
      [table("customers"), table("orders")],
      columnsByTable,
      [
        fk("fk_same", "orders", "customer_id", "customers"),
        fk("fk_cross", "orders", "customer_id", "remote", { refDb: "other_db" }),
      ],
      "shop",
    );
    expect(model.edges.map((e) => e.name)).toEqual(["fk_same"]);
    expect(model.crossDbCount).toBe(1);
  });

  test("keeps explicit same-db references (MySQL cross-db metadata)", () => {
    const model = buildDiagramModel(
      [table("customers"), table("orders")],
      columnsByTable,
      [fk("fk_explicit", "orders", "customer_id", "customers", { refDb: "shop" })],
      "shop",
    );
    expect(model.edges).toHaveLength(1);
    expect(model.crossDbCount).toBe(0);
  });

  test("composite constraints become one simple-foot edge", () => {
    const composite = fk("fk_comp", "orders", "region_id", "customers");
    composite.columns = ["customer_id", "region_id"];
    composite.refColumns = ["id", "id"];
    const model = buildDiagramModel(
      [table("customers"), table("orders")],
      columnsByTable,
      [composite],
    );
    expect(model.edges[0].composite).toBe(true);
  });

  test("fallback FKs without owner (`table`) are skipped", () => {
    const ownerless = fk("fk_ownerless", "", "x", "customers");
    ownerless.table = undefined;
    const model = buildDiagramModel([table("customers")], columnsByTable, [ownerless]);
    expect(model.edges).toHaveLength(0);
  });
});

describe("visibleRows / cardHeight", () => {
  const manyColumns = Array.from({ length: 40 }, (_, i) =>
    column(i % 10 === 0 ? `pk_${i}` : `c_${i}`, i % 10 === 0 ? { key: "PRI" } : {}),
  );
  const wideNode = buildDiagramModel([table("wide")], { wide: manyColumns }, []).nodes[0];

  test("caps rows at MAX_CARD_ROWS and reports hidden count", () => {
    const rows = visibleRows(wideNode, false);
    expect(rows.rows).toHaveLength(MAX_CARD_ROWS);
    expect(rows.hiddenCount).toBe(manyColumns.length - MAX_CARD_ROWS);
  });

  test("keys-only mode keeps just keys and never returns empty", () => {
    const rows = visibleRows(wideNode, true);
    expect(rows.rows.every((c) => c.key === "PRI")).toBe(true);

    const noKeys = buildDiagramModel([table("plain")], { plain: [column("a"), column("b")] }, []).nodes[0];
    expect(visibleRows(noKeys, true).rows).toHaveLength(2); // fallback to full list
  });

  test("cardHeight accounts for header, rows and footer", () => {
    const full = cardHeight(wideNode, false);
    expect(full).toBe(CARD_HEADER_HEIGHT + MAX_CARD_ROWS * ROW_HEIGHT + CARD_FOOTER_HEIGHT);
  });
});

describe("COLLAPSE_THRESHOLD", () => {
  test("large schemas default to keys-only", () => {
    expect(COLLAPSE_THRESHOLD).toBeGreaterThan(0);
    expect(COLLAPSE_THRESHOLD >= 20).toBe(true);
  });
});
