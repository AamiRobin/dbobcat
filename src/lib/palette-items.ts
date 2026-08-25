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
 * Phase 2: a leading `#` selects query-history mode (`PaletteHistoryItem`
 * pool), object items widen past tables/views to routines/triggers/events,
 * and recents are plain object rows stamped with `lastOpenedAt`.
 *
 * Phase 3: a leading `db:` selects database-scoped mode (objects + columns
 * of matching dbs only), dot-scoped queries (`shop.ord`, `shop.users.email`)
 * narrow unified matching, and a third-wave `column` item kind joins the
 * pool below every object kind in the tiebreak chain.
 */

import { t, type TKey } from "@/lib/i18n";
import { SHORTCUTS, dispatchAction } from "@/lib/shortcuts";
import { sessionColor } from "@/lib/session-groups";
import { fetchDatabases } from "@/lib/db-queries";
import type { RecentDescriptor } from "@/lib/palette-recents";
import { snippet } from "@/lib/query-queries";
import { notify } from "@/lib/toast";
import { useConnectionStore } from "@/stores/connection";
import { openExportDialog } from "@/stores/export-dialog";
import { openImportWizard } from "@/stores/import-dialog";
import { openServerToolTab } from "@/stores/tabs";
import type {
  ColumnMeta,
  DatabaseInfo,
  EventMeta,
  HistoryEntry,
  RoutineKind,
  RoutineMeta,
  SavedSession,
  SqlDialect,
  TableMeta,
  TriggerMeta,
} from "@/types/ipc";

// ---------------------------------------------------------------------------
// Item model
// ---------------------------------------------------------------------------

export type PaletteMode = "unified" | "commands" | "sessions" | "history" | "db";

/** Object kinds searchable in the palette (mirrors the tree's leaf kinds). */
export type PaletteObjectKind = "table" | "view" | "routine" | "trigger" | "event";

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

/** One searchable object of the active connection. */
export interface PaletteObjectItem {
  type: "object";
  /** Unique cmdk row value: kind + db + name. */
  id: string;
  db: string;
  name: string;
  kind: PaletteObjectKind;
  /** procedure vs function — only set for routines (drives icon + editor). */
  routineKind?: RoutineKind;
  /**
   * ISO timestamp present ONLY on recents rows (set by
   * `buildRecentItems`); used to split the RECENTS section from the
   * regular object sections at render time.
   */
  lastOpenedAt?: string;
}

export type PaletteItem =
  | PaletteActionItem
  | PaletteSessionItem
  | PaletteObjectItem
  | PaletteHistoryItem
  | PaletteColumnItem;

/** One executed script from the persisted query history (`#` mode). */
export interface PaletteHistoryItem {
  type: "history";
  id: string;
  sql: string;
  connName: string;
  executedAt: string;
}

/**
 * One column of a table (Phase 3 third wave). Activation targets the
 * PARENT table — Enter opens its data grid, Shift+Enter its designer —
 * columns themselves have no dedicated surface, and they never enter the
 * recents model.
 */
export interface PaletteColumnItem {
  type: "column";
  /** Unique cmdk row value: `column:<db>.<table>.<name>`. */
  id: string;
  db: string;
  table: string;
  name: string;
  /** Driver-native type (`varchar(40)`), shown as muted right meta. */
  dataType?: string;
  /** Primary-key flag — swaps DbTree's Hash icon for its Key. */
  pk?: boolean;
}

// ---------------------------------------------------------------------------
// Mode parsing
// ---------------------------------------------------------------------------

