import { create } from "zustand";

import type { FilterSpec, ObjectKind, RoutineKind } from "@/types/ipc";
import { useTabHistory } from "@/stores/tab-history";

export type TabType =
  | "query"
  | "data"
  | "designer"
  | "diagram"
  | "object"
  | "users"
  | "processes"
  | "variables";

/**
 * Serializable tab descriptor. `icon` is a stable string key resolved to a
 * lucide component at render time (see TAB_ICONS) so state stays serializable.
 */
export interface Tab {
  id: string;
  type: TabType;
  title: string;
  icon: string;
  closable: boolean;
  /** Per-tab payload (connection id, sql text cache, table ref, ...). */
  meta: Record<string, unknown>;
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  openTab: (type: TabType, opts?: Partial<Pick<Tab, "title" | "icon" | "meta">>) => Tab;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  /** Bulk-restore persisted tabs at launch (Phase 8 session restore). */
  replaceTabs: (tabs: Tab[], activeId: string | null) => void;
}

const ICON_BY_TYPE: Record<TabType, string> = {
  query: "file-code",
  data: "table",
  designer: "workflow",
  diagram: "network",
  object: "braces",
  users: "users",
  processes: "activity",
  variables: "sliders-horizontal",
};

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Next ordinal per type, e.g. the "3" in "Query 3". */
function nextTitle(type: TabType, tabs: Tab[]): string {
  const count = tabs.filter((t) => t.type === type).length + 1;
  const label =
    type === "query"
      ? "Query"
      : type === "data"
        ? "Data"
        : type === "designer"
          ? "Designer"
          : type === "diagram"
            ? "Diagram"
            : type === "users"
              ? "User manager"
              : type === "processes"
                ? "Process list"
                : type === "variables"
                  ? "Variables"
                  : "Object";
  return `${label} ${count}`;
}

export const useTabsStore = create<TabsState>((set) => ({
  tabs: [],
  activeId: null,

  openTab: (type, opts) => {
    const base = {
      id: makeId(),
      type,
      icon: opts?.icon ?? ICON_BY_TYPE[type],
      closable: true,
      meta: opts?.meta ?? {},
    };
    // Title derives INSIDE the updater from pending state so interleaved
    // opens can never mint duplicate ordinals off a stale snapshot.
    let created: Tab = { ...base, title: opts?.title ?? "" };
    set((s) => {
      created = { ...base, title: opts?.title ?? nextTitle(type, s.tabs) };
      return { tabs: [...s.tabs, created], activeId: created.id };
    });
    return created;
  },

  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      // Keep the FK-jump trail free of dead tabs.
      useTabHistory.getState().remove(id);
      let activeId = s.activeId;
      if (s.activeId === id) {
        // Prefer the neighbour on the left, else the first remaining tab.
        activeId = tabs[Math.max(0, idx - 1)]?.id ?? null;
      }
      return { tabs, activeId };
    }),

  setActive: (id) => set({ activeId: id }),

  replaceTabs: (tabs, activeId) => set({ tabs, activeId }),
}));

/** Imperative helper for opening tabs outside React components. */
export function openTab(type: TabType): Tab {
  return useTabsStore.getState().openTab(type);
}

/**
 * Retarget the data tab of a renamed/moved table so the open grid follows
 * the table instead of serving ghost data under the old name. At most one
 * data tab per connection+db+table exists (openDataTable dedupes).
 */
export function retargetDataTabs(
  connId: number,
  db: string,
  table: string,
  next: { db?: string; table?: string },
): void {
  useTabsStore.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.type === "data" &&
      t.meta.connId === connId &&
      t.meta.db === db &&
      t.meta.table === table
        ? {
            ...t,
            title: (next.table as string) ?? t.title,
            meta: { ...t.meta, db: next.db ?? db, table: next.table ?? table },
          }
        : t,
    ),
  }));
}

/** Close the data tab(s) of a dropped table so no zombie grid lingers. */
export function closeDataTabs(connId: number, db: string, table: string): void {
  useTabsStore.setState((s) => {
    const dead = new Set(
      s.tabs
        .filter(
          (t) =>
            t.type === "data" &&
            t.meta.connId === connId &&
            t.meta.db === db &&
            t.meta.table === table,
        )
        .map((t) => t.id),
    );
    if (dead.size === 0) return s;
    const tabs = s.tabs.filter((t) => !dead.has(t.id));
    let activeId = s.activeId;
    if (activeId !== null && dead.has(activeId)) {
      activeId = tabs[0]?.id ?? null;
    }
    return { tabs, activeId };
  });
}

/**
 * Open (or focus) the Data tab for a specific table. Reuses an existing tab
 * for the same connection + db + table, Heidi-style; re-seeding with new
 * `initialFilters` overwrites the pending seed and bumps `filterEpoch` so the
 * grid remounts and picks them up (pending changesets are keyed by tab id and
 * survive the remount).
 */
