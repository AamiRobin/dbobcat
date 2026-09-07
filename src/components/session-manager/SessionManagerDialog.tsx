import { useEffect, useMemo, useState, type DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  FileDown,
  FileUp,
  Folder,
  PlugZap,
  Plus,
  Save,
  Server,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ipc } from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { notify } from "@/lib/toast";
import { buildSessionTree, existingGroupPaths, parseGroupPath, sessionColor, type SessionGroupNode } from "@/lib/session-groups";
import { pickOpenPath, pickSavePath } from "@/lib/export-queries";
import { useConnectionStore } from "@/stores/connection";
import type {
  SavedSession,
  SettingsExportSummary,
  SettingsImportSummary,
  TestResult,
} from "@/types/ipc";

import { SessionForm } from "./SessionForm";
import {
  draftFromSession,
  draftToSession,
  newDraft,
  secretsForWire,
  validateDraft,
  type DraftSecrets,
  type SessionDraft,
} from "./session-draft";

interface SessionManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Session row to select when the dialog is opened externally (command
   * palette Shift+Enter). Applied once the session list has loaded; a
   * no-op when the row no longer exists.
   */
  initialSelectedId?: string | null;
}

/** Wire args for `session_save` / `session_test`. */
type SavePayload = {
  session: SavedSession;
  password?: string;
  sshPassword?: string;
};

/** DnD payload marker so only session-row drags can trigger a regroup. */
const SESSION_DRAG_MIME = "application/x-dbobcat-session";

/**
 * Shared dragover/drop wiring for tree drop targets; `newGroup` "" is the
 * root. Guarded on the session MIME so table/OS drags never activate it.
 */
function sessionDropHandlers(
  onRegroup: (id: string, newGroup: string) => void,
  newGroup: string,
  setOver: (over: boolean) => void,
) {
  return {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(SESSION_DRAG_MIME)) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(SESSION_DRAG_MIME)) return;
      e.preventDefault();
      setOver(false);
      const id = e.dataTransfer.getData(SESSION_DRAG_MIME);
      if (id) onRegroup(id, newGroup);
    },
  };
}

/** Collapsible grouped tree of sessions (Phase 9-B). */
function SessionTreeList({
  root,
  selectedId,
  onSelect,
  onRegroup,
  collapsed,
  toggleCollapsed,
}: {
  root: SessionGroupNode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRegroup: (id: string, newGroup: string) => void;
  collapsed: Set<string>;
  toggleCollapsed: (path: string) => void;
}) {
  const [rootOver, setRootOver] = useState(false);
  return (
    <div className="flex flex-col gap-0.5">
      {/* Root node: "All sessions" — selects the unsaved new-draft state.
          Dropping a session row here moves it out of any group. */}
      <button
        type="button"
        onClick={() => onSelect(null)}
        {...sessionDropHandlers(onRegroup, "", setRootOver)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
          selectedId === null
            ? "bg-accent text-accent-foreground"
            : "hover:bg-accent",
          rootOver && "ring-1 ring-primary/40 bg-primary/5",
        )}
      >
        <Server className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{t("session.all")}</span>
        <span className="ml-auto tabular-nums text-[10px] text-muted-foreground">
          {countSessions(root)}
        </span>
      </button>

      {root.groups.map((group) => (
        <GroupNode
          key={group.path}
          group={group}
          depth={0}
          selectedId={selectedId}
          onSelect={onSelect}
          onRegroup={onRegroup}
          collapsed={collapsed}
          toggleCollapsed={toggleCollapsed}
        />
      ))}

      {root.sessions.map((session) => (
        <SessionRow key={session.id} session={session} selected={selectedId === session.id} onSelect={onSelect} />
      ))}
    </div>
  );
}

function countSessions(node: SessionGroupNode): number {
  return (
    node.sessions.length + node.groups.reduce((sum, g) => sum + countSessions(g), 0)
  );
}