/** Strip the mode prefix plus at most one separating space. */
function stripOneSpace(rest: string): string {
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

/**
 * Leading `>` selects commands, `@` sessions, `#` query history and `db:`
 * database-scoped mode (Phase 3, last slot in the Tab cycle); any other
 * text stays in unified mode with the raw input as the query.
 */
export function parseMode(raw: string): { mode: PaletteMode; query: string } {
  if (raw.startsWith(">")) {
    return { mode: "commands", query: stripOneSpace(raw.slice(1)) };
  }
  if (raw.startsWith("@")) {
    return { mode: "sessions", query: stripOneSpace(raw.slice(1)) };
  }
  if (raw.startsWith("#")) {
    return { mode: "history", query: stripOneSpace(raw.slice(1)) };
  }
  if (raw.startsWith("db:")) {
    return { mode: "db", query: stripOneSpace(raw.slice(3)) };
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

/** Optional per-db second-wave pools (routines/triggers/events). */
export type PoolByDb<T> = Record<string, T[] | undefined>;

/**
 * Flatten databases × object lists into palette rows. Tables/views come
 * from the first-wave table scan; routines/triggers/events flow in from the
 * (dialect-gated) second wave — the caller passes only pools it actually
 * fetched, mirroring how DbTree hides whole groups per engine. System
 * tables, materialized views and sequences stay out.
 */
export function buildObjectItems(
  dbs: DatabaseInfo[],
  tablesByDb: PoolByDb<TableMeta>,
  routinesByDb: PoolByDb<RoutineMeta> = {},
  triggersByDb: PoolByDb<TriggerMeta> = {},
  eventsByDb: PoolByDb<EventMeta> = {},
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
    for (const routine of routinesByDb[db.name] ?? []) {
      items.push({
        type: "object",
        id: `object:routine:${db.name}.${routine.name}`,
        db: db.name,
        name: routine.name,
        kind: "routine",
        routineKind: routine.kind,
      });
    }
    for (const trigger of triggersByDb[db.name] ?? []) {
      items.push({
        type: "object",
        id: `object:trigger:${db.name}.${trigger.name}`,
        db: db.name,
        name: trigger.name,
        kind: "trigger",
      });
    }
    for (const event of eventsByDb[db.name] ?? []) {
      items.push({
        type: "object",
        id: `object:event:${db.name}.${event.name}`,
        db: db.name,
        name: event.name,
        kind: "event",
      });
    }
  }
  return items;
}

/**
 * Per-db map of table → described columns (third-wave pool, Phase 3). The
 * caller assembles it from the SAME `dbKeys.columns` cache the lazy tree
 * uses, so anything already expanded in the tree costs nothing.
 */
export type ColumnsByDb = Record<
  string,
  Record<string, ColumnMeta[] | undefined>
>;

/**
 * Scale honesty: a 100-db server × 50 tables × 40 columns puts hundreds of
 * thousands of rows within reach. The per-db ceiling keeps the built pool
 * bounded — once a db hits the cap its remaining columns are dropped
 * deterministically (tree order, ordinal order within a table); other dbs
 * are unaffected. Tune only with real-world evidence.
 */
export const COLUMN_POOL_CAP_PER_DB = 2000;

/**
 * Flatten third-wave column caches into palette rows. Only dbs whose table
 * list has landed contribute (the caller's fan-out mirrors this), and only
 * plain tables do — DbTree's view nodes carry no column children, so
 * mirroring the tree keeps scope honest. Order: dbs × tree order × ordinal.
 */
export function buildColumnItems(
  dbs: DatabaseInfo[],
  tablesByDb: PoolByDb<TableMeta>,
  columnsByDb: ColumnsByDb,
  capPerDb: number = COLUMN_POOL_CAP_PER_DB,
): PaletteColumnItem[] {
  const items: PaletteColumnItem[] = [];
  for (const db of dbs) {
    const metas = tablesByDb[db.name];
    if (!metas) continue; // tables wave not settled for this db
    const columnsForDb = columnsByDb[db.name] ?? {};
    let count = 0;
    for (const meta of metas) {
      if (meta.kind !== "table") continue;
      for (const col of columnsForDb[meta.name] ?? []) {
        if (count >= capPerDb) break;
        count++;
        items.push({
          type: "column",
          id: `column:${db.name}.${meta.name}.${col.name}`,
          db: db.name,
          table: meta.name,
          name: col.name,
          dataType: col.dataType,
          pk: col.key === "PRI" ? true : undefined,
        });
      }
      if (count >= capPerDb) break;
    }
  }
  return items;
}

/**
 * Persisted history entries → palette rows, preserving the store's
 * most-recent-first order.
 */
export function buildHistoryItems(entries: HistoryEntry[]): PaletteHistoryItem[] {
  return entries.map((entry) => ({
    type: "history" as const,
    id: `history:${entry.id}`,
    sql: entry.sql,
    connName: entry.connName,
    executedAt: entry.executedAt,
  }));
}

/**
 * The unified-mode QUERY HISTORY slice: the `limit` newest entries
 * regardless of the pool's incoming order (defensive — the backend already
 * returns newest-first).
 */
export function sliceRecentHistory(
  entries: HistoryEntry[],
  limit = 8,
): HistoryEntry[] {
  return [...entries]
    .sort((a, b) => b.executedAt.localeCompare(a.executedAt))
    .slice(0, limit);
}

/**
 * Resolved recent descriptors → palette rows. Rows keep their descriptor
 * order (LRU, most-recent-first) and carry `lastOpenedAt` so the renderer
 * can split them into the RECENTS section.
 */
export function buildRecentItems(
  descriptors: RecentDescriptor[],
): PaletteObjectItem[] {
  return descriptors.map((d) => ({
    type: "object" as const,
    id: `object:${d.kind}:${d.db}.${d.name}`,
    db: d.db,
    name: d.name,
    kind: d.kind,
    lastOpenedAt: d.lastOpenedAt,
  }));
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
    case "column":
      // Dotted path keeps word-boundary matching per segment ("users" hits
      // shop.users.email; "email" starts a word too). Data types stay out —
      // "int" would flood every result.
      return `${item.db}.${item.table}.${item.name}`;
    case "history":
      // Match against what the row shows (single-line snippet) plus the
      // connection it ran on, not the full multi-KB script.
      return `${snippet(item.sql)} ${item.connName}`;
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
 * Tiered score for a bare text against the query — the engine behind
 * `scoreItem`, also used directly for `db:`-mode database-name matching.
 * Empty queries match everything at {@link SCORE_EMPTY}. Regex handling
 * mirrors `compileTreeFilter`: try the trimmed query as a case-insensitive
 * regex; on a compile error fall back to the literal tiers plus a fuzzy
 * subsequence tail.
 */
export function scoreText(text: string, query: string): number {
  const trimmed = query.trim();
  if (!trimmed) return SCORE_EMPTY;

  const q = trimmed.toLowerCase();
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

/**
 * Score one item against the query via its searchable text
 * ({@link itemSearchText}).
 */
export function scoreItem(item: PaletteItem, query: string): number {
  if (!query.trim()) return SCORE_EMPTY;
  return scoreText(itemSearchText(item), query);
}

// ---------------------------------------------------------------------------
// Selection (rank + cap)
// ---------------------------------------------------------------------------

export interface PaletteSelection {
  items: PaletteItem[];
  /** Rows dropped by the cap. */
  omittedCount: number;
}

/**
 * Tiebreak between equal scores, most to least important:
 * table > view > routine > trigger > event > column > action > session >
 * history. Columns sit below every object kind so they surface mainly when
 * object names don't match well; a prefix hit on a column still beats a
 * fuzzy hit on a table (tier decides first — that's desirable). Within one
 * kind the original composition order decides (recency for recents/
 * history), keeping runs fully deterministic.
 */
function rankPriority(item: PaletteItem): number {
  if (item.type === "object") {
    switch (item.kind) {
      case "table":
        return 0;
      case "view":
        return 1;
      case "routine":
        return 2;
      case "trigger":
        return 3;
      case "event":
        return 4;
    }
  }
  if (item.type === "column") return 5;
  if (item.type === "action") return 6;
  if (item.type === "session") return 7;
  return 8; // history
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

// ---------------------------------------------------------------------------
// Scoped queries — `db.object` / `db.object.column` (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Scoped unified query. Grammar (documented contract, tested in
 * palette-items.test.ts): dot-separated SIMPLE identifiers only — Unicode
 * letters/digits plus `_`/`$`; no quotes, backticks or whitespace.
 *
 *   "db."              → every object of any kind in db (empty remainder =
 *                        list all; lenient trailing dot)
 *   "db.fragment"      → objects in db matching fragment (2 segments match
 *                        OBJECTS only)
 *   "db.table.fragment"→ columns of db.table matching fragment (3 segments
 *                        match COLUMNS only; trailing dot lists them all)
 *
 * The first segment must case-insensitively name a KNOWN database,
 * otherwise the whole input falls back to plain unified matching (never a
 * dead end). An unknown TABLE keeps the scope and honestly yields nothing.
 * More than 3 segments, an empty middle segment, or any non-identifier
 * character anywhere also fall back to plain matching.
 */
export type PaletteScope =
  | { kind: "objects"; db: string; query: string }
  | { kind: "columns"; db: string; table: string; query: string };

const IDENT_SEGMENT = /^[\p{L}\p{N}_$]+$/u;

export function parseScopedQuery(
  raw: string,
  knownDbs: readonly string[],
): PaletteScope | null {
  const query = raw.trim();
  if (!query.includes(".")) return null;
  const parts = query.split(".");
  if (parts.length < 2 || parts.length > 3) return null;

  // Every segment must be a simple identifier; only the LAST may be empty
  // (the lenient trailing-dot form).
  const last = parts.length - 1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "") {
      if (i !== last) return null;
    } else if (!IDENT_SEGMENT.test(parts[i])) {
      return null;
    }
  }

  const lowerDb = parts[0].toLowerCase();
  const db = knownDbs.find((d) => d.toLowerCase() === lowerDb);
  if (!db) return null;

  if (parts.length === 2) {
    return { kind: "objects", db, query: parts[1] };
  }
  return { kind: "columns", db, table: parts[1], query: parts[2] };
}

/**
 * Restrict the object/column pools to a parsed scope: canonical-db equality
 * for both kinds (the scope carries the known spelling), plus case-
 * insensitive table equality for column scopes. Recents, sessions, actions
 * and history stay OUT of scoped results by design — tight and predictable.
 */
export function applyScope(
  scope: PaletteScope,
  objects: PaletteObjectItem[],
  columns: PaletteColumnItem[],
): PaletteItem[] {
  if (scope.kind === "objects") {
    return objects.filter((o) => o.db === scope.db);
  }
  const table = scope.table.toLowerCase();
  return columns.filter(
    (c) => c.db === scope.db && c.table.toLowerCase() === table,
  );
}

// ---------------------------------------------------------------------------
// `db:` mode — first token picks databases, rest filters within them
// ---------------------------------------------------------------------------

/**
 * `db:`-mode query grammar: the FIRST whitespace-separated token selects
 * databases (tiered/fuzzy match against db names via {@link scoreText});
 * everything after it filters items WITHIN those dbs through normal
 * scoring. So "shop" lists shop's world, and "shop users" narrows to
 * users-ish rows inside shop. No db matching the token → honest empty
 * result (unlike scoped UNIFIED syntax there is no fallback: the mode was
 * entered explicitly).
 */
export function parseDbModeQuery(query: string): {
  dbToken: string;
  rest: string;
} {
  const trimmed = query.trim();
  const ws = trimmed.search(/\s/);
  if (ws === -1) return { dbToken: trimmed, rest: "" };
  return { dbToken: trimmed.slice(0, ws), rest: trimmed.slice(ws).trim() };
}

/**
 * Selection for `db:` mode over the object + column pools. Empty query →
 * object sections in composition order, NEVER columns (same empty-query
 * rule as unified). Non-empty → items whose db matches the first token,
 * ranked/capped for the remaining filter text.
 */
export function selectDbModeItems(
  objects: PaletteObjectItem[],
  columns: PaletteColumnItem[],
  query: string,
  cap = 50,
): PaletteSelection {
  if (!query.trim()) {
    return {
      items: objects.slice(0, cap),
      omittedCount: Math.max(0, objects.length - cap),
    };
  }

  const { dbToken, rest } = parseDbModeQuery(query);
  const inScope = (db: string): boolean =>
    scoreText(db, dbToken) !== SCORE_NO_MATCH;
  const pool: PaletteItem[] = [
    ...objects.filter((o) => inScope(o.db)),
    ...columns.filter((c) => inScope(c.db)),
  ];
  return selectTop(pool, rest, cap);
}
