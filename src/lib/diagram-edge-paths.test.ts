import { describe, expect, test } from "bun:test";

import {
  CARD_HEADER_HEIGHT,
  CARD_WIDTH,
  ROW_HEIGHT,
} from "./diagram-model";
import {
  computeEdgeGeometry,
  crowFootPath,
  type CardBox,
} from "./diagram-edge-paths";

function box(x: number, y: number, height = 126): CardBox {
  return { x, y, height, rowIndex: null };
}

const baseEdge = {
  id: "e",
  name: "fk_orders_customers",
  source: "customers",
  target: "orders",
  sourceColumn: "id",
  targetColumn: "customer_id",
  nullableChild: false,
  composite: false,
  onUpdate: null,
  onDelete: null,
};

describe("computeEdgeGeometry", () => {
  test("connects side borders when horizontally separated", () => {
    const boxes = {
      customers: box(0, 0),
      orders: box(400, 40),
    };
    const geo = computeEdgeGeometry(baseEdge, boxes);
    expect(geo).not.toBeNull();
    // Starts at the parent's RIGHT border and ends at the child's LEFT border.
    const [mx, my] = (geo!.d.match(/^M ([\d.]+) ([\d.]+)/) ?? []).slice(1).map(Number);
    expect(mx).toBe(CARD_WIDTH);
    expect(my).toBeGreaterThan(0); // inside the card
    expect(geo!.d).toMatch(/C /);
  });

  test("row-aware anchor snaps to the FK column's row when visible", () => {
    const rowIndex = { customer_id: 2 };
    const targetBox = { x: 400, y: 100, height: 200, rowIndex };
    const boxes = {
      customers: box(0, 100),
      orders: targetBox,
    };
    const geo = computeEdgeGeometry(baseEdge, boxes)!;
    const endY = Number(geo.d.match(/([\d.]+)$/)?.[1] ?? Number.NaN);
    const expected = targetBox.y + CARD_HEADER_HEIGHT + 2 * ROW_HEIGHT + ROW_HEIGHT / 2;
    expect(endY).toBeCloseTo(expected, 5);
  });

  test("collapsed cards anchor at mid-border", () => {
    const collapsedBox = { x: 400, y: 100, height: 26, rowIndex: null };
    const boxes = {
      customers: box(0, 100),
      orders: collapsedBox,
    };
    const geo = computeEdgeGeometry(baseEdge, boxes)!;
    const endY = Number(geo.d.match(/([\d.]+)$/)?.[1] ?? Number.NaN);
    expect(endY).toBeCloseTo(collapsedBox.y + collapsedBox.height / 2, 5);
  });

  test("vertical stacking connects top/bottom borders", () => {
    const boxes = {
      customers: box(0, 0),
      orders: box(10, 300),
    };
    const geo = computeEdgeGeometry(baseEdge, boxes)!;
    // Ends at the child's TOP border.
    expect(geo.d.endsWith(` ${boxes.orders.y}`)).toBe(true);
  });

  test("returns null for missing endpoints or fully overlapping cards", () => {
    expect(computeEdgeGeometry(baseEdge, { customers: box(0, 0) })).toBeNull();
    const overlap = { customers: box(0, 0), orders: box(0, 0) };
    expect(computeEdgeGeometry(baseEdge, overlap)).toBeNull();
  });
});

describe("crowFootPath", () => {
  test("prongs open away from the card along the incoming direction", () => {
    // Moving right (angle 0) into a left border → prongs extend to -x.
    const path = crowFootPath({ x: 100, y: 50 }, 0);
    expect(path).toBe("M 93.00 55.00 L 100.00 50.00 L 93.00 45.00");
  });

  test("rotates with the incoming tangent", () => {
    // Moving down (angle π/2) into a top border → prongs extend to -y.
    const path = crowFootPath({ x: 100, y: 100 }, Math.PI / 2);
    expect(path).toBe("M 95.00 93.00 L 100.00 100.00 L 105.00 93.00");
  });

  test("geometry is symmetric around the tip", () => {
    const path = crowFootPath({ x: 10, y: 10 }, 0);
    const parts = path.split(/[\sL]+/).map(Number);
    const p1x = parts[1];
    const p2x = parts[5];
    expect(p1x).toBeCloseTo(3, 5); // tip.x - FOOT_DEPTH
    expect(p2x).toBeCloseTo(3, 5); // mirrored
    const p1y = parts[2];
    const p2y = parts[6];
    expect(p1y + p2y).toBeCloseTo(20, 5); // symmetric across tip.y=10
  });
});

describe("edge foot selection", () => {
  test("nullable child gets an outline foot; composite gets none", () => {
    const boxes = { customers: box(0, 0), orders: box(400, 0) };
    const filled = computeEdgeGeometry({ ...baseEdge, nullableChild: false }, boxes)!;
    const outline = computeEdgeGeometry({ ...baseEdge, nullableChild: true }, boxes)!;
    const composite = computeEdgeGeometry({ ...baseEdge, composite: true }, boxes)!;

    expect(filled.foot).not.toBeNull();
    expect(filled.filled).toBe(true);
    expect(outline.filled).toBe(false);
    expect(composite.foot).toBeNull();
  });

  test("label point sits between the two anchors", () => {
    const boxes = { customers: box(0, 0), orders: box(400, 0) };
    const geo = computeEdgeGeometry(baseEdge, boxes)!;
    expect(geo.labelPoint.x).toBeCloseTo((CARD_WIDTH + 400) / 2, 5);
    expect(geo.labelPoint.y).toBeCloseTo(63, 5); // both mid-borders
  });
});
