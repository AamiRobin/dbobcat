import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Activity,
  Braces,
  Cable,
  Clock,
  Download,
  Eye,
  FileCode,
  FileText,
  FileUp,
  Info,
  Keyboard,
  PlugZap,
  RefreshCw,
  Server,
  Sigma,
  SlidersHorizontal,
  SunMoon,
  Table,
  TextSearch,
  Unplug,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Command, CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import {
  TREE_STALE_TIME,
  dbKeys,
  fetchDatabases,
  fetchTables,
} from "@/lib/db-queries";
import {
  OBJECT_STALE_TIME,
  fetchEvents,
  fetchRoutines,
  fetchTriggers,
  objKeys,
} from "@/lib/object-queries";
import { filterResolved, recentIdentity, usePaletteRecents } from "@/lib/palette-recents";
import {
  HISTORY_STALE_TIME,
  fetchHistory,
  formatRelativeTime,
  historyKeys,
  snippet,
} from "@/lib/query-queries";
import {
  buildActionItems,
  buildHistoryItems,
  buildObjectItems,
  buildRecentItems,
  buildSessionItems,
  parseMode,
  selectTop,
  sliceRecentHistory,
  type PaletteActionContext,
  type PaletteActionItem,
  type PaletteHistoryItem,
  type PaletteItem,
  type PaletteMode,
  type PaletteObjectItem,
  type PaletteSessionItem,
} from "@/lib/palette-items";
import { formatCombo } from "@/lib/shortcuts";
import { notify } from "@/lib/toast";
import { useConnectionStore } from "@/stores/connection";
import { usePaletteStore } from "@/stores/palette";
import { openQueryTabWithSql } from "@/stores/query-editor";
import { openDataTable, openDesignerTab, openObjectEditorTab } from "@/stores/tabs";
import { useUiStore } from "@/stores/ui";
import type {
  EventMeta,
  HistoryEntry,
  RoutineMeta,
  SavedSession,
  SqlDialect,
  TableMeta,
  TriggerMeta,
} from "@/types/ipc";

/**
 * Command palette (palette Phase 2). Mounted once at the app root inside
 * Suspense; visibility lives in `usePaletteStore` so Mod+K / Mod+Shift+P
 * and the toolbar button share one entry path.
 *
 * Filtering is OURS (`shouldFilter={false}`): rows are ranked by
 * `selectTop` and grouped into fixed sections — Recents / Tables / Views /
 * Routines / Triggers / Events / Sessions / Commands / Query history.
 * Tab cycles unified → commands → sessions → history preserving the query
 * text; Shift+Enter triggers the alternate activation (table → designer,
 * view → data grid, history → copy SQL, session → manager preselected);
 * Backspace on an empty mode query exits back to unified.
 *
 * Object scope mirrors the DB tree: databases + table lists load first,
 * and once every table list has landed the second wave fans out for
 * routines/triggers/events through the SAME objKeys the lazy tree groups
 * use (staleTime ∞, so repeat opens after the tree loaded cost nothing).
 * Engine gating follows DbTree exactly: no routines on SQLite, no events
 * outside MySQL; triggers exist everywhere.
 */

/** Unified-mode QUERY HISTORY slice size (after recents/objects/sessions/actions). */
const HISTORY_SLICE = 8;

const ACTION_ICONS: Record<string, LucideIcon> = {
  "file-code": FileCode,
  cable: Cable,
  "plug-zap": PlugZap,
  unplug: Unplug,
  "refresh-cw": RefreshCw,
  "sun-moon": SunMoon,
  users: Users,
  activity: Activity,
  "sliders-horizontal": SlidersHorizontal,
  download: Download,
  "file-up": FileUp,
  "text-search": TextSearch,
  keyboard: Keyboard,
  info: Info,
};

function prefixFor(mode: PaletteMode): string {
  if (mode === "commands") return "> ";
  if (mode === "sessions") return "@ ";
  if (mode === "history") return "# ";
  return "";
}

