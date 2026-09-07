import { beforeEach, describe, expect } from "bun:test";
import { test } from "bun:test";

import {
  changesetCount,
  updateKey,
  useChangesetStore,
} from "./changesets";

const T = "tab1";

/** Fresh store per test: no cross-test history or changeset bleed. */
beforeEach(() => {
  useChangesetStore.setState({ byTab: {}, history: {} });
});

function cs() {
  return useChangesetStore.getState().byTab[T];
}

function historyLen() {
  return useChangesetStore.getState().history[T]?.length ?? 0;
}

describe("changesets: insert rows with values (duplicate row)", () => {
  test("addInsertRow stores pre-filled values and returns an id", () => {
    const store = useChangesetStore.getState();
    const id = store.addInsertRow(T, { name: { t: "str", v: "Ada" }, age: { t: "int", v: 36 } });
    expect(id).toBe("n1");
    expect(cs()?.inserts).toHaveLength(1);
    expect(cs()?.inserts[0].values.name).toEqual({ t: "str", v: "Ada" });
    expect(changesetCount(cs())).toBe(1);
  });

  test("addInsertRow without values keeps the blank-row behavior", () => {
    useChangesetStore.getState().addInsertRow(T);
    expect(cs()?.inserts[0].values).toEqual({});
  });

  test("undo removes a duplicated insert row", () => {
    const store = useChangesetStore.getState();
    store.addInsertRow(T, { name: { t: "str", v: "Ada" } });
    expect(cs()?.inserts).toHaveLength(1);
    useChangesetStore.getState().undo(T);
    expect(cs()?.inserts).toHaveLength(0);
    expect(historyLen()).toBe(0);
  });
});

describe("changesets: per-change undo", () => {
  test("undo reverts a cell update to no-edit, then re-edit records again", () => {
    const store = useChangesetStore.getState();
    store.setUpdate(T, 0, 1, { t: "str", v: "first" });
    store.setUpdate(T, 0, 1, { t: "str", v: "second" });
    expect(cs()?.updates[updateKey(0, 1)]).toEqual({ t: "str", v: "second" });

    useChangesetStore.getState().undo(T);
    expect(cs()?.updates[updateKey(0, 1)]).toEqual({ t: "str", v: "first" });

    useChangesetStore.getState().undo(T);
    expect(cs()?.updates[updateKey(0, 1)]).toBeUndefined();
    expect(historyLen()).toBe(0);
  });

  test("identical re-edits do not grow the history", () => {
    const store = useChangesetStore.getState();
    store.setUpdate(T, 0, 0, { t: "int", v: 5 });
    store.setUpdate(T, 0, 0, { t: "int", v: 5 });
    expect(historyLen()).toBe(1);
  });

  test("undo restores a removed update", () => {
    const store = useChangesetStore.getState();
    store.setUpdate(T, 2, 3, { t: "str", v: "x" });
    store.removeUpdate(T, 2, 3);
    expect(cs()?.updates[updateKey(2, 3)]).toBeUndefined();

    useChangesetStore.getState().undo(T);
    expect(cs()?.updates[updateKey(2, 3)]).toEqual({ t: "str", v: "x" });
  });

  test("undo reverts a delete mark", () => {
    useChangesetStore.getState().toggleDeleteRow(T, 4);
    expect(cs()?.deletes.has(4)).toBe(true);
    useChangesetStore.getState().undo(T);
    expect(cs()?.deletes.has(4)).toBe(false);
  });

  test("undo restores an insert-cell edit", () => {
    const store = useChangesetStore.getState();
    const id = store.addInsertRow(T);
    store.setInsertValue(T, id, "city", { t: "str", v: "Oslo" });
    store.setInsertValue(T, id, "city", { t: "str", v: "Lima" });

    useChangesetStore.getState().undo(T);
    expect(cs()?.inserts[0].values.city).toEqual({ t: "str", v: "Oslo" });

    useChangesetStore.getState().undo(T);
    expect(cs()?.inserts[0].values.city).toBeUndefined();
  });

  test("undo restores a removed insert row", () => {
    const store = useChangesetStore.getState();
    const id = store.addInsertRow(T, { name: { t: "str", v: "Ada" } });
    store.removeInsertRow(T, id);
    expect(cs()?.inserts).toHaveLength(0);

    useChangesetStore.getState().undo(T);
    expect(cs()?.inserts[0].values.name).toEqual({ t: "str", v: "Ada" });
  });

  test("undo after Discard (clear) restores the whole changeset", () => {
    const store = useChangesetStore.getState();
    store.setUpdate(T, 0, 0, { t: "int", v: 9 });
    store.addInsertRow(T);
    store.toggleDeleteRow(T, 3);
    expect(changesetCount(cs())).toBe(3);

    useChangesetStore.getState().clear(T);
    expect(changesetCount(cs())).toBe(0);

    useChangesetStore.getState().undo(T);
    const restored = cs();
    expect(changesetCount(restored)).toBe(3);
    expect(restored?.updates[updateKey(0, 0)]).toEqual({ t: "int", v: 9 });
    expect(restored?.deletes.has(3)).toBe(true);
  });

  test("undo on empty history is a no-op", () => {
    useChangesetStore.getState().undo(T);
    expect(cs()).toBeUndefined();
    expect(historyLen()).toBe(0);
  });

  test("history is scoped per tab", () => {
    const store = useChangesetStore.getState();
    store.setUpdate(T, 0, 0, { t: "int", v: 1 });
    store.setUpdate("tab2", 0, 0, { t: "int", v: 2 });

    useChangesetStore.getState().undo(T);
    expect(useChangesetStore.getState().byTab["tab2"]?.updates[updateKey(0, 0)]).toEqual({
      t: "int",
      v: 2,
    });
    expect(historyLen()).toBe(0);
  });
});
