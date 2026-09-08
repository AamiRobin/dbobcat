import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_SNAPSHOT,
  FIRST_MILESTONE,
  SNOOZE_GAP,
  STAR_STORAGE_KEY,
  isDue,
  parseSnapshot,
  snapshotAfterDismiss,
  useStarPromptStore,
  type StarPromptSnapshot,
} from "@/stores/star-prompt";

// Minimal localStorage stand-in (bun does not ship one).
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

function installStorage() {
  const storage = new MemoryStorage();
  (globalThis as Record<string, unknown>).localStorage = storage;
  return storage as unknown as Storage;
}

function at(launches: number, snoozes = 0, status: StarPromptSnapshot["status"] = "active") {
  return { launches, snoozes, status };
}

beforeEach(() => {
  installStorage();
  useStarPromptStore.setState({ ...DEFAULT_SNAPSHOT });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe("parseSnapshot", () => {
  test("missing / corrupt / wrong-shape payloads reset to defaults", () => {
    expect(parseSnapshot(null)).toEqual(DEFAULT_SNAPSHOT);
    expect(parseSnapshot("")).toEqual(DEFAULT_SNAPSHOT);
    expect(parseSnapshot("not json")).toEqual(DEFAULT_SNAPSHOT);
    expect(parseSnapshot("42")).toEqual(DEFAULT_SNAPSHOT);
    expect(parseSnapshot('{"launches":"many"}')).toEqual(DEFAULT_SNAPSHOT);
  });

  test("sanitizes partial payloads and out-of-range counts", () => {
    expect(parseSnapshot('{"launches":12,"snoozes":1}')).toEqual(at(12, 1));
    expect(parseSnapshot('{"launches":-3,"snoozes":1.7}')).toEqual(at(0, 1));
    expect(parseSnapshot('{"launches":9,"status":"done"}')).toEqual(at(9, 0, "done"));
    expect(parseSnapshot('{"status":"retired"}')).toEqual(DEFAULT_SNAPSHOT);
  });
});

describe("milestone state machine", () => {
  test("not due before the milestone", () => {
    expect(isDue(at(FIRST_MILESTONE - 1))).toBe(false);
  });

  test("due from the milestone launch onward (missed windows are not lost)", () => {
    expect(isDue(at(FIRST_MILESTONE))).toBe(true);
    expect(isDue(at(FIRST_MILESTONE + 1))).toBe(true);
  });

  test("dismissal pushes the next milestone a full snooze gap out", () => {
    const afterFirst = snapshotAfterDismiss(at(FIRST_MILESTONE));
    expect(afterFirst).toEqual(at(FIRST_MILESTONE, 1));
    expect(isDue(afterFirst)).toBe(false);
    expect(isDue(at(FIRST_MILESTONE + SNOOZE_GAP, 1))).toBe(true);
  });

  test("second dismissal retires the prompt forever", () => {
    const afterSecond = snapshotAfterDismiss(at(FIRST_MILESTONE + SNOOZE_GAP, 1));
    expect(afterSecond.status).toBe("done");
    expect(isDue(afterSecond)).toBe(false);
    expect(isDue(at(500, 2, "done"))).toBe(false);
  });
});

describe("store", () => {
  test("recordLaunch increments and persists", () => {
    useStarPromptStore.getState().recordLaunch();
    useStarPromptStore.getState().recordLaunch();
    expect(useStarPromptStore.getState().launches).toBe(2);
    expect(parseSnapshot(localStorage.getItem(STAR_STORAGE_KEY))).toEqual(at(2));
  });

  test("dismiss snoozes, persists, and retires on the final dismissal", () => {
    useStarPromptStore.setState(at(9, 0));
    useStarPromptStore.getState().dismiss();
    expect(useStarPromptStore.getState()).toMatchObject({ snoozes: 1, status: "active" });

    useStarPromptStore.getState().dismiss();
    expect(useStarPromptStore.getState().status).toBe("done");
    expect(useStarPromptStore.getState().snoozes).toBe(1);
    expect(parseSnapshot(localStorage.getItem(STAR_STORAGE_KEY)).status).toBe("done");
  });

  test("starClicked is terminal from any state", () => {
    useStarPromptStore.setState(at(FIRST_MILESTONE, 0));
    useStarPromptStore.getState().starClicked();
    expect(useStarPromptStore.getState().status).toBe("done");
    expect(isDue(useStarPromptStore.getState())).toBe(false);
  });
});