export function CommandPalette() {
  const open = usePaletteStore((s) => s.open);
  const initialMode = usePaletteStore((s) => s.initialMode);
  const setOpen = usePaletteStore((s) => s.setOpen);

  const status = useConnectionStore((s) => s.status);
  const connId = useConnectionStore((s) => s.connId);
  const dialect = useConnectionStore((s) => s.serverInfo?.dialect ?? null);
  const connected = status === "connected" && connId !== null;

  const [raw, setRaw] = useState("");
  /** Element focused before the palette opened — restored on close. */
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Seed the input per opening mode; clear it again on close so reopening
  // starts fresh even though the component stays mounted forever.
  useEffect(() => {
    if (open) {
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setRaw(prefixFor(initialMode));
    } else {
      setRaw("");
    }
  }, [open, initialMode]);

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => restoreFocusRef.current?.focus());
  }, [setOpen]);

  // Saved sessions — SAME cache key as SessionManagerDialog so both
  // surfaces share one fetch.
  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: () => ipc<SavedSession[]>("session_list"),
    enabled: open,
  });

  // Persisted query history — SAME cache key as QueryHistoryMenu; the
  // backend caps + dedupes at 500 entries.
  const historyQuery = useQuery({
    queryKey: historyKeys.all,
    queryFn: fetchHistory,
    staleTime: HISTORY_STALE_TIME,
    enabled: open,
  });

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={t("palette.title")}
      description={t("palette.description")}
      className="sm:max-w-xl"
    >
      <PaletteBody
        open={open}
        raw={raw}
        setRaw={setRaw}
        close={close}
        connected={connected}
        connId={connId}
        dialect={dialect}
        sessions={sessionsQuery.data ?? []}
        historyEntries={historyQuery.data ?? []}
        historyLoading={historyQuery.isPending}
      />
    </CommandDialog>
  );
}

interface PaletteBodyProps {
  open: boolean;
  raw: string;
  setRaw: (value: string) => void;
  close: () => void;
  connected: boolean;
  connId: number | null;
  dialect: SqlDialect | null;
  sessions: SavedSession[];
  historyEntries: HistoryEntry[];
  historyLoading: boolean;
}

