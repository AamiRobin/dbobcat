import { create } from "zustand";

import type { CellAssign, RowChange, RowValue } from "@/types/ipc";

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
}

export const EMPTY_CHANGESET: GridChangeset = {
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

interface ChangesetsState {
  byTab: Record<string, GridChangeset>;
  /** Replace one cell's pending value (or remove the edit when reverting). */
  setUpdate: (tabId: string, rowIndex: number, colIndex: number, value: RowValue) => void;
  removeUpdate: (tabId: string, rowIndex: number, colIndex: number) => void;
  addInsertRow: (tabId: string) => string;
  removeInsertRow: (tabId: string, rowId: string) => void;
  setInsertValue: (tabId: string, rowId: string, column: string, value: RowValue) => void;
  toggleDeleteRow: (tabId: string, rowIndex: number) => void;
  clear: (tabId: string) => void;
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

let insertSeq = 0;

export const useChangesetStore = create<ChangesetsState>((set) => ({
  byTab: {},

  setUpdate: (tabId, rowIndex, colIndex, value) =>
    set((state) =>
      mutate(state, tabId, (cs) => ({
        ...cs,
        updates: { ...cs.updates, [updateKey(rowIndex, colIndex)]: value },
      })),
    ),

  removeUpdate: (tabId, rowIndex, colIndex) =>
    set((state) =>
      mutate(state, tabId, (cs) => {
        if (!(updateKey(rowIndex, colIndex) in cs.updates)) return cs;
        const updates = { ...cs.updates };
        delete updates[updateKey(rowIndex, colIndex)];
        return { ...cs, updates };
      }),
    ),

  addInsertRow: (tabId) => {
    const id = `n${++insertSeq}`;
    set((state) =>
      mutate(state, tabId, (cs) => ({
        ...cs,
        inserts: [...cs.inserts, { id, values: {} }],
      })),
    );
    return id;
  },

  removeInsertRow: (tabId, rowId) =>
    set((state) =>
      mutate(state, tabId, (cs) => ({
        ...cs,
        inserts: cs.inserts.filter((r) => r.id !== rowId),
      })),
    ),

  setInsertValue: (tabId, rowId, column, value) =>
    set((state) =>
      mutate(state, tabId, (cs) => ({
        ...cs,
        inserts: cs.inserts.map((row) =>
          row.id === rowId ? { ...row, values: { ...row.values, [column]: value } } : row,
        ),
      })),
    ),

  toggleDeleteRow: (tabId, rowIndex) =>
    set((state) =>
      mutate(state, tabId, (cs) => {
        const deletes = new Set(cs.deletes);
        if (deletes.has(rowIndex)) deletes.delete(rowIndex);
        else deletes.add(rowIndex);
        return { ...cs, deletes };
      }),
    ),

  clear: (tabId) =>
    set((state) => {
      if (!(tabId in state.byTab)) return state;
      return { byTab: { ...state.byTab, [tabId]: EMPTY_CHANGESET } };
    }),
}));

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