export function openDataTable(
  connId: number,
  db: string,
  table: string,
  initialFilters?: FilterSpec[],
): void {
  const seeded = initialFilters && initialFilters.length > 0 ? initialFilters : undefined;
  // Existence check + activate/create happen in ONE updater so a concurrent
  // mutation between the find and the append can't duplicate or mis-focus.
  useTabsStore.setState((s) => {
    const existing = s.tabs.find(
      (t) =>
        t.type === "data" &&
        t.meta.connId === connId &&
        t.meta.db === db &&
        t.meta.table === table,
    );
    if (existing) {
      if (!seeded) return { activeId: existing.id };
      const tabs = s.tabs.map((t) =>
        t.id === existing.id
          ? {
              ...t,
              meta: {
                ...t.meta,
                initialFilters: seeded,
                filterEpoch: ((t.meta.filterEpoch as number | undefined) ?? 0) + 1,
              },
            }
          : t,
      );
      // Seeded re-open = a navigation step; record it for Alt+ArrowLeft.
      useTabHistory.getState().push(existing.id);
      return { tabs, activeId: existing.id };
    }
    const tab: Tab = {
      id: makeId(),
      type: "data",
      title: table,
      icon: ICON_BY_TYPE.data,
      closable: true,
      meta: {
        connId,
        db,
        table,
        initialFilters: seeded,
        filterEpoch: seeded ? 1 : 0,
      },
    };
    if (seeded) useTabHistory.getState().push(tab.id);
    return { tabs: [...s.tabs, tab], activeId: tab.id };
  });
}

/**
 * Open (or focus) a server-tool tab (users / processes / variables) for one
 * connection. Reuses the existing tab for that connection + tool.
 */
export function openServerToolTab(
  connId: number,
  tool: "users" | "processes" | "variables",
): void {
  useTabsStore.setState((s) => {
    const existing = s.tabs.find(
      (t) => t.type === tool && t.meta.connId === connId,
    );
    if (existing) return { activeId: existing.id };
    const tab: Tab = {
      id: makeId(),
      type: tool,
      title: nextTitle(tool, s.tabs),
      icon: ICON_BY_TYPE[tool],
      closable: true,
      meta: { connId },
    };
    return { tabs: [...s.tabs, tab], activeId: tab.id };
  });
}

/**
 * Open (or focus) the Table Designer for one table. `table` omitted →
 * create-mode designer for `db`. Reuses an existing designer tab for the
 * same target.
 */
export function openDesignerTab(
  connId: number,
  db: string,
  table?: string,
): void {
  useTabsStore.setState((s) => {
    const existing = s.tabs.find(
      (t) =>
        t.type === "designer" &&
        t.meta.connId === connId &&
        t.meta.db === db &&
        t.meta.table === table,
    );
    if (existing) return { activeId: existing.id };
    const tab: Tab = {
      id: makeId(),
      type: "designer",
      title: table ?? "New table",
      icon: "workflow",
      closable: true,
      meta: { connId, db, table },
    };
    return { tabs: [...s.tabs, tab], activeId: tab.id };
  });
}

/**
 * Open (or focus) the ER diagram tab for one database. One tab per
 * connection + database; reopening focuses the existing one.
 */
export function openDiagramTab(connId: number, db: string): void {
  useTabsStore.setState((s) => {
    const existing = s.tabs.find(
      (t) =>
        t.type === "diagram" &&
        t.meta.connId === connId &&
        t.meta.db === db,
    );
    if (existing) return { activeId: existing.id };
    const tab: Tab = {
      id: makeId(),
      type: "diagram",
      title: `${db} — ER`,
      icon: ICON_BY_TYPE.diagram,
      closable: true,
      meta: { connId, db },
    };
    return { tabs: [...s.tabs, tab], activeId: tab.id };
  });
}

/**
 * Open (or focus) a code-editor tab for a view/routine/trigger/event.
 * Create-mode passes `mode: "create"` plus a pre-filled template SQL.
 */
export function openObjectEditorTab(opts: {
  connId: number;
  db: string;
  kind: ObjectKind;
  name?: string;
  routineKind?: RoutineKind;
  mode?: "edit" | "create";
}): void {
  const name = opts.name;
  useTabsStore.setState((s) => {
    const existing = s.tabs.find(
      (t) =>
        t.type === "object" &&
        t.meta.connId === opts.connId &&
        t.meta.db === opts.db &&
        t.meta.kind === opts.kind &&
        t.meta.name === name &&
        t.meta.mode === (opts.mode ?? "edit"),
    );
    // Create-mode always opens a fresh editor, Heidi-style.
    if (existing && opts.mode !== "create") return { activeId: existing.id };
    const tab: Tab = {
      id: makeId(),
      type: "object",
      title: name ?? `New ${opts.kind}`,
      icon: iconKeyForObject(opts),
      closable: true,
      meta: { ...opts, mode: opts.mode ?? "edit" },
    };
    return { tabs: [...s.tabs, tab], activeId: tab.id };
  });
}

function iconKeyForObject(o: {
  kind: ObjectKind;
  routineKind?: RoutineKind;
}): string {
  switch (o.kind) {
    case "view":
      return "eye";
    case "routine":
      return o.routineKind === "function" ? "sigma" : "braces";
    case "trigger":
      return "zap";
    case "event":
      return "clock";
    default:
      return "braces";
  }
}