function PaletteBody({
  open,
  raw,
  setRaw,
  close,
  connected,
  connId,
  dialect,
  sessions,
  historyEntries,
  historyLoading,
}: PaletteBodyProps) {
  const parsed = useMemo(() => parseMode(raw), [raw]);

  const sessionId = useConnectionStore((s) => s.session?.sessionId ?? null);
  const { recents, recordRecent } = usePaletteRecents(sessionId);

  // Object scope: databases + a fan-out of table lists per database,
  // through the SAME dbKeys the tree uses — staleTime is Infinity there, so
  // repeat opens after the tree has loaded cost nothing.
  const databasesQuery = useQuery({
    queryKey: dbKeys.databases(connId ?? -1),
    queryFn: () => fetchDatabases(connId as number),
    enabled: open && connected && connId !== null,
    staleTime: TREE_STALE_TIME,
  });
  const dbs = useMemo(() => databasesQuery.data ?? [], [databasesQuery.data]);

  const tablesQueries = useQueries({
    queries: dbs.map((d) => ({
      queryKey: dbKeys.tables(connId as number, d.name),
      queryFn: () => fetchTables(connId as number, d.name),
      enabled: open && connected,
      staleTime: TREE_STALE_TIME,
    })),
  });

  const tablesByDb = useMemo(() => {
    const map: Record<string, TableMeta[] | undefined> = {};
    dbs.forEach((d, i) => {
      map[d.name] = tablesQueries[i]?.data;
    });
    return map;
  }, [dbs, tablesQueries]);

  // Second-wave fan-out: routines/triggers/events per database. It waits
  // for the first paint of tables (perf guard — keeps the initial burst
  // bounded), then runs through the SAME objKeys the lazy tree groups use,
  // so anything the tree already loaded is served from cache for free.
  // Engine gating mirrors DbTree's group-hiding rules exactly.
  const secondWaveReady =
    connected && !databasesQuery.isPending && !tablesQueries.some((q) => q.isPending);
  const showRoutines = dialect !== null && dialect !== "sqlite";
  const showEvents = dialect === "mysql";

  const routineQueries = useQueries({
    queries: dbs.map((d) => ({
      queryKey: objKeys.routines(connId as number, d.name),
      queryFn: () => fetchRoutines(connId as number, d.name),
      enabled: secondWaveReady && showRoutines,
      staleTime: OBJECT_STALE_TIME,
    })),
  });
  const triggerQueries = useQueries({
    queries: dbs.map((d) => ({
      queryKey: objKeys.triggers(connId as number, d.name),
      queryFn: () => fetchTriggers(connId as number, d.name),
      enabled: secondWaveReady,
      staleTime: OBJECT_STALE_TIME,
    })),
  });
  const eventQueries = useQueries({
    queries: dbs.map((d) => ({
      queryKey: objKeys.events(connId as number, d.name),
      queryFn: () => fetchEvents(connId as number, d.name),
      enabled: secondWaveReady && showEvents,
      staleTime: OBJECT_STALE_TIME,
    })),
  });

  const routinesByDb = useMemo(() => {
    const map: Record<string, RoutineMeta[] | undefined> = {};
    dbs.forEach((d, i) => {
      map[d.name] = routineQueries[i]?.data;
    });
    return map;
  }, [dbs, routineQueries]);
  const triggersByDb = useMemo(() => {
    const map: Record<string, TriggerMeta[] | undefined> = {};
    dbs.forEach((d, i) => {
      map[d.name] = triggerQueries[i]?.data;
    });
    return map;
  }, [dbs, triggerQueries]);
  const eventsByDb = useMemo(() => {
    const map: Record<string, EventMeta[] | undefined> = {};
    dbs.forEach((d, i) => {
      map[d.name] = eventQueries[i]?.data;
    });
    return map;
  }, [dbs, eventQueries]);

  const actionCtx = useMemo<PaletteActionContext>(
    () => ({ connected, connId, dialect }),
    [connected, connId, dialect],
  );
  const actions = useMemo(() => buildActionItems(actionCtx), [actionCtx]);
  const sessionItems = useMemo(() => buildSessionItems(sessions), [sessions]);
  const objectItems = useMemo(
    () =>
      connected
        ? buildObjectItems(dbs, tablesByDb, routinesByDb, triggersByDb, eventsByDb)
        : [],
    [connected, dbs, tablesByDb, routinesByDb, triggersByDb, eventsByDb],
  );

  // Resolve recents against the CURRENT pools: descriptors whose object no
  // longer exists are silently dropped (and pruned on the next write).
  const resolvedRecents = useMemo(() => {
    const known = new Set(objectItems.map(recentIdentity));
    return filterResolved(recents, known);
  }, [recents, objectItems]);
  const recentItems = useMemo(() => buildRecentItems(resolvedRecents), [resolvedRecents]);

  const historyItems = useMemo(() => buildHistoryItems(historyEntries), [historyEntries]);
  const unifiedHistory = useMemo(
    () => buildHistoryItems(sliceRecentHistory(historyEntries, HISTORY_SLICE)),
    [historyEntries],
  );

  // Pool per mode, in section order (Recents / Tables+… / Sessions /
  // Commands / History) — an empty query therefore truncates by section via
  // selectTop.
  const pool = useMemo<PaletteItem[]>(() => {
    if (parsed.mode === "commands") return actions;
    if (parsed.mode === "sessions") return sessionItems;
    if (parsed.mode === "history") return historyItems;
    return [
      ...recentItems,
      ...objectItems,
      ...sessionItems,
      ...actions,
      ...unifiedHistory,
    ];
  }, [parsed.mode, actions, sessionItems, historyItems, recentItems, objectItems, unifiedHistory]);

  const selection = useMemo(
    () => selectTop(pool, parsed.query),
    [pool, parsed.query],
  );

  const topActions: PaletteActionItem[] = [];
  const topSessions: PaletteSessionItem[] = [];
  const topRecents: PaletteObjectItem[] = [];
  const topTables: PaletteObjectItem[] = [];
  const topViews: PaletteObjectItem[] = [];
  const topRoutines: PaletteObjectItem[] = [];
  const topTriggers: PaletteObjectItem[] = [];
  const topEvents: PaletteObjectItem[] = [];
  const topHistory: PaletteHistoryItem[] = [];
  for (const item of selection.items) {
    if (item.type === "action") topActions.push(item);
    else if (item.type === "session") topSessions.push(item);
    else if (item.type === "history") topHistory.push(item);
    else if (item.lastOpenedAt) topRecents.push(item);
    else if (item.kind === "table") topTables.push(item);
    else if (item.kind === "view") topViews.push(item);
    else if (item.kind === "routine") topRoutines.push(item);
    else if (item.kind === "trigger") topTriggers.push(item);
    else topEvents.push(item);
  }

  const objectsLoading =
    connected && (databasesQuery.isPending || tablesQueries.some((q) => q.isPending));
  // Skeleton rows for second-wave groups while their lists are in flight
  // (disabled queries stay isPending forever, hence the dialect guards).
  const routinesLoading =
    connected && showRoutines && secondWaveReady && routineQueries.some((q) => q.isPending);
  const triggersLoading =
    connected && secondWaveReady && triggerQueries.some((q) => q.isPending);
  const eventsLoading =
    connected && showEvents && secondWaveReady && eventQueries.some((q) => q.isPending);

  // Object sections only exist in unified mode; in sessions/commands/history
  // modes their pools are disjoint and loading skeletons must not leak in.
  const showObjectSections = parsed.mode === "unified";

  const rowCount =
    topActions.length +
    topSessions.length +
    topRecents.length +
    topTables.length +
    topViews.length +
    topRoutines.length +
    topTriggers.length +
    topEvents.length +
    topHistory.length +
    (objectsLoading ? 1 : 0);

  /** Enter/click activation; closes first so dialogs stack cleanly. */
  const runPrimary = useCallback(
    (item: PaletteItem) => {
      close();
      if (item.type === "action") {
        void Promise.resolve(item.run());
      } else if (item.type === "session") {
        void item.connect();
      } else if (item.type === "history") {
        // Open a NEW query tab pre-filled with the script.
        openQueryTabWithSql(item.sql);
      } else if (connId !== null) {
        recordRecent(item);
        switch (item.kind) {
          case "table":
            openDataTable(connId, item.db, item.name);
            break;
          case "view":
            openObjectEditorTab({ connId, db: item.db, kind: "view", name: item.name });
            break;
          case "routine":
            openObjectEditorTab({
              connId,
              db: item.db,
              kind: "routine",
              name: item.name,
              routineKind: item.routineKind ?? "procedure",
            });
            break;
          case "trigger":
            openObjectEditorTab({ connId, db: item.db, kind: "trigger", name: item.name });
            break;
          case "event":
            openObjectEditorTab({ connId, db: item.db, kind: "event", name: item.name });
            break;
        }
      }
    },
    [close, connId, recordRecent],
  );

  /** Shift+Enter alternate activation. */
  const runAlternate = useCallback(
    (item: PaletteItem) => {
      if (item.type === "object") {
        if (connId === null) return;
        close();
        recordRecent(item);
        if (item.kind === "table") {
          openDesignerTab(connId, item.db, item.name);
        } else if (item.kind === "view") {
          openDataTable(connId, item.db, item.name); // data preview for views
        }
        // routine/trigger/event: no alternate this phase (Phase 1 decision).
        return;
      }
      if (item.type === "history") {
        close();
        void navigator.clipboard.writeText(item.sql);
        notify.success(t("palette.copySql"));
        return;
      }
      if (item.type === "session") {
        close();
        useUiStore.getState().setSessionManagerOpen(true, item.id);
        return;
      }
      // action: no alternate.
    },
    [close, connId, recordRecent],
  );

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const order: PaletteMode[] = ["unified", "commands", "sessions", "history"];
      const idx = order.indexOf(parsed.mode);
      const next = e.shiftKey
        ? order[(idx - 1 + order.length) % order.length]
        : order[(idx + 1) % order.length];
      // Preserve the query text across the switch.
      setRaw(prefixFor(next) + parsed.query);
      return;
    }
    // Backspace on an empty-after-prefix input exits back to unified.
    if (
      e.key === "Backspace" &&
      parsed.mode !== "unified" &&
      parsed.query === ""
    ) {
      e.preventDefault();
      setRaw("");
    }
  };

  return (
    <Command shouldFilter={false} className="min-h-0">
      <CommandInput
        value={raw}
        onValueChange={setRaw}
        placeholder={
          parsed.mode === "commands"
            ? t("palette.placeholderCommands")
            : parsed.mode === "history"
              ? t("palette.placeholderHistory")
              : t("palette.placeholder")
        }
        onKeyDown={handleInputKeyDown}
      />
      <CommandList>
        {!connected && parsed.mode !== "sessions" && parsed.mode !== "history" && (
          <p className="px-3 py-2 text-[11px] leading-snug text-muted-foreground">
            {t("palette.notConnectedHint")}
          </p>
        )}

        {rowCount === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t("palette.noResults")}
          </div>
        )}

        {topRecents.length > 0 && showObjectSections && (
          <CommandGroup heading={t("palette.section.recents")}>
            {topRecents.map((o) => (
              <PaletteRow
                key={o.id}
                value={o.id}
                icon={<ObjectIcon item={o} />}
                label={o.name}
                onSelect={() => runPrimary(o)}
                onAlternate={() => runAlternate(o)}
                meta={
                  <>
                    {o.db}
                    {o.lastOpenedAt && ` · ${formatRelativeTime(o.lastOpenedAt)}`}
                  </>
                }
              />
            ))}
          </CommandGroup>
        )}

        {(topTables.length > 0 || objectsLoading) && showObjectSections && (
          <CommandGroup heading={t("palette.section.tables")}>
            {objectsLoading &&
              topTables.length === 0 &&
              [0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <Skeleton className="size-3.5 rounded-sm" />
                  <Skeleton className="h-3 w-32" />
                </div>
              ))}
            {topTables.map((o) => (
              <PaletteRow
                key={o.id}
                value={o.id}
                icon={<ObjectIcon item={o} />}
                label={o.name}
                onSelect={() => runPrimary(o)}
                onAlternate={() => runAlternate(o)}
                meta={o.db}
              />
            ))}
          </CommandGroup>
        )}

        {topViews.length > 0 && showObjectSections && (
          <CommandGroup heading={t("palette.section.views")}>
            {topViews.map((o) => (
              <PaletteRow
                key={o.id}
                value={o.id}
                icon={<ObjectIcon item={o} />}
                label={o.name}
                onSelect={() => runPrimary(o)}
                onAlternate={() => runAlternate(o)}
                meta={o.db}
              />
            ))}
          </CommandGroup>
        )}

        {(topRoutines.length > 0 || routinesLoading) && showObjectSections && (
          <CommandGroup heading={t("palette.section.routines")}>
            {routinesLoading &&
              topRoutines.length === 0 &&
              [0, 1].map((i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <Skeleton className="size-3.5 rounded-sm" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))}
            {topRoutines.map((o) => (
              <PaletteRow
                key={o.id}
                value={o.id}
                icon={<ObjectIcon item={o} />}
                label={o.name}
                onSelect={() => runPrimary(o)}
                meta={o.db}
              />
            ))}
          </CommandGroup>
        )}

        {(topTriggers.length > 0 || triggersLoading) && showObjectSections && (
          <CommandGroup heading={t("palette.section.triggers")}>
            {triggersLoading &&
              topTriggers.length === 0 &&
              [0, 1].map((i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <Skeleton className="size-3.5 rounded-sm" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))}
            {topTriggers.map((o) => (
              <PaletteRow
                key={o.id}
                value={o.id}
                icon={<ObjectIcon item={o} />}
                label={o.name}
                onSelect={() => runPrimary(o)}
                meta={o.db}
              />
            ))}
          </CommandGroup>
        )}

        {(topEvents.length > 0 || eventsLoading) && showObjectSections && (
          <CommandGroup heading={t("palette.section.events")}>
            {eventsLoading &&
              topEvents.length === 0 &&
              [0, 1].map((i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <Skeleton className="size-3.5 rounded-sm" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))}
            {topEvents.map((o) => (
              <PaletteRow
                key={o.id}
                value={o.id}
                icon={<ObjectIcon item={o} />}
                label={o.name}
                onSelect={() => runPrimary(o)}
                meta={o.db}
              />
            ))}
          </CommandGroup>
        )}

        {topSessions.length > 0 && (
          <CommandGroup heading={t("palette.section.sessions")}>
            {topSessions.map((s) => (
              <PaletteRow
                key={s.id}
                value={`session:${s.id}`}
                icon={
                  s.color ? (
                    // Decorative only — the group text below carries the info.
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full border border-black/10"
                      style={{ backgroundColor: s.color }}
                    />
                  ) : (
                    <Server className="size-3.5 shrink-0 text-muted-foreground" />
                  )
                }
                label={s.name}
                labelClassName="font-medium"
                onSelect={() => runPrimary(s)}
                onAlternate={() => runAlternate(s)}
                meta={s.group ?? undefined}
              />
            ))}
          </CommandGroup>
        )}

        {topActions.length > 0 && (
          <CommandGroup heading={t("palette.section.commands")}>
            {topActions.map((a) => {
              const Icon = ACTION_ICONS[a.icon] ?? FileCode;
              return (
                <PaletteRow
                  key={a.id}
                  value={`action:${a.id}`}
                  icon={<Icon className="size-3.5 shrink-0 text-muted-foreground" />}
                  label={t(a.labelKey)}
                  onSelect={() => runPrimary(a)}
                >
                  {a.kbd && <CommandShortcut>{formatCombo(a.kbd)}</CommandShortcut>}
                </PaletteRow>
              );
            })}
          </CommandGroup>
        )}

        {(topHistory.length > 0 || (historyLoading && parsed.mode === "history")) && (
          <CommandGroup heading={t("palette.section.history")}>
            {historyLoading &&
              topHistory.length === 0 &&
              [0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <Skeleton className="size-3.5 rounded-sm" />
                  <Skeleton className="h-3 w-40" />
                </div>
              ))}
            {topHistory.map((h) => (
              <PaletteRow
                key={h.id}
                value={h.id}
                icon={<FileText className="size-3.5 shrink-0 text-muted-foreground" />}
                label={snippet(h.sql)}
                onSelect={() => runPrimary(h)}
                onAlternate={() => runAlternate(h)}
                meta={`${h.connName || "—"} · ${formatRelativeTime(h.executedAt)}`}
              />
            ))}
          </CommandGroup>
        )}

        {selection.omittedCount > 0 && (
          <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
            {t("palette.refine", { count: selection.omittedCount })}
          </p>
        )}
      </CommandList>

      {/* Mode / key hints */}
      <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        {t("palette.hints")}
      </div>
    </Command>
  );
}

