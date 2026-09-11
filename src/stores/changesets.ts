import { create } from "zustand";

import type { CellAssign, RowChange, RowValue } from "@/types/ipc";
import { useTabsStore } from "@/stores/tabs";

/**
 * Per-data-tab changeset, Heidi-style: edits accumulate locally until the
 * user posts them to the backend ("Post changes") or discards them.
 *
 * Identity model:
 * - Real (DB) rows are identified by their index within the loaded dataset.
 *   Indexes are stable because pages are only ever appended and the whole
 *   dataset is replaced (clearing this changeset) on refresh/sort/filter.
 * - Updates are keyed `` `${rowIndex}:${colIndex}` `` so a single-cell edit
 *   re-renders exactly one cell via zustand selector equality.
 */

/** One locally appended (not yet posted) row. */
export interface InsertedRow {
  /** Stable client id, e.g. `"n0"` — used for selection/render keys. */
  id: string;
  /** Explicitly set cells only; untouched columns fall back to DB defaults. */
  values: Record<string, RowValue>;
}

export interface GridChangeset {
  /** Keyed by `${rowIndex}:${colIndex}` → new value. */
  updates: Record<string, RowValue>;
  inserts: InsertedRow[];
  /** Real-row indexes marked for deletion. */
  deletes: Set<number>;
}export const EMPTY_CHANGESET: GridChangeset = {
  updates: {},
  inserts: [],
  deletes: new Set<number>(),
};

/** Total pending operations (updates + inserted rows + deletions). */
export function changesetCount(cs: GridChangeset | undefined): number {
  if (!cs) return 0;
  return Object.keys(cs.updates).length + cs.inserts.length + cs.deletes.size;
}

export function updateKey(rowIndex: number, colIndex: number): string {
  return `${rowIndex}:${colIndex}`;
}

/**
 * Changeset key for one query-result grid (Phase 9-A updatable results).
 * The store is keyed by plain strings, so a query tab hosts one changeset
 * per result set without colliding with data-tab keys.
 */
export function queryChangesetKey(tabId: string, resultIndex: number): string {
  return `${tabId}#res${resultIndex}`;
}

/**
 * One reversible changeset mutation, recorded for per-change undo (Ctrl+Z,
 * HeidiSQL grid style). Reversals are applied WITHOUT recording so undo never
 * grows the stack.
 */
type UndoOp =
  | { k: "update"; key: string; prev: RowValue | undefined }
  | { k: "removeUpdate"; key: string; prev: RowValue }
  | { k: "insert"; id: string }
  | { k: "removeInsert"; row: InsertedRow }
  | { k: "insertValue"; id: string; column: string; prev: RowValue | undefined }
  | { k: "deleteToggle"; rowIndex: number }
  | { k: "clear"; snapshot: GridChangeset };

interface ChangesetsState {
  byTab: Record<string, GridChangeset>;
  /** Reverse-chronological undo ops per tab (newest last, capped). */
  history: Record<string, UndoOp[]>;
  /** Replace one cell's pending value (or remove the edit when reverting). */
  setUpdate: (tabId: string, rowIndex: number, colIndex: number, value: RowValue) => void;
  removeUpdate: (tabId: string, rowIndex: number, colIndex: number) => void;
  addInsertRow: (tabId: string, values?: Record<string, RowValue>) => string;
  removeInsertRow: (tabId: string, rowId: string) => void;
  setInsertValue: (tabId: string, rowId: string, column: string, value: RowValue) => void;
  toggleDeleteRow: (tabId: string, rowIndex: number) => void;
  clear: (tabId: string) => void;
  /** Drop a tab's changeset AND undo history (tab closed — not undoable). */
  purgeTab: (tabId: string) => void;
  /** Reverse the most recent pending change; no-op when history is empty. */
  undo: (tabId: string) => void;
}

function mutate(
  state: ChangesetsState,
  tabId: string,
  fn: (cs: GridChangeset) => GridChangeset,
): Partial<ChangesetsState> {
  const current = state.byTab[tabId] ?? EMPTY_CHANGESET;
  const next = fn(current);
  // Only touch byTab[tabId]; sibling tabs keep their identities so unrelated
  // subscribers don't re-render.
  return { byTab: { ...state.byTab, [tabId]: next } };
}

const HISTORY_CAP = 200;

function record(
  state: ChangesetsState,
  tabId: string,
  op: UndoOp,
): Partial<ChangesetsState> {
  const stack = state.history[tabId] ?? [];
  const next = stack.length >= HISTORY_CAP ? stack.slice(1) : stack.slice();
  next.push(op);
  return { history: { ...state.history, [tabId]: next } };
}

let insertSeq = 0;

