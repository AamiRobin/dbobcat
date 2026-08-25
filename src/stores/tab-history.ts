import { create } from "zustand";

/**
 * Per-window LIFO trail of FK-jump data tabs (Phase 10-B). `openDataTable`
 * pushes the target whenever an open is seeded with filters; Alt+ArrowLeft in
 * the grid pops back to the tab the jump came from. Plain ids only — the
 * stack never holds closures or metadata, so stale entries are cheap to skip.
 */
interface TabHistoryState {
  stack: string[];
  /** Push a visited tab id (no-op when it already tops the stack). */
  push: (tabId: string) => void;
  /**
   * Pop back from `currentId`: discards top entries equal to it and returns
   * the most recent ancestor to activate, or null when there is none.
   */
  back: (currentId: string) => string | null;
  /** Drop a closed tab from every position. */
  remove: (tabId: string) => void;
}

export const useTabHistory = create<TabHistoryState>((set) => ({
  stack: [],

  push: (tabId) =>
    set((s) => {
      if (s.stack[s.stack.length - 1] === tabId) return s;
      return { stack: [...s.stack, tabId] };
    }),

  back: (currentId) => {
    let next: string | null = null;
    set((s) => {
      const stack = [...s.stack];
      while (stack.length > 0) {
        const top = stack.pop()!;
        if (top !== currentId) {
          next = top;
          break;
        }
      }
      return { stack };
    });
    return next;
  },

  remove: (tabId) =>
    set((s) =>
      s.stack.includes(tabId)
        ? { stack: s.stack.filter((id) => id !== tabId) }
        : s,
    ),
}));
