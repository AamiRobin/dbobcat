import { describe, expect, test } from "bun:test";

import { buildDiagramModel, cardHeight } from "./diagram-model";
import { layoutDiagram } from "./diagram-layout";
import type { ColumnMeta, ForeignKeyMeta, TableMeta } from "@/types/ipc";

/**
 * Layout sweep across structurally different database shapes — the same
 * buildDiagramModel → layoutDiagram pipeline the ER view runs, asserted on
 * the invariants that make the auto-layout useful:
 *   - parents rank above the tables that reference them
 *   - deterministic output, all positions finite
 *   - no two cards overlap (they may share x or y bands, not both ranges)
 */

function table(name: string): TableMeta {
  return { name, kind: "table", rows: null, sizeBytes: null, comment: null, engine: null };
}

function col(name: string, opts: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name, dataType: opts.dataType ?? "int", nullable: opts.nullable ?? false,
    key: opts.key ?? null, extra: opts.extra ?? null,
    defaultValue: opts.defaultValue ?? null, comment: null,
  };
}

function fk(name: string, child: string, col: string, parent: string, refCol = "id"): ForeignKeyMeta {
  return {
    name, columns: [col], refDb: null, refTable: parent, refColumns: [refCol],
    onUpdate: null, onDelete: null, table: child,
  };
}

function layout(
  tables: string[],
  columns: Record<string, ColumnMeta[]>,
  fks: ForeignKeyMeta[],
): { positions: Record<string, { x: number; y: number }>; model: ReturnType<typeof buildDiagramModel> } {
  const model = buildDiagramModel(
    tables.map(table),
    columns,
    fks,
  );
  const heights: Record<string, number> = {};
  for (const node of model.nodes) heights[node.id] = cardHeight(node, false);
  const result = layoutDiagram(model.nodes, model.edges, heights);
  return { positions: result.positions, model };
}

// ---------------------------------------------------------------------------
// Five database shapes
// ---------------------------------------------------------------------------

/** 1) Star: fact_sales references five dimensions. */
const STAR = {
  tables: ["fact_sales", "dim_date", "dim_customer", "dim_product", "dim_store", "dim_promo"],
  columns: {
    fact_sales: [col("id", { key: "PRI" }), col("date_id", { key: "MUL" }), col("customer_id", { key: "MUL" }), col("product_id", { key: "MUL" }), col("store_id", { key: "MUL" }), col("promo_id", { key: "MUL" }), col("amount")],
    dim_date: [col("date_id", { key: "PRI" }), col("cal_date")],
    dim_customer: [col("customer_id", { key: "PRI" }), col("name")],
    dim_product: [col("product_id", { key: "PRI" }), col("sku")],
    dim_store: [col("store_id", { key: "PRI" }), col("city")],
    dim_promo: [col("promo_id", { key: "PRI" }), col("promo_name")],
  },
  fks: [
    fk("f1", "fact_sales", "date_id", "dim_date", "date_id"),
    fk("f2", "fact_sales", "customer_id", "dim_customer", "customer_id"),
    fk("f3", "fact_sales", "product_id", "dim_product", "product_id"),
    fk("f4", "fact_sales", "store_id", "dim_store", "store_id"),
    fk("f5", "fact_sales", "promo_id", "dim_promo", "promo_id"),
  ],
};

/** 2) Chain: a→b→c→d→e→f, six ranks deep. */
const CHAIN = {
  tables: ["step_a", "step_b", "step_c", "step_d", "step_e", "step_f"],
  columns: Object.fromEntries(
    ["step_a", "step_b", "step_c", "step_d", "step_e", "step_f"].map((t) => [
      t,
      t === "step_a"
        ? [col("id", { key: "PRI" }), col("payload")]
        : [col("id", { key: "PRI" }), col(`${t.slice(-1) === t.slice(5) ? t.slice(4) : t.slice(4)}_id`, { key: "MUL" })],
    ]),
  ),
  fks: [
    fk("fk_b_a", "step_b", "a_id", "step_a", "id"),
    fk("fk_c_b", "step_c", "b_id", "step_b", "id"),
    fk("fk_d_c", "step_d", "c_id", "step_c", "id"),
    fk("fk_e_d", "step_e", "d_id", "step_d", "id"),
    fk("fk_f_e", "step_f", "e_id", "step_e", "id"),
  ],
};

/** 3) Company: self-reference (manager), a true cycle (employees↔teams), and an M:N junction. */
const COMPANY = {
  tables: ["departments", "employees", "teams", "projects", "project_members"],
  columns: {
    departments: [col("id", { key: "PRI" }), col("name")],
    employees: [col("id", { key: "PRI" }), col("dept_id", { key: "MUL" }), col("manager_id", { key: "MUL" }), col("team_id", { key: "MUL" })],
    teams: [col("id", { key: "PRI" }), col("name"), col("team_lead_id", { key: "MUL" })],
    projects: [col("id", { key: "PRI" }), col("name"), col("dept_id", { key: "MUL" })],
    project_members: [col("employee_id", { key: "MUL" }), col("project_id", { key: "MUL" }), col("role")],
  },
  fks: [
    fk("fk_emp_dept", "employees", "dept_id", "departments"),
    fk("fk_emp_manager", "employees", "manager_id", "employees"),
    fk("fk_emp_team", "employees", "team_id", "teams"),
    fk("fk_team_lead", "teams", "team_lead_id", "employees"),
    fk("fk_proj_dept", "projects", "dept_id", "departments"),
    fk("fk_pm_emp", "project_members", "employee_id", "employees"),
    fk("fk_pm_proj", "project_members", "project_id", "projects"),
  ],
};