export const useChangesetStore = create<ChangesetsState>((set, get) => ({
  byTab: {},

  history: {},

  setUpdate: (tabId, rowIndex, colIndex, value) =>
    set((state) => {
      const key = updateKey(rowIndex, colIndex);
      const cs = state.byTab[tabId] ?? EMPTY_CHANGESET;
      const prev = cs.updates[key];
      if (prev && sameScalarLike(prev, value)) return state;
      return {
        ...mutate(state, tabId, (cur) => ({
          ...cur,
          updates: { ...cur.updates, [key]: value },
        })),
        ...record(state, tabId, { k: "update", key, prev }),
      };
    }),

  removeUpdate: (tabId, rowIndex, colIndex) =>
    set((state) => {
      const key = updateKey(rowIndex, colIndex);
      const cs = state.byTab[tabId] ?? EMPTY_CHANGESET;
      const prev = cs.updates[key];
      if (prev === undefined) return state;
      return {
        ...mutate(state, tabId, (cur) => {
          const updates = { ...cur.updates };
          delete updates[key];
          return { ...cur, updates };
        }),
        ...record(state, tabId, { k: "removeUpdate", key, prev }),
      };
    }),

  addInsertRow: (tabId, values) => {
    const id = `n${++insertSeq}`;
    set((state) => ({
      ...mutate(state, tabId, (cs) => ({
        ...cs,
        inserts: [...cs.inserts, { id, values: values ?? {} }],
      })),
      ...record(state, tabId, { k: "insert", id }),
    }));
    return id;
  },

  removeInsertRow: (tabId, rowId) =>
    set((state) => {
      const cs = state.byTab[tabId];
      const row = cs?.inserts.find((r) => r.id === rowId);
      if (!row) return state;
      return {
        ...mutate(state, tabId, (cur) => ({
          ...cur,
          inserts: cur.inserts.filter((r) => r.id !== rowId),
        })),
        ...record(state, tabId, { k: "removeInsert", row }),
      };
    }),

  setInsertValue: (tabId, rowId, column, value) =>
    set((state) => {
      const cs = state.byTab[tabId];
      const row = cs?.inserts.find((r) => r.id === rowId);
      const prev = row?.values[column];
      if (prev && sameScalarLike(prev, value)) return state;
      return {
        ...mutate(state, tabId, (cur) => ({
          ...cur,
          inserts: cur.inserts.map((r) =>
            r.id === rowId ? { ...r, values: { ...r.values, [column]: value } } : r,
          ),
        })),
        ...record(state, tabId, { k: "insertValue", id: rowId, column, prev }),
      };
    }),

  toggleDeleteRow: (tabId, rowIndex) =>
    set((state) => ({
      ...mutate(state, tabId, (cs) => {
        const deletes = new Set(cs.deletes);
        if (deletes.has(rowIndex)) deletes.delete(rowIndex);
        else deletes.add(rowIndex);
        return { ...cs, deletes };
      }),
      ...record(state, tabId, { k: "deleteToggle", rowIndex }),
    })),

  clear: (tabId) =>
    set((state) => {
      if (!(tabId in state.byTab)) return state;
      const snapshot = state.byTab[tabId];
      return {
        ...mutate(state, tabId, () => EMPTY_CHANGESET),
        ...record(state, tabId, { k: "clear", snapshot }),
      };
    }),

  purgeTab: (tabId) =>
    set((state) => {
      if (!(tabId in state.byTab) && !(tabId in state.history)) return state;
      const byTab = { ...state.byTab };
      const history = { ...state.history };
      delete byTab[tabId];
      delete history[tabId];
      return { byTab, history };
    }),

  undo: (tabId) => {
    const state = get();
    const stack = state.history[tabId];
    const op = stack?.[stack.length - 1];
    if (!op) return;
    set((cur) => {
      const stack = cur.history[tabId] ?? [];
      const nextHistory = {
        ...cur.history,
        [tabId]: stack.slice(0, -1),
      };
      switch (op.k) {
        case "update": {
          return {
            ...mutate(cur, tabId, (cs) => {
              const updates = { ...cs.updates };
              if (op.prev === undefined) delete updates[op.key];
              else updates[op.key] = op.prev;
              return { ...cs, updates };
            }),
            history: nextHistory,
          };
        }
        case "removeUpdate":
          return {
            ...mutate(cur, tabId, (cs) => ({
              ...cs,
              updates: { ...cs.updates, [op.key]: op.prev },
            })),
            history: nextHistory,
          };
        case "insert":
          return {
            ...mutate(cur, tabId, (cs) => ({
              ...cs,
              inserts: cs.inserts.filter((r) => r.id !== op.id),
            })),
            history: nextHistory,
          };
        case "removeInsert":
          return {
            ...mutate(cur, tabId, (cs) => ({
              ...cs,
              inserts: [...cs.inserts, op.row],
            })),
            history: nextHistory,
          };
        case "insertValue":
          return {
            ...mutate(cur, tabId, (cs) => ({
              ...cs,
              inserts: cs.inserts.map((r) => {
                if (r.id !== op.id) return r;
                const values = { ...r.values };
                if (op.prev === undefined) delete values[op.column];
                else values[op.column] = op.prev;
                return { ...r, values };
              }),
            })),
            history: nextHistory,
          };
        case "deleteToggle":
          return {
            ...mutate(cur, tabId, (cs) => {
              const deletes = new Set(cs.deletes);
              if (deletes.has(op.rowIndex)) deletes.delete(op.rowIndex);
              else deletes.add(op.rowIndex);
              return { ...cs, deletes };
            }),
            history: nextHistory,
          };
        case "clear":
          return {
            ...mutate(cur, tabId, () => op.snapshot),
            history: nextHistory,
          };
      }
    });
  },
}));

