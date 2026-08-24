import { describe, expect, test } from "bun:test";

import {
  parseCombo,
  matches,
  cycleTabs,
  SHORTCUTS,
} from "@/lib/shortcuts";
import { useTabsStore, type Tab } from "@/stores/tabs";

describe("parseCombo", () => {
  test("parses modifiers case-insensitively", () => {
    const c = parseCombo("Mod+Shift+F");
    expect(c.key).toBe("f");
    expect(c.mods.has("mod")).toBe(true);
    expect(c.mods.has("shift")).toBe(true);
    expect(c.mods.size).toBe(2);
  });

  test("bare function keys have no modifiers", () => {
    const c = parseCombo("F9");
    expect(c.key).toBe("f9");
    expect(c.mods.size).toBe(0);
  });
});

describe("matches", () => {
  const modT = [{ mods: new Set(["mod"]), key: "t" }];

  test("exact modifier set matches", () => {
    expect(matches(modT, "Mod+T")).toBe(true);
    expect(matches(modT, "Mod+Shift+T")).toBe(false);
  });

  test("different key never matches", () => {
    expect(matches(modT, "Mod+W")).toBe(false);
  });
});

describe("registry sanity", () => {
  test("ids are unique and every def has a label + handler + combo", () => {
    const ids = new Set(SHORTCUTS.map((s) => s.id));
    expect(ids.size).toBe(SHORTCUTS.length);
    for (const def of SHORTCUTS) {
      expect(def.combos.length).toBeGreaterThan(0);
      expect(def.label.length).toBeGreaterThan(0);
      expect(typeof def.handler).toBe("function");
      for (const combo of def.combos) {
        const parsed = parseCombo(combo);
        expect(parsed.key).not.toBe("");
      }
    }
  });
});

describe("cycleTabs", () => {
  function seed(count: number) {
    const tabs: Tab[] = Array.from({ length: count }, (_, i) => ({
      id: `t${i}`,
      type: "query" as const,
      title: `Q${i}`,
      icon: "file-code",
      closable: true,
      meta: {},
    }));
    useTabsStore.getState().replaceTabs(tabs, tabs[0].id);
  }

  test("moves forward and wraps around", () => {
    seed(3);
    cycleTabs(1);
    expect(useTabsStore.getState().activeId).toBe("t1");
    cycleTabs(1);
    cycleTabs(1);
    expect(useTabsStore.getState().activeId).toBe("t0"); // wrapped
  });

  test("moves backward with wraparound", () => {
    seed(3);
    cycleTabs(-1);
    expect(useTabsStore.getState().activeId).toBe("t2");
  });

  test("no-op with fewer than two tabs", () => {
    seed(1);
    cycleTabs(1);
    expect(useTabsStore.getState().activeId).toBe("t0");
  });
});
