import { describe, expect, test } from "bun:test";

import {
  applySavedPositions,
  gridFallbackLayout,
  layoutDiagram,
} from "./diagram-layout";
import { CARD_WIDTH, buildDiagramModel } from "./diagram-model";
import type { DiagramNode } from "./diagram-model";

function node(name: string): DiagramNode {
  return {
    id: name,
    table: { name, kind: "table", rows: null, sizeBytes: null, comment: null, engine: null },
    columns: [],
    totalColumns: 0,
    pkNames: [],
    fkColumns: new Set<string>(),
  };
}

const heights = { a: 100, b: 100, c: 100 };

function triangle(): [DiagramNode[], ReturnType<typeof buildDiagramModel>["edges"]] {
  const nodes = [node("a"), node("b"), node("c")];
  const model = buildDiagramModel(
    [{ name: "a", kind: "table" }, { name: "b", kind: "table" }, { name: "c", kind: "table" }] as never,
    {},
    [],
  );
  return [nodes, model.edges];
}

describe("layoutDiagram", () => {
  test("empty input yields an empty layout", () => {
    const result = layoutDiagram([], [], {});
    expect(result.positions).toEqual({});
    expect(result.width).toBe(0);
  });

  test("parents rank above children (TB) and positions are deterministic", () => {
    const nodes = [node("child"), node("parent")];
    // Two consecutive runs must produce identical coordinates.
    const run = () =>
      layoutDiagram(
        nodes.map((n) => ({ ...n })),
        [
          {
            id: "e", name: "fk", source: "parent", target: "child",
            sourceColumn: "id", targetColumn: "id",
            nullableChild: false, composite: false,
            onUpdate: null, onDelete: null,
          },
        ],
        heights,
      );
    const first = run();
    const second = run();
    expect(first.positions).toEqual(second.positions);
    // Parent center-y strictly above child center-y.
    expect(first.positions.parent.y).toBeLessThan(first.positions.child.y);
  });

  test("disconnected nodes still receive positions inside the bbox", () => {
    const [nodes] = triangle();
    const result = layoutDiagram(nodes, [], heights);
    expect(Object.keys(result.positions)).toHaveLength(3);
    for (const id of ["a", "b", "c"]) {
      expect(result.positions[id].x).toBeGreaterThanOrEqual(0);
      expect(result.positions[id].y).toBeGreaterThanOrEqual(0);
    }
    expect(result.width).toBeGreaterThan(CARD_WIDTH);
  });
});

describe("gridFallbackLayout", () => {
  test("deterministic grid placement with fixed order", () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node(`t${i}`));
    const first = gridFallbackLayout(nodes, {});
    const second = gridFallbackLayout([...nodes], {});
    expect(first.positions).toEqual(second.positions);
    // Column-major: t0 and t1 share a column.
    expect(first.positions.t0.x).toBe(first.positions.t1.x);
    expect(first.positions.t0.y).not.toBe(first.positions.t1.y);
  });

  test("handles empty input without NaNs", () => {
    const result = gridFallbackLayout([], {});
    expect(result.width).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.height)).toBe(true);
  });
});

describe("applySavedPositions", () => {
  test("saved positions override computed ones; others pass through", () => {
    const computed = { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } };
    const merged = applySavedPositions(computed, { b: { x: 99, y: 98 } });
    expect(merged.a).toEqual({ x: 1, y: 2 });
    expect(merged.b).toEqual({ x: 99, y: 98 });
  });

  test("ignores malformed saved entries and null maps", () => {
    const computed = { a: { x: 1, y: 2 }, c: { x: 7, y: 8 } };
    expect(applySavedPositions(computed, null)).toEqual(computed);
    const bad = applySavedPositions(computed, {
      a: { x: Number.NaN, y: Number.NaN },
      z: { x: 0, y: 0 },
    } as never);
    expect(bad.a).toEqual({ x: 1, y: 2 }); // NaN entry rejected → computed kept
    expect(bad.c).toEqual({ x: 7, y: 8 });
  });

  test("does not mutate the computed map", () => {
    const computed = { a: { x: 1, y: 2 } };
    applySavedPositions(computed, { a: { x: 5, y: 6 } });
    expect(computed.a).toEqual({ x: 1, y: 2 });
  });
});
