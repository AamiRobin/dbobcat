import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Activity,
  Cable,
  Download,
  Eye,
  FileCode,
  FileUp,
  Info,
  Keyboard,
  PlugZap,
  RefreshCw,
  Server,
  SlidersHorizontal,
  SunMoon,
  Table,
  TextSearch,
  Unplug,
  Users,
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
  buildActionItems,
  buildObjectItems,
  buildSessionItems,
  parseMode,
  selectTop,
  type PaletteActionContext,
  type PaletteActionItem,
  type PaletteItem,
  type PaletteMode,
  type PaletteObjectItem,
  type PaletteSessionItem,
} from "@/lib/palette-items";
import { formatCombo } from "@/lib/shortcuts";
import { useConnectionStore } from "@/stores/connection";
import { usePaletteStore } from "@/stores/palette";
import { openDataTable, openDesignerTab, openObjectEditorTab } from "@/stores/tabs";
import type { SavedSession, SqlDialect, TableMeta } from "@/types/ipc";

/**
 * Command palette (palette Phase 1). Mounted once at the app root inside
 * Suspense; visibility lives in `usePaletteStore` so Mod+K / Mod+Shift+P
 * and the toolbar button share one entry path.
 *
 * Filtering is OURS (`shouldFilter={false}`): rows are ranked by
 * `selectTop` and grouped into fixed sections — Commands / Sessions /
 * Tables / Views. Tab cycles unified → commands → sessions preserving the
 * query text; Shift+Enter triggers the alternate activation on objects
 * (table → designer, view → data grid); Backspace on an empty mode query
 * exits back to unified.
 */

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
}: PaletteBodyProps) {
  const parsed = useMemo(() => parseMode(raw), [raw]);

  // Object scope (v1): databases + a fan-out of table lists per database,
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

  const actionCtx = useMemo<PaletteActionContext>(
    () => ({ connected, connId, dialect }),
    [connected, connId, dialect],
  );
  const actions = useMemo(() => buildActionItems(actionCtx), [actionCtx]);
  const sessionItems = useMemo(() => buildSessionItems(sessions), [sessions]);
  const objectItems = useMemo(
    () => (connected ? buildObjectItems(dbs, tablesByDb) : []),
    [connected, dbs, tablesByDb],
  );

  // Pool per mode, in section order (Commands / Sessions / Tables+Views) —
  // an empty query therefore truncates by section via selectTop.
  const pool = useMemo<PaletteItem[]>(() => {
    if (parsed.mode === "commands") return actions;
    if (parsed.mode === "sessions") return sessionItems;
    return [...actions, ...sessionItems, ...objectItems];
  }, [parsed.mode, actions, sessionItems, objectItems]);

  const selection = useMemo(
    () => selectTop(pool, parsed.query),
    [pool, parsed.query],
  );

  const topActions: PaletteActionItem[] = [];
  const topSessions: PaletteSessionItem[] = [];
  const topTables: PaletteObjectItem[] = [];
  const topViews: PaletteObjectItem[] = [];
  for (const item of selection.items) {
    if (item.type === "action") topActions.push(item);
    else if (item.type === "session") topSessions.push(item);
    else if (item.kind === "table") topTables.push(item);
    else topViews.push(item);
  }

  const objectsLoading =
    connected && (databasesQuery.isPending || tablesQueries.some((q) => q.isPending));
  const rowCount =
    topActions.length +
    topSessions.length +
    topTables.length +
    topViews.length +
    (objectsLoading ? 1 : 0);

  /** Enter/click activation; closes first so dialogs stack cleanly. */
  const runPrimary = useCallback(
    (item: PaletteActionItem | PaletteSessionItem | PaletteObjectItem) => {
      close();
      if (item.type === "action") {
        void Promise.resolve(item.run());
      } else if (item.type === "session") {
        void item.connect();
      } else if (connId !== null) {
        if (item.kind === "table") openDataTable(connId, item.db, item.name);
        else openObjectEditorTab({ connId, db: item.db, kind: "view", name: item.name });
      }
    },
    [close, connId],
  );

  /** Shift+Enter alternate activation for object rows. */
  const runAlternate = useCallback(
    (item: PaletteObjectItem) => {
      if (connId === null) return;
      close();
      if (item.kind === "table") openDesignerTab(connId, item.db, item.name);
      else openDataTable(connId, item.db, item.name); // data preview for views
    },
    [close, connId],
  );

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const order: PaletteMode[] = ["unified", "commands", "sessions"];
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
            : t("palette.placeholder")
        }
        onKeyDown={handleInputKeyDown}
      />
      <CommandList>
        {!connected && parsed.mode !== "sessions" && (
          <p className="px-3 py-2 text-[11px] leading-snug text-muted-foreground">
            {t("palette.notConnectedHint")}
          </p>
        )}

        {rowCount === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t("palette.noResults")}
          </div>
        )}

        {topActions.length > 0 && (
          <CommandGroup heading={t("palette.section.commands")}>
            {topActions.map((a) => {
              const Icon = ACTION_ICONS[a.icon] ?? FileCode;
              return (
                <CommandItem
                  key={a.id}
                  value={`action:${a.id}`}
                  onSelect={() => runPrimary(a)}
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{t(a.labelKey)}</span>
                  {a.kbd && <CommandShortcut>{formatCombo(a.kbd)}</CommandShortcut>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {topSessions.length > 0 && (
          <CommandGroup heading={t("palette.section.sessions")}>
            {topSessions.map((s) => (
              <CommandItem
                key={s.id}
                value={`session:${s.id}`}
                onSelect={() => runPrimary(s)}
              >
                {s.color ? (
                  // Decorative only — the group text below carries the info.
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full border border-black/10"
                    style={{ backgroundColor: s.color }}
                  />
                ) : (
                  <Server className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-medium">{s.name}</span>
                {s.group && (
                  <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground">
                    {s.group}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {(topTables.length > 0 || objectsLoading) && parsed.mode !== "sessions" && (
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
              <ObjectRow
                key={o.id}
                item={o}
                icon={<Table className="size-3.5 shrink-0 text-warning" />}
                onSelect={() => runPrimary(o)}
                onAlternate={() => runAlternate(o)}
              />
            ))}
          </CommandGroup>
        )}

        {topViews.length > 0 && parsed.mode !== "sessions" && (
          <CommandGroup heading={t("palette.section.views")}>
            {topViews.map((o) => (
              <ObjectRow
                key={o.id}
                item={o}
                icon={<Eye className="size-3.5 shrink-0 text-icon-blue" />}
                onSelect={() => runPrimary(o)}
                onAlternate={() => runAlternate(o)}
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

function ObjectRow({
  item,
  icon,
  onSelect,
  onAlternate,
}: {
  item: PaletteObjectItem;
  icon: React.ReactNode;
  onSelect: () => void;
  onAlternate: () => void;
}) {
  return (
    <CommandItem
      value={item.id}
      onSelect={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.shiftKey) {
          // Alternate activation before cmdk's own Enter handling runs.
          e.preventDefault();
          e.stopPropagation();
          onAlternate();
        }
      }}
    >
      {icon}
      <span className="truncate">{item.name}</span>
      <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground">
        {item.db}
      </span>
    </CommandItem>
  );
}