/** Structural-ish equality for skipping no-op edits in the history. */
function sameScalarLike(a: RowValue, b: RowValue): boolean {
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Imperative helpers
// ---------------------------------------------------------------------------

export function getChangeset(tabId: string): GridChangeset {
  const cs = useChangesetStore.getState().byTab[tabId];
  if (cs) return cs;
  // Clone: EMPTY_CHANGESET is a shared singleton; handing out its live Set
  // would let one caller's mutation leak into every future empty read.
  return { updates: {}, inserts: [], deletes: new Set<number>() };
}

/**
 * Translate the local changeset into backend `RowChange`s plus a mapping from
 * submitted-change index back to its changeset origin, so per-row errors can
 * be reported and successful entries pruned precisely.
 */
export function buildPostPlan(
  cs: GridChangeset,
  args: {
    columns: ColumnMetaLike[];
    rows: RowValue[][];
    pkColumns: string[] | null; // null → full-row fallback decided by caller
  },
): {
  changes: RowChange[];
  origins: PostOrigin[];
  /** Column names by grid index — for mapping origins back to cell keys. */
  columnNames: string[];
} {
  const { columns, rows, pkColumns } = args;
  const keyCols = pkColumns && pkColumns.length > 0 ? pkColumns : columns.map((c) => c.name);
  const columnNames = columns.map((c) => c.name);

  const changes: RowChange[] = [];
  const origins: PostOrigin[] = [];

  // Deletions first (free rows before reusing their keys), then updates,
  // then inserts — mirrors how users expect conflicting edits to apply.
  for (const rowIndex of [...cs.deletes].sort((a, b) => b - a)) {
    const row = rows[rowIndex];
    if (!row) continue;
    changes.push({
      kind: "delete",
      pk: keyPredicate(row, columns, keyCols),
    });
    origins.push({ type: "delete", rowIndex });
  }

  // Group cell updates per row.
  const byRow = new Map<number, Map<string, RowValue>>();
  for (const [key, value] of Object.entries(cs.updates)) {
    const sep = key.indexOf(":");
    const rowIndex = Number(key.slice(0, sep));
    const colIndex = Number(key.slice(sep + 1));
    const colName = columns[colIndex]?.name;
    if (colName === undefined || !rows[rowIndex]) continue;
    let cells = byRow.get(rowIndex);
    if (!cells) {
      cells = new Map();
      byRow.set(rowIndex, cells);
    }
    cells.set(colName, value);
  }
  for (const [rowIndex, cells] of byRow) {
    const set: CellAssign[] = [...cells].map(([column, value]) => ({ column, value }));
    changes.push({
      kind: "update",
      pk: keyPredicate(rows[rowIndex], columns, keyCols),
      set,
    });
    origins.push({ type: "update", rowIndex, columns: [...cells.keys()] });
  }

  for (const row of cs.inserts) {
    changes.push({
      kind: "insert",
      values: Object.entries(row.values).map(([column, value]) => ({ column, value })),
    });
    origins.push({ type: "insert", rowId: row.id });
  }

  return { changes, origins, columnNames };
}

export type PostOrigin =
  | { type: "delete"; rowIndex: number }
  | { type: "update"; rowIndex: number; columns: string[] }
  | { type: "insert"; rowId: string };

interface ColumnMetaLike {
  name: string;
}

/** PK cells from the ORIGINAL (loaded) row values. */
function keyPredicate(
  row: RowValue[],
  columns: ColumnMetaLike[],
  keyCols: string[],
): CellAssign[] {
  return keyCols.flatMap((name) => {
    const idx = columns.findIndex((c) => c.name === name);
    // `!== undefined`, not truthiness: a legitimate PK value of 0 or ""
    // must still produce a key cell.
    return idx >= 0 && row[idx] !== undefined
      ? [{ column: name, value: row[idx] }]
      : [];
  });
}

// Keep the store tidy: drop changesets and undo history once their tab is
// closed (mirrors stores/query-editor.ts). Pending edits die with the tab —
// that is intentional: a closed tab has no grid to post them from.
useTabsStore.subscribe((next, prev) => {
  if (next.tabs.length >= prev.tabs.length) return;
  const ids = new Set(next.tabs.map((t) => t.id));
  for (const id of Object.keys(useChangesetStore.getState().byTab)) {
    if (!ids.has(id)) useChangesetStore.getState().purgeTab(id);
  }
});
