import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Braces, Clock, Eye, Play, RefreshCw, Sigma, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { SqlCodeEditor } from "@/components/common/SqlCodeEditor";
import { templateFor } from "@/components/objects/templates";
import { EmptyPlaceholder } from "@/components/layout/EmptyPlaceholder";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { dbKeys, TREE_STALE_TIME } from "@/lib/db-queries";
import {
  executeObjectSql,
  fetchEventDdl,
  fetchRoutineDdl,
  fetchTriggerDdl,
  fetchViewDdl,
  objKeys,
} from "@/lib/object-queries";
import { log } from "@/stores/log";
import { notify } from "@/lib/toast";
import { useConnectionStore } from "@/stores/connection";
import { useTabsStore, type Tab } from "@/stores/tabs";
import { useUiStore } from "@/stores/ui";

/**
 * Unified code editor for views/routines/triggers/events (Phase 4). Loads
 * the SHOW CREATE text, strips DEFINER clauses (noted in the log) and applies
 * via a single raw statement so BEGIN…END bodies survive unsplit.
 */
export function ObjectEditorView({ tab }: { tab: Tab }) {
  const meta = tab.meta as {
    connId?: unknown;
    db?: unknown;
    kind?: unknown;
    name?: unknown;
    routineKind?: unknown;
    mode?: unknown;
  };
  if (
    typeof meta.connId !== "number" ||
    typeof meta.db !== "string" ||
    typeof meta.kind !== "string" ||
    (meta.name !== undefined && typeof meta.name !== "string")
  ) {
    return (
      <EmptyPlaceholder icon={Braces} title="No object selected" />
    );
  }
  const kind = meta.kind as "view" | "routine" | "trigger" | "event";
  const routineKind = meta.routineKind === "function" || meta.routineKind === "procedure"
    ? (meta.routineKind as "function" | "procedure")
    : undefined;

  return (
    <ObjectEditorInner
      key={tab.id}
      tabId={tab.id}
      connId={meta.connId}
      db={meta.db}
      kind={kind}
      name={typeof meta.name === "string" ? meta.name : undefined}
      routineKind={routineKind}
      createMode={meta.mode === "create"}
    />
  );
}

type EditorKind = "view" | "routine" | "trigger" | "event";

const KIND_BADGE: Record<EditorKind, string> = {
  view: "VIEW",
  routine: "ROUTINE",
  trigger: "TRIGGER",
  event: "EVENT",
};

/** Strip `DEFINER=user@host` clauses; they rarely survive re-apply. */
export function stripDefiner(sql: string): string {
  return sql.replace(/\s*DEFINER\s*=\s*`[^`]*`@`[^`]*`/gi, "");
}

