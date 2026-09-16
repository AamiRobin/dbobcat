import { describe, expect, test } from "bun:test";

// Storage stub installed before importing the module under test: bun's test
// env has no window/localStorage, and ui-prefs reads it lazily per call.
const backing = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
  },
};

const { readNumberPref, readPref, writePref } = await import("@/lib/ui-prefs");

describe("ui-prefs", () => {
  test("round-trips values under the dbobcat. prefix", () => {
    writePref("someFlag", true);
    expect(backing.get("dbobcat.someFlag")).toBe("true");
    expect(readPref("someFlag")).toBe(true);
    expect(readPref("neverWritten")).toBeNull();
  });

  test("reads numbers clamped to the given bounds", () => {
    writePref("tiny", 1);
    expect(readNumberPref("tiny", 10, 60)).toBe(10);
    writePref("huge", 999);
    expect(readNumberPref("huge", 10, 60)).toBe(60);
    writePref("ok", 26);
    expect(readNumberPref("ok", 10, 60)).toBe(26);
  });

  test("rejects non-numeric payloads instead of clamping them", () => {
    writePref("junk", "26");
    expect(readNumberPref("junk", 10, 60)).toBeNull();
  });
});
