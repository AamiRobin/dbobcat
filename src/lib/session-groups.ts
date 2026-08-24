import type { SavedSession } from "@/types/ipc";

/**
 * Session grouping (Phase 9-B): builds a nested folder tree from the
 * slash-separated `group` field ("Work/Prod" → Work ⊃ Prod). Pure logic,
 * unit-tested in `session-groups.test.ts`.
 */

/** Fixed session color palette (8 dots, Tailwind-ish hues). */
export const SESSION_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
] as const;

/** The session's palette color, or null when uncolored/unknown value. */
export function sessionColor(session: Pick<SavedSession, "color">): string | null {
  const c = session.color?.toLowerCase();
  return c && (SESSION_COLORS as readonly string[]).includes(c) ? c : null;
}

export interface SessionGroupNode {
  /** Last path segment, e.g. "Prod". */
  name: string;
  /** Full slash path from the root, e.g. "Work/Prod". */
  path: string;
  groups: SessionGroupNode[];
  sessions: SavedSession[];
}

/** Split a raw group string into clean path segments (empty → []). */
export function parseGroupPath(group: string | null | undefined): string[] {
  if (!group) return [];
  return group
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build the manager's left-panel tree: root-level groups plus all
 * ungrouped sessions. Groups sort alphabetically; sessions keep their
 * stored order inside their folder.
 */
export function buildSessionTree(sessions: SavedSession[]): SessionGroupNode {
  const root: SessionGroupNode = { name: "", path: "", groups: [], sessions: [] };

  for (const session of sessions) {
    let node = root;
    for (const segment of parseGroupPath(session.group)) {
      const path = node.path ? `${node.path}/${segment}` : segment;
      let child = node.groups.find((g) => g.name === segment);
      if (!child) {
        child = { name: segment, path, groups: [], sessions: [] };
        node.groups.push(child);
      }
      node = child;
    }
    node.sessions.push(session);
  }

  sortGroups(root.groups);
  return root;
}

function sortGroups(groups: SessionGroupNode[]): void {
  groups.sort((a, b) => a.name.localeCompare(b.name));
  for (const g of groups) sortGroups(g.groups);
}

/** Every distinct non-empty group path currently in use (form datalist). */
export function existingGroupPaths(sessions: SavedSession[]): string[] {
  const paths = new Set<string>();
  for (const s of sessions) {
    const segments = parseGroupPath(s.group);
    for (let i = 0; i < segments.length; i++) {
      paths.add(segments.slice(0, i + 1).join("/"));
    }
  }
  // Plain lexicographic sort — deterministic across locales.
  return [...paths].sort();
}