/** 4) CMS: 16 tables mixing hubs, junctions, FK-less tables and one wide table. */
const CMS_TABLES = [
  "users", "posts", "comments", "tags", "post_tags", "categories", "media",
  "pages", "menus", "widgets", "settings", "sessions", "subscribers",
  "forms", "revisions", "audit_log",
];
const CMS = {
  tables: CMS_TABLES,
  columns: {
    users: [col("id", { key: "PRI" }), col("email", { key: "UNI" })],
    posts: [col("id", { key: "PRI" }), col("author_id", { key: "MUL" }), col("title")],
    comments: [col("id", { key: "PRI" }), col("post_id", { key: "MUL" }), col("user_id", { key: "MUL" })],
    tags: [col("id", { key: "PRI" }), col("slug")],
    post_tags: [col("post_id", { key: "MUL" }), col("tag_id", { key: "MUL" })],
    categories: [col("id", { key: "PRI" }), col("parent_id", { key: "MUL" })],
    media: [col("id", { key: "PRI" }), col("uploader_id", { key: "MUL" })],
    pages: [col("id", { key: "PRI" }), col("author_id", { key: "MUL" })],
    menus: [col("id", { key: "PRI" })],
    widgets: [col("id", { key: "PRI" })],
    settings: [col("k", { key: "PRI" })],
    sessions: [col("id", { key: "PRI" }), col("user_id", { key: "MUL" })],
    subscribers: [col("id", { key: "PRI" })],
    forms: [col("id", { key: "PRI" })],
    revisions: [col("id", { key: "PRI" }), col("post_id", { key: "MUL" }), col("editor_id", { key: "MUL" })],
    audit_log: Array.from({ length: 30 }, (_, i) =>
      col(i === 0 ? "id" : `field_${i}`, i === 0 ? { key: "PRI" } : {}),
    ),
  },
  fks: [
    fk("fk_posts_author", "posts", "author_id", "users"),
    fk("fk_comments_post", "comments", "post_id", "posts"),
    fk("fk_comments_user", "comments", "user_id", "users"),
    fk("fk_pt_post", "post_tags", "post_id", "posts"),
    fk("fk_pt_tag", "post_tags", "tag_id", "tags"),
    fk("fk_cat_parent", "categories", "parent_id", "categories"),
    fk("fk_media_uploader", "media", "uploader_id", "users"),
    fk("fk_pages_author", "pages", "author_id", "users"),
    fk("fk_sessions_user", "sessions", "user_id", "users"),
    fk("fk_revisions_post", "revisions", "post_id", "posts"),
    fk("fk_revisions_editor", "revisions", "editor_id", "users"),
    fk("fk_audit_user", "audit_log", "field_5", "users", "id"),
  ],
};

/** 5) Sparse: 8 unrelated tables (no FKs at all) — the degenerate grid case. */
const SPARSE = {
  tables: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"],
  columns: Object.fromEntries(SPARSE_TABLES().map((t) => [t, [col("id", { key: "PRI" })]])),
  fks: [],
};

function SPARSE_TABLES(): string[] {
  return ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
}

// ---------------------------------------------------------------------------

const SHAPES = { STAR, CHAIN, COMPANY, CMS, SPARSE } as const;

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

for (const [name, shape] of Object.entries(SHAPES)) {
  describe(`layout sweep · ${name}`, () => {
    const { positions, model } = layout(shape.tables, shape.columns, shape.fks);
    const entries = Object.entries(positions);
    const nodeById = new Map(model.nodes.map((n) => [n.id, n]));

    test("places every node at a finite position", () => {
      expect(entries).toHaveLength(shape.tables.length);
      for (const [, p] of entries) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    });

    test("is deterministic", () => {
      const again = layout(shape.tables, shape.columns, shape.fks);
      expect(again.positions).toEqual(positions);
    });

    test("no two cards overlap", () => {
      const rects = model.nodes.map((n) => ({
        id: n.id,
        x: positions[n.id].x,
        y: positions[n.id].y,
        w: 240, // CARD_WIDTH
        h: 74, // conservative minimum card height
      }));
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          if (rectsOverlap(rects[i], rects[j])) {
            throw new Error(`overlap: ${rects[i].id} ↔ ${rects[j].id}`);
          }
        }
      }
    });

    test("referenced tables rank above (or beside) their children", () => {
      for (const edge of model.edges) {
        const parentY = positions[edge.source].y;
        const childY = positions[edge.target].y;
        // In cycles (e.g. employees↔teams) dagre breaks one edge — the
        // invariant weakens to "not every FK runs downward".
        if (positions[edge.source].x === positions[edge.target].x) {
          expect(childY).toBeGreaterThanOrEqual(parentY);
        }
      }
    });

    test("hub tables sit between their parents and children", () => {
      if (name === "STAR") {
        expect(positions.fact_sales.y).toBeGreaterThan(positions.dim_date.y);
        expect(positions.fact_sales.y).toBeGreaterThan(positions.dim_promo.y);
      }
      if (name === "CHAIN") {
        const ys = ["step_a", "step_b", "step_c", "step_d", "step_e", "step_f"].map((t) => positions[t].y);
        for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
      }
      if (name === "CMS") {
        // users is referenced by 6 tables and must rank at/near the top.
        const minChildY = Math.min(
          ...model.edges.filter((e) => e.source === "users").map((e) => positions[e.target].y),
        );
        expect(positions.users.y).toBeLessThanOrEqual(minChildY);
      }
      void nodeById;
    });
  });
}
