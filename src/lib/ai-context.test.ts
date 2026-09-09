import { describe, expect, it } from "bun:test";

import { buildSchemaContext, looksLikeSql, stripCodeFence } from "@/lib/ai-context";
import type { ForeignKeyMeta, TableSchemaData } from "@/types/ipc";

const col = (
  name: string,
  dataType: string,
  extra: Partial<TableSchemaData["columns"][number]> = {},
): TableSchemaData["columns"][number] => ({
  name,
  dataType,
  nullable: false,
  ...extra,
});

const table = (name: string, columns: TableSchemaData["columns"]): TableSchemaData => ({
  table: name,
  columns,
});

const fk = (owner: string, column: string, refTable: string, refColumn: string): ForeignKeyMeta => ({
  name: `fk_${owner}_${column}`,
  columns: [column],
  refDb: null,
  refTable,
  refColumns: [refColumn],
  table: owner,
});

describe("buildSchemaContext", () => {
  it("serializes columns with type, nullability, PK and comments", () => {
    const text = buildSchemaContext(
      "shop",
      "mysql",
      [
        table("users", [
          col("id", "int unsigned", { key: "PRI", extra: "auto_increment" }),
          col("email", "varchar(255)", { comment: "login email" }),
          col("nickname", "varchar(100)", { nullable: true }),
        ]),
      ],
      [],
    );
    expect(text).toContain("-- Database: shop (MySQL/MariaDB)");
    expect(text).toContain("TABLE users (");
    expect(text).toContain("id int unsigned NOT NULL PRIMARY KEY AUTO_INCREMENT,");
    expect(text).toContain("email varchar(255) NOT NULL, -- login email");
    expect(text).toContain("nickname varchar(100) NULL,");
    expect(text.trimEnd().endsWith(");")).toBe(true);
  });

  it("maps foreign keys to REFERENCES clauses", () => {
    const text = buildSchemaContext(
      "shop",
      "mysql",
      [
        table("orders", [
          col("id", "int", { key: "PRI" }),
          col("user_id", "int"),
        ]),
        table("users", [col("id", "int", { key: "PRI" })]),
      ],
      [fk("orders", "user_id", "users", "id")],
    );
    expect(text).toContain("user_id int NOT NULL REFERENCES users(id),");
  });

  it("announces the dialect for each engine", () => {
    for (const [dialect, label] of [
      ["postgresql", "PostgreSQL"],
      ["sqlite", "SQLite"],
    ] as const) {
      const text = buildSchemaContext("db", dialect, [table("t", [col("a", "int")])], []);
      expect(text).toContain(`(${label})`);
    }
  });

  it("truncates oversized schemas with an explicit note", () => {
    const bigTable = table("huge", Array.from({ length: 30 }, (_, i) => col(`c${i}`, "varchar(2000)")));
    // ~2.4 KB each; 40 of them blows past the 60 KB cap.
    const filler = Array.from({ length: 40 }, (_, i) =>
      table(`filler_${i}`, Array.from({ length: 60 }, (_, c) => col(`c${c}`, "varchar(2000)"))),
    );
    const text = buildSchemaContext("db", "mysql", [bigTable, ...filler], []);
    expect(text).toContain("-- …schema truncated");
    // The first table made it in whole; later fillers did not.
    expect(text).toContain("TABLE huge (");
    expect(text).not.toContain("TABLE filler_39 (");
  });
});

describe("stripCodeFence", () => {
  it("peels an outer markdown fence, with or without a language tag", () => {
    expect(stripCodeFence("```sql\nSELECT 1;\n```")).toBe("SELECT 1;");
    expect(stripCodeFence("```\nSELECT 1;\n```")).toBe("SELECT 1;");
  });

  it("leaves bare SQL and prose untouched except trimming", () => {
    expect(stripCodeFence("SELECT 1;")).toBe("SELECT 1;");
    expect(stripCodeFence("  Here is the query: SELECT 1;  ")).toBe(
      "Here is the query: SELECT 1;",
    );
  });
});

describe("looksLikeSql", () => {
  it("accepts fenced and bare statements", () => {
    expect(looksLikeSql("```sql\nSELECT * FROM users;\n```")).toBe(true);
    expect(looksLikeSql("WITH x AS (SELECT 1) SELECT * FROM x;")).toBe(true);
    expect(looksLikeSql("INSERT INTO t VALUES (1);")).toBe(true);
  });

  it("rejects prose and empty responses", () => {
    expect(looksLikeSql("Sorry, I cannot help with that.")).toBe(false);
    expect(looksLikeSql("   ")).toBe(false);
  });
});
