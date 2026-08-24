import { describe, expect, test } from "bun:test";

import type { SavedSession } from "@/types/ipc";

import {
  SESSION_COLORS,
  buildSessionTree,
  existingGroupPaths,
  parseGroupPath,
  sessionColor,
} from "./session-groups";

function session(id: string, group?: string, color?: string): SavedSession {
  return {
    id,
    name: id,
    dbType: "mysql",
    host: "h",
    port: 3306,
    user: "u",
    sslMode: "preferred",
    useSsh: false,
    group,
    color,
  };
}

describe("parseGroupPath", () => {
  test("splits on slash and trims segments", () => {
    expect(parseGroupPath("Work/Prod")).toEqual(["Work", "Prod"]);
    expect(parseGroupPath(" Work / Prod / EU ")).toEqual(["Work", "Prod", "EU"]);
  });

  test("drops empty segments and handles null", () => {
    expect(parseGroupPath("a//b")).toEqual(["a", "b"]);
    expect(parseGroupPath("/")).toEqual([]);
    expect(parseGroupPath(null)).toEqual([]);
    expect(parseGroupPath(undefined)).toEqual([]);
  });
});

describe("buildSessionTree", () => {
  test("nests folders and collects ungrouped at the root", () => {
    const tree = buildSessionTree([
      session("dev"),
      session("prod", "Work/Prod"),
      session("stage", "Work/Stage"),
      session("eu", "Work/Prod/EU"),
    ]);
    expect(tree.sessions.map((s) => s.id)).toEqual(["dev"]);
    expect(tree.groups.map((g) => g.name)).toEqual(["Work"]);

    const work = tree.groups[0];
    expect(work.path).toBe("Work");
    expect(work.groups.map((g) => g.name)).toEqual(["Prod", "Stage"]);
    const prod = work.groups.find((g) => g.name === "Prod")!;
    expect(prod.sessions.map((s) => s.id)).toEqual(["prod"]);
    expect(prod.groups[0].path).toBe("Work/Prod/EU");
    expect(prod.groups[0].sessions.map((s) => s.id)).toEqual(["eu"]);
  });

  test("groups sort alphabetically at every level", () => {
    const tree = buildSessionTree([
      session("1", "b/a"),
      session("2", "a"),
      session("3", "a/z"),
      session("4", "b"),
    ]);
    expect(tree.groups.map((g) => g.name)).toEqual(["a", "b"]);
    expect(tree.groups[1].groups.map((g) => g.name)).toEqual(["a"]);
  });

  test("empty input yields an empty root", () => {
    const tree = buildSessionTree([]);
    expect(tree.groups).toHaveLength(0);
    expect(tree.sessions).toHaveLength(0);
  });
});

describe("existingGroupPaths", () => {
  test("lists every intermediate path once, sorted", () => {
    const paths = existingGroupPaths([
      session("a", "Work/Prod/EU"),
      session("b", "work/prod"),
      session("c"),
    ]);
    // "work/prod" (lowercase) is a distinct path — no case folding by design.
    // Plain ASCII sort: uppercase prefixes come first.
    expect(paths).toEqual([
      "Work",
      "Work/Prod",
      "Work/Prod/EU",
      "work",
      "work/prod",
    ]);
  });
});

describe("sessionColor", () => {
  test("accepts palette colors case-insensitively", () => {
    expect(sessionColor({ color: "#3B82F6" })).toBe("#3b82f6");
    expect(sessionColor({ color: SESSION_COLORS[0] })).toBe(SESSION_COLORS[0]);
  });

  test("rejects unknown values and nullish", () => {
    expect(sessionColor({ color: "#123456" })).toBeNull();
    expect(sessionColor({ color: null })).toBeNull();
    expect(sessionColor({})).toBeNull();
  });
});
