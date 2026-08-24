import { create } from "zustand";

import type { FilterSpec, ObjectKind, RoutineKind } from "@/types/ipc";

export type TabType =
  | "query"
  | "data"
  | "designer"
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
          : type === "users"
            ? "User manager"
            : type === "processes"
              ? "Process list"
              : type === "variables"
                ? "Variables"
                : "Object";
  return `${label} ${count}`;
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,

  openTab: (type, opts) => {
    const tab: Tab = {
      id: makeId(),
      type,
      title: opts?.title ?? nextTitle(type, get().tabs),
      icon: opts?.icon ?? ICON_BY_TYPE[type],
      closable: true,
      meta: opts?.meta ?? {},
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
    return tab;
  },

  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
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
 * Open (or focus) the Data tab for a specific table. Reuses an existing tab
 * for the same connection + db + table, Heidi-style. `initialFilter` seeds
 * the grid's server-side filter (find-text jump-to-row).
 */
export function openDataTable(
  connId: number,
  db: string,
  table: string,
  initialFilter?: FilterSpec,
): void {
  const state = useTabsStore.getState();
  const existing = state.tabs.find(
    (t) =>
      t.type === "data" &&
      t.meta.connId === connId &&
      t.meta.db === db &&
      t.meta.table === table,
  );
  if (existing) {
    state.setActive(existing.id);
    return;
  }
  state.openTab("data", {
    title: table,
    meta: { connId, db, table, initialFilter },
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
  const state = useTabsStore.getState();
  const existing = state.tabs.find(
    (t) => t.type === tool && t.meta.connId === connId,
  );
  if (existing) {
    state.setActive(existing.id);
    return;
  }
  state.openTab(tool, { meta: { connId } });
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
  const state = useTabsStore.getState();
  const existing = state.tabs.find(
    (t) =>
      t.type === "designer" &&
      t.meta.connId === connId &&
      t.meta.db === db &&
      t.meta.table === table,
  );
  if (existing) {
    state.setActive(existing.id);
    return;
  }
  state.openTab("designer", {
    title: table ?? "New table",
    icon: "workflow",
    meta: { connId, db, table },
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
  const state = useTabsStore.getState();
  const name = opts.name;
  const existing = state.tabs.find(
    (t) =>
      t.type === "object" &&
      t.meta.connId === opts.connId &&
      t.meta.db === opts.db &&
      t.meta.kind === opts.kind &&
      t.meta.name === name &&
      t.meta.mode === (opts.mode ?? "edit"),
  );
  if (existing && opts.mode !== "create") {
    state.setActive(existing.id);
    return;
  }
  state.openTab("object", {
    title: name ?? `New ${opts.kind}`,
    icon: iconKeyForObject(opts),
    meta: { ...opts, mode: opts.mode ?? "edit" },
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
