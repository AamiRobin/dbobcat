import { describe, expect, test } from "bun:test";

import {
  collapseColinearPoints,
  pathHitsObstacles,
  pointAlongPolyline,
  pointsToSvgPath,
  polylineLength,
  routeOrthogonalAroundObstacles,
} from "./edge-routing";

const rect = (id: string, x: number, y: number, width = 100, height = 60) => ({ id, x, y, width, height });

describe("routeOrthogonalAroundObstacles", () => {
  test("straight corridor when nothing blocks the way", () => {
    // Both handles on the right side, target directly across → one bend.
    const route = routeOrthogonalAroundObstacles({
      source: { x: 0, y: 0 },
      target: { x: 300, y: 100 },
      sourceSide: "right",
      targetSide: "left",
      obstacles: [],
      endpointIds: ["a", "b"],
    });
    expect(route).not.toBeNull();
    expect(route![0]).toEqual({ x: 0, y: 0 });
    expect(route![route!.length - 1]).toEqual({ x: 300, y: 100 });
  });

  test("routes around a blocking table instead of through it", () => {
    // The direct horizontal corridor passes through the blocker; the lane
    // 20px above clears it (blocker y 90..130, lane at y 80).
    const blocker = rect("blocker", 240, 90, 100, 40);
    const route = routeOrthogonalAroundObstacles({
      source: { x: 120, y: 100 },
      target: { x: 480, y: 100 },
      sourceSide: "right",
      targetSide: "left",
      obstacles: [rect("a", 0, 70), blocker, rect("b", 480, 70)],
      endpointIds: ["a", "b"],
    });
    expect(route).not.toBeNull();
    expect(pathHitsObstacles(route!, [blocker])).toBe(false);
    expect(route!.some((p) => p.y <= 80)).toBe(true);
  });

  test("returns null when every corridor is blocked", () => {
    // Wall of obstacles covering all probe offsets.
    const wall = Array.from({ length: 20 }, (_, i) => rect(`w${i}`, 280, -600 + i * 62, 40, 60));
    const route = routeOrthogonalAroundObstacles({
      source: { x: 100, y: 0 },
      target: { x: 500, y: 0 },
      sourceSide: "right",
      targetSide: "left",
      obstacles: wall,
      endpointIds: ["a", "b"],
    });
    expect(route).toBeNull();
  });

  test("endpoint tables are not treated as obstacles", () => {
    const route = routeOrthogonalAroundObstacles({
      source: { x: 100, y: 30 },
      target: { x: 300, y: 30 },
      sourceSide: "right",
      targetSide: "left",
      obstacles: [rect("a", 0, 0), rect("b", 300, 0)],
      endpointIds: ["a", "b"],
    });
    expect(route).not.toBeNull();
  });
});

describe("pathHitsObstacles", () => {
  test("detects a segment crossing a rect", () => {
    expect(pathHitsObstacles([{ x: 0, y: 0 }, { x: 100, y: 0 }], [rect("o", 40, -10, 20, 20)])).toBe(true);
    expect(pathHitsObstacles([{ x: 0, y: 50 }, { x: 100, y: 50 }], [rect("o", 40, -10, 20, 20)])).toBe(false);
  });
});

describe("collapseColinearPoints / polylineLength", () => {
  test("collapses runs along the same axis", () => {
    const collapsed = collapseColinearPoints([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 30 },
    ]);
    expect(collapsed).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 30 }]);
    expect(polylineLength(collapsed)).toBe(50);
  });
});

describe("pointAlongPolyline", () => {
  test("interpolates by arc length and clamps", () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    expect(pointAlongPolyline(pts, 0.25)).toEqual({ x: 50, y: 0 });
    expect(pointAlongPolyline(pts, 0.75)).toEqual({ x: 100, y: 50 });
    expect(pointAlongPolyline(pts, -1)).toEqual({ x: 0, y: 0 });
    expect(pointAlongPolyline(pts, 2)).toEqual({ x: 100, y: 100 });
  });
});

describe("pointsToSvgPath", () => {
  test("emits M + L commands", () => {
    expect(pointsToSvgPath([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe("M1,2 L3,4");
    expect(pointsToSvgPath([])).toBe("");
  });
});