/** Lucide icon + color per object kind, mirroring DbTree's leaf classes. */
function ObjectIcon({ item }: { item: PaletteObjectItem }) {
  switch (item.kind) {
    case "table":
      return <Table className="size-3.5 shrink-0 text-warning" />;
    case "view":
      return <Eye className="size-3.5 shrink-0 text-icon-blue" />;
    case "routine": {
      const Icon = item.routineKind === "function" ? Sigma : Braces;
      return <Icon className="size-3.5 shrink-0 text-icon-violet/80" />;
    }
    case "trigger":
      return <Zap className="size-3.5 shrink-0 text-warning/80" />;
    case "event":
      return <Clock className="size-3.5 shrink-0 text-icon-teal/80" />;
  }
}

function PaletteRow({
  value,
  icon,
  label,
  labelClassName,
  meta,
  onSelect,
  onAlternate,
  children,
}: {
  value: string;
  icon: React.ReactNode;
  label: string;
  labelClassName?: string;
  /** Muted right-aligned detail (db, connection · time, kbd group…). */
  meta?: React.ReactNode;
  onSelect: () => void;
  onAlternate?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <CommandItem
      value={value}
      onSelect={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.shiftKey && onAlternate) {
          // Alternate activation before cmdk's own Enter handling runs.
          e.preventDefault();
          e.stopPropagation();
          onAlternate();
        }
      }}
    >
      {icon}
      <span className={labelClassName ? `truncate ${labelClassName}` : "truncate"}>
        {label}
      </span>
      {children}
      {meta !== undefined && (
        <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground">
          {meta}
        </span>
      )}
    </CommandItem>
  );
}
