/**
 * Command-palette item model + pure ranking logic (palette Phase 1).
 *
 * Zero component imports: builders produce plain descriptors whose `run`
 * closures call the SAME shared entry points the toolbar and the keyboard
 * registry use (`dispatchAction` / store methods), so palette actions stay
 * in lockstep with every other surface.
 *
 * i18n decision: action items store the i18n KEY (`labelKey`) — never a
 * baked English string. `itemSearchText()` resolves keys through `t()` at
 * scoring time and the component resolves them again at render time, so a
 * future language switch re-renders correctly without rebuilding items.
 *
 * Matching follows the tree-filter precedent (`compileTreeFilter`): any
 * query is first tried as a case-insensitive JavaScript regex and an
 * INVALID regex silently falls back to literal matching (no `/.../`
 * delimiters anywhere in this codebase). On top of that, matches earn
 * tiered scores: exact > prefix > word-boundary > substring > fuzzy
 * subsequence. Regex-valid queries that match without earning a literal
 * tier land at the fuzzy tier.
 *
 * Phase 2 hooks: a `{ type: "history" }` item variant plus a `#` branch in
 * `parseMode` are reserved for query history / recents.
 */

import { t, type TKey } from "@/lib/i18n";
import { SHORTCUTS, dispatchAction } from "@/lib/shortcuts";
import { sessionColor } from "@/lib/session-groups";
import { fetchDatabases } from "@/lib/db-queries";
import { notify } from "@/lib/toast";
import { useConnectionStore } from "@/stores/connection";
import { openExportDialog } from "@/stores/export-dialog";
import { openImportWizard } from "@/stores/import-dialog";
import { openServerToolTab } from "@/stores/tabs";
import type {
  DatabaseInfo,
  SavedSession,
  SqlDialect,
  TableMeta,
} from "@/types/ipc";

// ---------------------------------------------------------------------------
// Item model
// ---------------------------------------------------------------------------

export type PaletteMode = "unified" | "commands" | "sessions";

/** One runnable app action (i18n key stored, resolved at render). */
export interface PaletteActionItem {
  type: "action";
  /** Stable id, e.g. "action.new-query". */
  id: string;
  /** Typed i18n key — misspellings are compile errors (see i18n.ts). */
  labelKey: TKey;
  /** Stable lucide icon key (resolved via the consumer's icon map). */
  icon: string;
  /** Registry combo string ("Mod+T"); formatted for display at render. */
  kbd?: string | null;
  run: () => void | Promise<void>;
}

/** One saved connection profile; `connect` uses the connection store. */
export interface PaletteSessionItem {
  type: "session";
  id: string;
  name: string;
  group: string | null;
  /** Resolved palette color (SESSION_COLORS) or null. */
  color: string | null;
  connect: () => Promise<boolean>;
}

/** One table/view of the active connection (v1 object scope). */
export interface PaletteObjectItem {
  type: "object";
  /** Unique cmdk row value: kind + db + name. */
  id: string;
  db: string;
  name: string;
  kind: "table" | "view";
}

export type PaletteItem =
  | PaletteActionItem
  | PaletteSessionItem
  | PaletteObjectItem;

/** Reserved for Phase 2 recents / query history (`#` mode). */
export interface PaletteHistoryItem {
  type: "history";
  id: string;
  sql: string;
  connName: string;
}

// ---------------------------------------------------------------------------
// Mode parsing
// ---------------------------------------------------------------------------

