import { afterAll, describe, expect, test } from "bun:test";
import type { Theme } from "@/stores/ui";

// Storage stub installed before the store import: bun's test env has no
// window/localStorage, and the store reads the persisted log-strip flag at
// creation. Pre-seed it to prove the restore path. In a browser
// window.localStorage IS the global localStorage — one object here too.
const backing = new Map<string, string>([["dbobcat.logCollapsed", "true"]]);
const storage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
};

// The store captures matchMedia's result once at import, so `matches` is a
// getter over the mutable scenario flag; addEventListener is stubbed for the
// store's module-level OS-appearance listener.
let osDark = false;
let bootDarkClass = false;
const windowStub = {
  matchMedia: (query: string) => {
    if (query !== "(prefers-color-scheme: dark)") {
      throw new Error(`unexpected media query: ${query}`);
    }
    return {
      get matches() {
        return osDark;
      },
      addEventListener: () => {},
    };
  },
  localStorage: storage,
};

(globalThis as { window?: unknown }).window = windowStub;
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { document?: unknown }).document = {
  documentElement: {
    classList: {
      toggle: (_cls: string, on: boolean) => {
        bootDarkClass = on;
      },
    },
  },
};

const { loadInitialThemePref, resolveTheme, useUiStore } = await import(
  "@/stores/ui"
);

// bun test runs every file in one process against a shared globalThis and
// module registry, so anything this file installs must be taken back down
// before the next file runs.
afterAll(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { window?: unknown }).window;
});

// The pre-paint boot script resolves the theme in <head>, before the bundle
// (and this store) exists; it must mirror the store's resolution exactly or
// launch flashes the wrong theme. These cases run BOTH resolvers over the
// same stubbed environment and require the literal expected answer — not
// merely equality with each other, so a bug copied to both sides still fails.
const bootSource = await Bun.file(
  new URL("../../public/theme-boot.js", import.meta.url),
).text();

function runBootScript(): boolean {
  bootDarkClass = false;
  new Function(bootSource)();
  return bootDarkClass;
}

interface BootScenario {
  name: string;
  /** Raw storage payload; deliberately `string`, not the pref union — the
   * invalid-value case proves junk is ignored. */
  stored: string | null;
  osDark: boolean;
  storageThrows?: boolean;
  expected: Theme;
}

const bootScenarios: BootScenario[] = [
  { name: "explicit dark wins over a light OS", stored: "dark", osDark: false, expected: "dark" },
  { name: "explicit light wins over a dark OS", stored: "light", osDark: true, expected: "light" },
  { name: "system pref with a dark OS", stored: "system", osDark: true, expected: "dark" },
  { name: "system pref with a light OS", stored: "system", osDark: false, expected: "light" },
  { name: "no stored pref (first run) follows a dark OS", stored: null, osDark: true, expected: "dark" },
  { name: "no stored pref (first run) follows a light OS", stored: null, osDark: false, expected: "light" },
  { name: "blocked storage falls back to the dark OS", stored: null, osDark: true, storageThrows: true, expected: "dark" },
  { name: "unknown stored value is treated as system", stored: "banana", osDark: false, expected: "light" },
];

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

describe("theme-boot.js drift vs store resolution", () => {
  test("index.html still loads the boot script before first paint", async () => {
    const html = await Bun.file(
      new URL("../../index.html", import.meta.url),
    ).text();
    expect(html).toContain('<script src="/theme-boot.js"></script>');
  });

  for (const scenario of bootScenarios) {
    test(`${scenario.name} — boot and store both say ${scenario.expected}`, () => {
      if (scenario.stored === null) backing.delete("dbobcat.themePref");
      else backing.set("dbobcat.themePref", scenario.stored);
      osDark = scenario.osDark;

      const realGetItem = storage.getItem;
      if (scenario.storageThrows) {
        storage.getItem = () => {
          throw new Error("storage blocked");
        };
      }
      try {
        const bootDark = runBootScript();
        const storeTheme = resolveTheme(loadInitialThemePref());
        expect(bootDark).toBe(scenario.expected === "dark");
        expect(storeTheme).toBe(scenario.expected);
      } finally {
        storage.getItem = realGetItem;
      }
    });
  }
});