function GroupNode({
  group,
  depth,
  selectedId,
  onSelect,
  onRegroup,
  collapsed,
  toggleCollapsed,
}: {
  group: SessionGroupNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRegroup: (id: string, newGroup: string) => void;
  collapsed: Set<string>;
  toggleCollapsed: (path: string) => void;
}) {
  const open = !collapsed.has(group.path);
  const [over, setOver] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => toggleCollapsed(group.path)}
        {...sessionDropHandlers(onRegroup, group.path, setOver)}
        className={cn(
          "flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-xs hover:bg-accent",
          over && "ring-1 ring-primary/40 bg-primary/5",
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        aria-expanded={open}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Folder className="size-3.5 shrink-0 text-warning" />
        <span className="truncate font-medium">{group.name}</span>
        <span className="ml-auto pr-1 tabular-nums text-[10px] text-muted-foreground">
          {countSessions(group)}
        </span>
      </button>
      {open && (
        <ul className="flex flex-col gap-0.5">
          {group.groups.map((child) => (
            <GroupNode
              key={child.path}
              group={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onRegroup={onRegroup}
              collapsed={collapsed}
              toggleCollapsed={toggleCollapsed}
            />
          ))}
          {group.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={selectedId === session.id}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
  depth = 0,
}: {
  session: SavedSession;
  selected: boolean;
  onSelect: (id: string | null) => void;
  depth?: number;
}) {
  const color = sessionColor(session);
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_DRAG_MIME, session.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onSelect(session.id)}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-xs",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent",
      )}
    >
      {color ? (
        <span
          aria-hidden
          className="mt-1 size-2 shrink-0 rounded-full border border-black/10"
          style={{ backgroundColor: color }}
        />
      ) : (
        <Server className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium leading-tight">{session.name}</span>
        {session.comment && (
          <span className="block truncate text-[10px] leading-tight text-muted-foreground">
            {session.comment}
          </span>
        )}
      </span>
    </button>
  );
}

const asArgs = (p: SavePayload): Record<string, unknown> => ({ ...p });

export function SessionManagerDialog({
  open,
  onOpenChange,
  initialSelectedId = null,
}: SessionManagerDialogProps) {
  const queryClient = useQueryClient();
  const connectSession = useConnectionStore((s) => s.connectSession);

  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => ipc<SavedSession[]>("session_list"),
    enabled: open,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SessionDraft>(newDraft);
  const [secrets, setSecrets] = useState<DraftSecrets>({ password: "", sshPassword: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  /** Collapsed group paths (full slash paths) in the left tree. */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const list = useMemo(() => sessions.data ?? [], [sessions.data]);
  /** Sessions persisted server-side (as opposed to an unsaved new draft). */
  const savedIds = useMemo(() => new Set(list.map((s) => s.id)), [list]);

  function selectSession(id: string | null) {
    setSelectedId(id);
    setFormError(null);
    setTestResult(null);
    setSecrets({ password: "", sshPassword: "" });
    const session = list.find((s) => s.id === id);
    setDraft(session ? draftFromSession(session) : newDraft());
  }

  // When the loaded list changes, make sure a selected row still exists.
  // A brand-new unsaved draft stays selected until another row is clicked.
  useEffect(() => {
    if (!open) return;
    if (selectedId !== null && !list.some((s) => s.id === selectedId)) {
      selectSession(null);
    }
  }, [open, list, selectedId]);

  // External preselection (palette Shift+Enter): apply once the requested
  // row exists in the loaded list; re-opening for the same id still works
  // because `open` flips and the store clears the id between uses.
  useEffect(() => {
    if (!open || !initialSelectedId) return;
    if (selectedId === initialSelectedId) return;
    if (!list.some((s) => s.id === initialSelectedId)) return; // wait for load
    selectSession(initialSelectedId);
  }, [open, initialSelectedId, list, selectedId]);

  const invalidateSessions = () => queryClient.invalidateQueries({ queryKey: ["sessions"] });

  // Settings transfer (HeidiSQL "settings file" parity): sessions + UI
  // settings travel as one JSON file; passwords never leave the encrypted
  // local credential store.
  const exportSettings = async () => {
    try {
      setExporting(true);
      const path = await pickSavePath("dbobcat-settings.json", [
        { name: "DBobcat settings", extensions: ["json"] },
      ]);
      if (!path) return;
      const summary = await ipc<SettingsExportSummary>("settings_export_to_file", { path });
      notify.success(
        `Exported ${summary.sessions} session(s) · ${summary.keys} key(s). Passwords are not included.`,
      );
    } catch (err) {
      notify.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const importSettings = async () => {
    try {
      setImporting(true);
      const path = await pickOpenPath([
        { name: "DBobcat settings", extensions: ["json"] },
      ]);
      if (!path) return;
      const summary = await ipc<SettingsImportSummary>("settings_import_from_file", {
        path,
        replaceSessions: false,
      });
      notify.success(
        `Imported ${summary.keysImported} key(s): ${summary.sessionsAdded} session(s) added, ${summary.sessionsUpdated} updated.`,
      );
      await invalidateSessions();
    } catch (err) {
      notify.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  const saveMutation = useMutation({
    mutationFn: async (payload: SavePayload) => {
      await ipc("session_save", asArgs(payload));
      return payload.session;
    },
    onSuccess: async (session) => {
      await invalidateSessions();
      setSelectedId(session.id);
      setFormError(null);
      notify.success(t("session.saved", { name: session.name }));
    },
    onError: (err) => setFormError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (sessionId: string) => ipc("session_delete", { sessionId }),
    onSuccess: async (_data, sessionId) => {
      await invalidateSessions();
      if (selectedId === sessionId) selectSession(null);
      notify.info("Session deleted.");
    },
    onError: (err) => setFormError(err.message),
  });

  const testMutation = useMutation({
    mutationFn: async (payload: SavePayload) => ipc<TestResult>("session_test", asArgs(payload)),
    onSuccess: (result) => setTestResult(result),
    onError: (err) =>
      setTestResult({ ok: false, serverVersion: null, elapsedMs: 0, error: err.message }),
  });

  function buildPayload(): SavePayload | null {
    const error = validateDraft(draft, secrets);
    if (error) {
      setFormError(error);
      return null;
    }
    setFormError(null);
    const wireSecrets = secretsForWire(secrets);
    return { session: draftToSession(draft), ...wireSecrets };
  }

  function handleSave() {
    const payload = buildPayload();
    if (!payload) return;
    saveMutation.mutate(payload);
  }

  function handleTest() {
    const payload = buildPayload();
    if (!payload) return;
    setTestResult(null);
    testMutation.mutate(payload);
  }

  /** Drop-regroup: re-save the dragged session under `newGroup` ("" = root). */
  function handleRegroup(sessionId: string, newGroup: string) {
    const session = list.find((s) => s.id === sessionId);
    if (!session) return;
    // Compare normalized paths so dropping onto the session's own folder
    // ("Work/Prod" vs " Work / Prod ") is a no-op.
    if (parseGroupPath(session.group).join("/") === newGroup) return;
    selectSession(sessionId);
    // No password args: the backend keeps stored credentials. "" → null
    // matches draftToSession's stored-group convention.
    saveMutation.mutate({ session: { ...session, group: newGroup === "" ? null : newGroup } });
  }

  /** Connect always persists first so the backend can resolve secrets by id. */
  async function handleConnect() {
    const payload = buildPayload();
    if (!payload) return;
    setConnecting(true);
    try {
      try {
        await saveMutation.mutateAsync(payload);
      } catch {
        return; // already surfaced by saveMutation.onError
      }
      const s = payload.session;
      const ok = await connectSession({
        id: s.id,
        name: s.name,
        dbType: s.dbType,
        host: s.host,
        port: s.port,
        user: s.user,
        color: s.color ?? null,
      });
      if (ok) onOpenChange(false);
    } finally {
      setConnecting(false);
    }
  }

  const busy =
    saveMutation.isPending || deleteMutation.isPending || testMutation.isPending || connecting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Responsive height: fill on small viewports, cap on tall ones so the
          two-pane grid (min-h-0) scrolls instead of leaving a blank strip. */}
      <DialogContent className="flex h-[min(640px,90dvh)] max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>{t("session.title")}</DialogTitle>
          <DialogDescription>{t("session.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[210px_1fr]">
          {/* Grouped session tree */}
          <div className="flex min-h-0 flex-col border-r">
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("session.list")}</span>
              <span className="flex items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Import settings file"
                      disabled={importing}
                      onClick={() => void importSettings()}
                    >
                      {importing ? <Spinner className="size-3.5" /> : <FileUp />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Import sessions/settings from a JSON file
                    (passwords not included)
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Export settings file"
                      disabled={exporting}
                      onClick={() => void exportSettings()}
                    >
                      {exporting ? <Spinner className="size-3.5" /> : <FileDown />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Export sessions/settings to a JSON file
                    (passwords not included)
                  </TooltipContent>
                </Tooltip>
                <Button variant="ghost" size="icon-xs" aria-label={t("session.new")} onClick={() => selectSession(null)}>
                  <Plus />
                </Button>
              </span>
            </div>
            <ScrollArea className="min-h-0 flex-1 px-1 pb-2">
              {sessions.isPending && (
                <p className="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground">
                  <Spinner className="size-3.5" /> {t("session.loading")}
                </p>
              )}
              {!sessions.isPending && (
                <SessionTreeList
                  root={buildSessionTree(list)}
                  selectedId={selectedId}
                  onSelect={selectSession}
                  onRegroup={handleRegroup}
                  collapsed={collapsedGroups}
                  toggleCollapsed={(path) =>
                    setCollapsedGroups((prev) => {
                      const next = new Set(prev);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return next;
                    })
                  }
                />
              )}
            </ScrollArea>
          </div>

          {/* Editor */}
          <div className="flex min-h-0 flex-col">
            <SessionForm
              draft={draft}
              secrets={secrets}
              onChange={(d) => {
                setDraft(d);
                setTestResult(null);
              }}
              onSecretsChange={(s) => setSecrets(s)}
              testResult={testResult}
              testPending={testMutation.isPending}
              existingGroups={existingGroupPaths(list)}
            />

            <div className="flex shrink-0 flex-col gap-1.5 border-t px-4 py-3">
              {formError && (
                <p className="text-xs text-destructive">{formError}</p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={!savedIds.has(draft.id) || deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(draft.id)}
                >
                  <Trash2 data-icon="inline-start" />
                  {t("session.delete")}
                </Button>
                <div className="flex-1" />
                <Button variant="secondary" size="sm" disabled={busy} onClick={handleTest}>
                  {t("session.test")}
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={handleSave}>
                  {saveMutation.isPending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                  {t("session.save")}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void handleConnect()}>
                  {connecting ? <Spinner data-icon="inline-start" /> : <PlugZap data-icon="inline-start" />}
                  {t("session.connect")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