/** Strip the mode prefix plus at most one separating space. */
function stripOneSpace(rest: string): string {
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

/**
 * Leading `>` selects commands, `@` selects sessions; any other text stays
 * in unified mode with the raw input as the query. (Phase 2 adds `#` for
 * history right here.)
 */
export function parseMode(raw: string): { mode: PaletteMode; query: string } {
  if (raw.startsWith(">")) {
    return { mode: "commands", query: stripOneSpace(raw.slice(1)) };
  }
  if (raw.startsWith("@")) {
    return { mode: "sessions", query: stripOneSpace(raw.slice(1)) };
  }
  return { mode: "unified", query: raw };
}

// ---------------------------------------------------------------------------
// Action builder
// ---------------------------------------------------------------------------

/** Live snapshot the builder gates entries against. */
export interface PaletteActionContext {
  connected: boolean;
  connId: number | null;
  dialect: SqlDialect | null;
}

const isServerToolsReady = (ctx: PaletteActionContext): boolean =>
  ctx.connected && ctx.connId !== null && ctx.dialect !== "sqlite";

/** First registered combo of a shortcut def, for kbd hints. */
function comboOf(shortcutId: string): string | null {
  return SHORTCUTS.find((d) => d.id === shortcutId)?.combos[0] ?? null;
}

/**
 * The palette's action list. Wherever a shared action id exists it goes
 * through `dispatchAction`; direct-call flows (server tools, import/export)
 * mirror exactly how Toolbar invokes them today.
 */
export function buildActionItems(ctx: PaletteActionContext): PaletteActionItem[] {
  const items: PaletteActionItem[] = [
    {
      type: "action",
      id: "action.new-query",
      labelKey: "palette.action.newQuery",
      icon: "file-code",
      kbd: comboOf("shortcut.tab.new-query"),
      run: () => dispatchAction("tab.new-query"),
    },
    {
      type: "action",
      id: "action.session-manager",
      labelKey: "palette.action.sessionManager",
      icon: "cable",
      kbd: comboOf("shortcut.session-manager"),
      run: () => dispatchAction("session-manager.open"),
    },
  ];

  if (ctx.connected) {
    items.push({
      type: "action",
      id: "action.disconnect",
      labelKey: "palette.action.disconnect",
      icon: "unplug",
      kbd: null,
      run: () => useConnectionStore.getState().disconnect(),
    });
  } else {
    items.push({
      type: "action",
      id: "action.connect",
      labelKey: "palette.action.connect",
      icon: "plug-zap",
      kbd: null,
      // Same flow as the toolbar Connect button.
      run: () => dispatchAction("session-manager.open"),
    });
  }

  items.push(
    {
      type: "action",
      id: "action.refresh-tree",
      labelKey: "palette.action.refreshTree",
      icon: "refresh-cw",
      kbd: comboOf("shortcut.tree.refresh"),
      run: () => dispatchAction("tree.refresh"),
    },
    {
      type: "action",
      id: "action.toggle-theme",
      labelKey: "palette.action.toggleTheme",
      icon: "sun-moon",
      kbd: null,
      run: () => dispatchAction("view.toggle-theme"),
    },
  );

  if (isServerToolsReady(ctx)) {
    const connId = ctx.connId as number;
    items.push(
      {
        type: "action",
        id: "action.users",
        labelKey: "palette.action.userManager",
        icon: "users",
        kbd: null,
        run: () => openServerToolTab(connId, "users"),
      },
      {
        type: "action",
        id: "action.processes",
        labelKey: "palette.action.processList",
        icon: "activity",
        kbd: null,
        run: () => openServerToolTab(connId, "processes"),
      },
      {
        type: "action",
        id: "action.variables",
        labelKey: "palette.action.variables",
        icon: "sliders-horizontal",
        kbd: null,
        run: () => openServerToolTab(connId, "variables"),
      },
    );
  }

  if (ctx.connected && ctx.connId !== null) {
    items.push(
      {
        type: "action",
        id: "action.export",
        labelKey: "palette.action.export",
        icon: "download",
        kbd: null,
        // Dump-style export needs a database list; resolve it up front so
        // the dialog opens pre-filled over every visible database.
        run: async () => {
          const connId = useConnectionStore.getState().connId;
          if (connId === null) return;
          try {
            const dbs = await fetchDatabases(connId);
            openExportDialog({
              kind: "dump",
              connId,
              dbs: dbs.map((d) => d.name),
              tables: null,
            });
          } catch (err) {
            notify.error(
              `Export failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      },
      {
        type: "action",
        id: "action.import",
        labelKey: "palette.action.import",
        icon: "file-up",
        kbd: null,
        run: () => openImportWizard({ connId: ctx.connId as number }),
      },
    );
  }

  if (ctx.connected && ctx.dialect !== "sqlite") {
    items.push({
      type: "action",
      id: "action.find-text",
      labelKey: "palette.action.findText",
      icon: "text-search",
      kbd: comboOf("shortcut.find-text"),
      run: () => dispatchAction("find-text.open"),
    });
  }

  items.push(
    {
      type: "action",
      id: "action.shortcuts",
      labelKey: "palette.action.shortcuts",
      icon: "keyboard",
      kbd: comboOf("shortcut.help.shortcuts"),
      run: () => dispatchAction("help.shortcuts"),
    },
    {
      type: "action",
      id: "action.about",
      labelKey: "palette.action.about",
      icon: "info",
      kbd: null,
      run: () => dispatchAction("help.about"),
    },
  );

  return items;
}

// ---------------------------------------------------------------------------
// Session + object builders
// ---------------------------------------------------------------------------

/** Saved sessions → palette rows (color resolved, connect bound to store). */
export function buildSessionItems(
  savedSessions: SavedSession[],
): PaletteSessionItem[] {
  return savedSessions.map((s) => ({
    type: "session",
    id: s.id,
    name: s.name,
    group: s.group?.trim() || null,
    color: sessionColor(s),
    connect: () =>
      useConnectionStore.getState().connectSession({
        id: s.id,
        name: s.name,
        dbType: s.dbType,
        host: s.host,
        port: s.port,
        user: s.user,
        color: s.color ?? null,
      }),
  }));
}

/**
 * Flatten databases × table lists into palette rows. v1 scope is tables and
 * views only — system tables, materialized views and sequences stay out
 * (Phase 2 widens this alongside routines/triggers/events).
 */
export function buildObjectItems(
  dbs: DatabaseInfo[],
  tablesByDb: Record<string, TableMeta[] | undefined>,
): PaletteObjectItem[] {
  const items: PaletteObjectItem[] = [];
  for (const db of dbs) {
    for (const meta of tablesByDb[db.name] ?? []) {
      if (meta.kind !== "table" && meta.kind !== "view") continue;
      items.push({
        type: "object",
        id: `object:${meta.kind}:${db.name}.${meta.name}`,
        db: db.name,
        name: meta.name,
        kind: meta.kind,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const SCORE_EXACT = 100;
export const SCORE_PREFIX = 80;
export const SCORE_WORD = 60;
export const SCORE_SUBSTRING = 40;
export const SCORE_FUZZY = 20;
export const SCORE_NO_MATCH = -1;
/** Neutral score for an empty query (section order decides instead). */
export const SCORE_EMPTY = 0;

/** Text a query is matched against (labels resolved through i18n). */
export function itemSearchText(item: PaletteItem): string {
  switch (item.type) {
    case "action":
      return t(item.labelKey);
    case "session":
      return item.name;
    case "object":
      return `${item.db}.${item.name}`;
  }
}

function fuzzySubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** Tiered literal score, or null when no literal tier applies. */
function literalTier(q: string, lowerText: string): number | null {
  if (lowerText === q) return SCORE_EXACT;
  if (lowerText.startsWith(q)) return SCORE_PREFIX;
  // Word boundaries: separators are everything non-alphanumeric, so
  // "user_logs", "db.table" and "Work/Prod" all expose their parts.
  const words = lowerText.split(/[^\p{L}\p{N}]+/u);
  if (words.some((w) => w.startsWith(q))) return SCORE_WORD;
  if (lowerText.includes(q)) return SCORE_SUBSTRING;
  return null;
}

/**
 * Score one item against the query. Empty queries match everything at
 * {@link SCORE_EMPTY} (callers fall back to section order). Regex handling
 * mirrors `compileTreeFilter`: try the trimmed query as a case-insensitive
 * regex; on a compile error fall back to the literal tiers plus a fuzzy
 * subsequence tail.
 */
export function scoreItem(item: PaletteItem, query: string): number {
  const trimmed = query.trim();
  if (!trimmed) return SCORE_EMPTY;

  const q = trimmed.toLowerCase();
  const text = itemSearchText(item);
  const lower = text.toLowerCase();
  const tier = literalTier(q, lower);

  try {
    const re = new RegExp(trimmed, "i");
    if (!re.test(text)) return SCORE_NO_MATCH;
    return tier ?? SCORE_FUZZY;
  } catch {
    if (tier !== null) return tier;
    return fuzzySubsequence(q, lower) ? SCORE_FUZZY : SCORE_NO_MATCH;
  }
}

// ---------------------------------------------------------------------------
// Selection (rank + cap)
// ---------------------------------------------------------------------------

export interface PaletteSelection {
  items: PaletteItem[];
  /** Rows dropped by the cap. */
  omittedCount: number;
}

/** Tiebreak between equal scores: table > view > action > session. */
function rankPriority(item: PaletteItem): number {
  if (item.type === "object") return item.kind === "table" ? 0 : 1;
  if (item.type === "action") return 2;
  return 3;
}

/**
 * Rank `items` against `query` and cap the result. With an empty query the
 * caller's composition order passes through untouched (truncated to the
 * cap), which is how section ordering works before the user types. Ranked
 * runs sort by score desc, then kind priority, then original index — fully
 * deterministic.
 */
export function selectTop(
  items: PaletteItem[],
  query: string,
  cap = 50,
): PaletteSelection {
  if (!query.trim()) {
    return {
      items: items.slice(0, cap),
      omittedCount: Math.max(0, items.length - cap),
    };
  }

  const scored = items
    .map((item, index) => ({ item, index, score: scoreItem(item, query) }))
    .filter((entry) => entry.score >= 0);

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      rankPriority(a.item) - rankPriority(b.item) ||
      a.index - b.index,
  );

  const top = scored.slice(0, cap);
  return {
    items: top.map((entry) => entry.item),
    omittedCount: scored.length - top.length,
  };
}
