import { describe, expect, test } from "bun:test";

import {
  escapeXml,
  resolveDiagramTokens,
  serializeModelToSvgString,
  svgContentSize,
} from "./diagram-export";
import type { DiagramNode } from "./diagram-model";
import { computeEdgeGeometry, type CardBox } from "./diagram-edge-paths";

const TOKENS = {
  background: "#ffffff",
  foreground: "#111111",
  card: "#fafafa",
  cardForeground: "#222222",
  border: "#dddddd",
  mutedForeground: "#777777",
  primary: "#0055ff",
};

function node(name: string): DiagramNode {
  return {
    id: name,
    table: { name, kind: "table", rows: null, sizeBytes: null, comment: null, engine: null },
    columns: [
      { name: "id", dataType: "int", nullable: false, key: "PRI" },
      { name: "odd<&>name", dataType: 'varchar("80")', nullable: true },
    ],
    totalColumns: 2,
    pkNames: ["id"],
    fkColumns: new Set(["customer_id"]),
  };
}

function box(x: number, y: number, height = 66): CardBox {
  return { x, y, height, rowIndex: null };
}

describe("escapeXml", () => {
  test("escapes the five XML specials", () => {
    expect(escapeXml(`a<b>&"c"'d`)).toBe("a&lt;b&gt;&amp;&quot;c&quot;&apos;d");
  });

  test("leaves plain names untouched", () => {
    expect(escapeXml("plain_table_1")).toBe("plain_table_1");
  });
});

describe("svgContentSize", () => {
  test("bbox covers every card plus margin", () => {
    const boxes = { a: box(0, 0), b: box(400, 300) };
    const size = svgContentSize([node("a"), node("b")], boxes);
    expect(size.width).toBe(400 + 200 + 24); // CARD_WIDTH + margin
    expect(size.height).toBe(300 + 66 + 24);
  });

  test("empty model yields a minimum canvas", () => {
    const size = svgContentSize([], {});
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });
});

describe("serializeModelToSvgString", () => {
  test("produces a standalone document with inlined tokens", () => {
    const nodes = [node("customers")];
    const svg = serializeModelToSvgString({
      nodes,
      boxes: { customers: box(0, 0) },
      edges: [],
      tokens: TOKENS,
      keysOnly: false,
      collapsed: new Set(),
    });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    // Token VALUES (not var() references).
    expect(svg).toContain(TOKENS.card);
    expect(svg).toContain(TOKENS.border);
    expect(svg).not.toContain("var(--");
  });

  test("XML-escapes user identifiers", () => {
    const svg = serializeModelToSvgString({
      nodes: [node("customers")],
      boxes: { customers: box(0, 0) },
      edges: [],
      tokens: TOKENS,
      keysOnly: false,
      collapsed: new Set(),
    });
    expect(svg).toContain("odd&lt;&amp;&gt;name");
    expect(svg).toContain("&quot;80&quot;");
    expect(svg).not.toContain('varchar("80")');
  });

  test("renders edges with feet and collapsed cards as headers only", () => {
    const nodes = [node("customers"), node("orders")];
    const boxes = { customers: box(0, 0), orders: box(400, 0) };
    const edge = computeEdgeGeometry(
      {
        id: "e", name: "fk", source: "customers", target: "orders",
        sourceColumn: "id", targetColumn: "customer_id",
        nullableChild: true, composite: false, onUpdate: null, onDelete: null,
      },
      boxes,
    )!;
    const svg = serializeModelToSvgString({
      nodes,
      boxes,
      edges: [edge],
      tokens: TOKENS,
      keysOnly: false,
      collapsed: new Set(["orders"]),
    });
    expect(svg).toContain(`<path d="${edge.d}"`);
    expect(svg).not.toContain("+0 more");
    // Collapsed card renders header only — no row text from it.
    const ordersSection = svg.slice(svg.indexOf(">orders<"));
    expect(ordersSection).not.toContain("</text></g><text");
  });
});

describe("resolveDiagramTokens", () => {
  test("falls back safely outside a styled document", () => {
    // In bun there is no DOM: the resolver must return defaults, not throw.
    expect(resolveDiagramTokens().background).toBe("#ffffff");
    expect(resolveDiagramTokens().foreground).toBe("#171717");
  });
});