function ObjectEditorInner({
  tabId,
  connId,
  db,
  kind,
  name,
  routineKind,
  createMode,
}: {
  tabId: string;
  connId: number;
  db: string;
  kind: EditorKind;
  name?: string;
  routineKind?: "function" | "procedure";
  createMode: boolean;
}) {
  const theme = useUiStore((s) => s.theme);
  const queryClient = useQueryClient();
  const closeTab = useTabsStore((s) => s.closeTab);
  const connName = useConnectionStore((s) => s.session?.name ?? "");
  const dialect = useConnectionStore((s) => s.serverInfo?.dialect ?? "mysql");

  // -- load current definition ----------------------------------------------
  const ddlQuery = useQuery({
    queryKey:
      kind === "routine"
        ? objKeys.routineDdl(connId, db, name ?? "", routineKind ?? "procedure")
        : kind === "trigger"
          ? objKeys.triggerDdl(connId, db, name ?? "")
          : kind === "event"
            ? objKeys.eventDdl(connId, db, name ?? "")
            : objKeys.viewDdl(connId, db, name ?? ""),
    queryFn: () => {
      switch (kind) {
        case "routine":
          return fetchRoutineDdl(connId, db, name!, routineKind ?? "procedure");
        case "trigger":
          return fetchTriggerDdl(connId, db, name!);
        case "event":
          return fetchEventDdl(connId, db, name!);
        case "view":
          return fetchViewDdl(connId, db, name!);
      }
    },
    enabled: !createMode && name !== undefined,
    staleTime: TREE_STALE_TIME,
    retry: false,
  });

  const [sqlText, setSqlText] = useState<string>(() =>
    createMode
      ? templateFor({ db, kind, routineKind })
      : "",
  );
  const [loadedAt, setLoadedAt] = useState<number>(0);
  const definerNoteLogged = useRef(false);

  useEffect(() => {
    if (createMode || !ddlQuery.data || ddlQuery.dataUpdatedAt === loadedAt) return;
    setLoadedAt(ddlQuery.dataUpdatedAt);
    let text = ddlQuery.data.createSql;
    const stripped = stripDefiner(text);
    if (stripped !== text && !definerNoteLogged.current) {
      definerNoteLogged.current = true;
      log("info", `DEFINER clause(s) removed from ${kind} \`${name}\` — apply will run as the current user.`);
    }
    text = stripped;
    setSqlText(`${text.trimEnd()};\n`);
  }, [createMode, ddlQuery.data, ddlQuery.dataUpdatedAt, loadedAt, kind, name]);

  // -- apply ------------------------------------------------------------------
  const [applying, setApplying] = useState(false);

  /** Extract leading statement keyword for logging / tree refresh decisions. */
  const statementKind = useMemo(() => sqlText.trim().slice(0, 12).toUpperCase(), [sqlText]);

  const apply = async () => {
    if (!sqlText.trim()) return;
    setApplying(true);
    try {
      await executeObjectSql(connId, sqlText);
      notify.success(`${kind} ${name ?? ""} applied on \`${db}\`.`);
      void queryClient.invalidateQueries({ queryKey: dbKeys.tables(connId, db) });
      if (/CREATE|ALTER/.test(statementKind)) {
        void queryClient.invalidateQueries({ queryKey: ["obj", connId] });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify.error(`${kind} apply failed: ${message}`);
    } finally {
      setApplying(false);
    }
  };

  const reload = async () => {
    if (createMode) return;
    await ddlQuery.refetch();
  };

  const KindIcon =
    kind === "view" ? Eye :
    kind === "trigger" ? Zap :
    kind === "event" ? Clock :
    routineKind === "function" ? Sigma : Braces;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b bg-muted/40 px-1">
        <Badge variant="secondary" className="gap-1 text-[10px] uppercase">
          <KindIcon className="size-3" />
          {routineKind ?? KIND_BADGE[kind]}
        </Badge>
        <span className="font-mono text-xs font-medium">{createMode ? `new_${kind}` : name}</span>
        <span className="text-xs text-muted-foreground">in</span>
        <Badge variant="outline" className="font-mono text-xs">{db}</Badge>

        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="xs" disabled={applying || !sqlText.trim()} onClick={() => void apply()}>
                {applying ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Play data-icon="inline-start" />
                )}
                Apply
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run this SQL as one raw statement</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={() => void reload()} aria-label="Reload">
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Discard changes and reload</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={() => closeTab(tabId)} aria-label="Close">
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* editor */}
      {ddlQuery.isError && !createMode ? (
        <EmptyPlaceholder icon={KindIcon} title="Could not load object" hint={(ddlQuery.error as Error)?.message} />
      ) : ddlQuery.isPending && !createMode ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-muted-foreground">Loading definition…</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <SqlCodeEditor
            value={sqlText}
            onChange={(v) => setSqlText(v)}
            theme={theme}
            dialect={dialect}
            placeholder={`${KIND_BADGE[kind]} definition SQL…`}
          />
        </div>
      )}

      {/* footer hint */}
      <div className="flex h-6 shrink-0 items-center border-t bg-muted/30 px-2 text-[10px] text-muted-foreground">
        Apply sends the whole buffer to the server as a single statement — safe for
        procedure/function bodies containing semicolons. Session: {connName}
      </div>
    </div>
  );
}
