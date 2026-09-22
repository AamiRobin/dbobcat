import { describe, expect, test } from "bun:test";

import { schemaToMarkdown, tablesToSql } from "./diagram-ddl";
import { buildDiagramModel } from "./diagram-model";
import type { ColumnMeta, ForeignKeyMeta, TableMeta } from "@/types/ipc";

function table(name: string): TableMeta {
  return { name, kind: "table", rows: null, sizeBytes: null, comment: null, engine: null };
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

function fk(name: string, child: string, col: string, parent: string): ForeignKeyMeta {
  return {
    name,
    columns: [col],
    refDb: null,
    refTable: parent,
    refColumns: ["id"],
    onUpdate: null,
    onDelete: "CASCADE",
    table: child,
  };
}

const columnsByTable = {
  customers: [
    column("id", { key: "PRI" }),
    column("email", { dataType: "varchar(255)", nullable: true }),
  ],
  orders: [column("id", { key: "PRI" }), column("customer_id", { nullable: true })],
};

function model() {
  return buildDiagramModel(
    [table("orders"), table("customers")],
    columnsByTable,
    [fk("fk_orders_customers", "orders", "customer_id", "customers")],
  );
}

describe("tablesToSql", () => {
  test("emits CREATE TABLE with NOT NULL and PK", () => {
    const sql = tablesToSql(model().nodes, model().edges);
    expect(sql).toContain('CREATE TABLE "customers" (');
    expect(sql).toContain('"id" int NOT NULL,');
    expect(sql).toContain('"email" varchar(255),');
    expect(sql).toContain('PRIMARY KEY ("id")');
    // CREATEs first, FK ALTERs after — the output ends with the FK action.
    expect(sql.trim().endsWith("ON DELETE CASCADE;")).toBe(true);
  });

  test("includes DEFAULT when a default value exists", () => {
    const m = buildDiagramModel(
      [table("t")],
      { t: [column("flag", { dataType: "tinyint", defaultValue: "0" })] },
      [],
    );
    expect(tablesToSql(m.nodes, m.edges)).toContain("DEFAULT 0");
  });

  test("emits FK constraints with actions", () => {
    const sql = tablesToSql(model().nodes, model().edges);
    expect(sql).toContain('ALTER TABLE "orders"');
    expect(sql).toContain('ADD CONSTRAINT "fk_orders_customers"');
    expect(sql).toContain('FOREIGN KEY ("customer_id") REFERENCES "customers" ("id")');
    expect(sql).toContain("ON DELETE CASCADE");
  });

  test("doubles embedded quotes in identifiers", () => {
    const m = buildDiagramModel([table('we"ird')], { 'we"ird': [column("id", { key: "PRI" })] }, []);
    expect(tablesToSql(m.nodes, m.edges)).toContain('"we""ird"');
  });

  test("skips tables with unloaded columns", () => {
    const m = buildDiagramModel([table("empty")], {}, []);
    expect(tablesToSql(m.nodes, m.edges)).toBe("");
  });
});

describe("schemaToMarkdown", () => {
  test("renders a table per node with key markers", () => {
    const md = schemaToMarkdown(model().nodes);
    expect(md).toContain("### customers");
    expect(md).toContain("### orders");
    expect(md).toContain("| id | int | no | PK |");
    expect(md).toContain("| email | varchar(255) | yes |  |");
    expect(md).toContain("| customer_id | int | yes | FK |");
    expect(md).toContain("| Column | Type | Nullable | Key |");
  });

  test("skips tables with unloaded columns", () => {
    const m = buildDiagramModel([table("empty")], {}, []);
    expect(schemaToMarkdown(m.nodes)).toBe("");
  });
});
