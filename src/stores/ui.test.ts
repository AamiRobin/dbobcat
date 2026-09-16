import { describe, expect, test } from "bun:test";

// Storage stub installed before the store import: bun's test env has no
// window/localStorage, and the store reads the persisted log-strip flag at
// creation. Pre-seed it to prove the restore path.
const backing = new Map<string, string>([["dbobcat.logCollapsed", "true"]]);
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
  },
};

const { useUiStore } = await import("@/stores/ui");

describe("ui store log strip persistence", () => {
  test("restores the persisted collapsed state at creation", () => {
    expect(useUiStore.getState().logCollapsed).toBe(true);
  });

  test("setLogCollapsed persists the new value", () => {
    useUiStore.getState().setLogCollapsed(false);
    expect(backing.get("dbobcat.logCollapsed")).toBe("false");
    expect(useUiStore.getState().logCollapsed).toBe(false);
  });

  test("toggleLogCollapsed routes through the persisting setter", () => {
    useUiStore.getState().toggleLogCollapsed();
    expect(backing.get("dbobcat.logCollapsed")).toBe("true");
    expect(useUiStore.getState().logCollapsed).toBe(true);
  });
});
