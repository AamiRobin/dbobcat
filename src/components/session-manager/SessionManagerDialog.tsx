import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Folder, PlugZap, Plus, Save, Server, Trash2 } from "lucide-react";

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
import { cn } from "@/lib/utils";
import { ipc } from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { notify } from "@/lib/toast";
import { buildSessionTree, existingGroupPaths, sessionColor, type SessionGroupNode } from "@/lib/session-groups";
import { useConnectionStore } from "@/stores/connection";
import type { SavedSession, TestResult } from "@/types/ipc";

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
}

/** Wire args for `session_save` / `session_test`. */
type SavePayload = {
  session: SavedSession;
  password?: string;
  sshPassword?: string;
};

/** Collapsible grouped tree of sessions (Phase 9-B). */
function SessionTreeList({
  root,
  selectedId,
  onSelect,
  collapsed,
  toggleCollapsed,
}: {
  root: SessionGroupNode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  collapsed: Set<string>;
  toggleCollapsed: (path: string) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {/* Root node: "All sessions" — selects the unsaved new-draft state. */}
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
          selectedId === null
            ? "bg-accent text-accent-foreground"
            : "hover:bg-accent/50",
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
  collapsed,
  toggleCollapsed,
}: {
  group: SessionGroupNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  collapsed: Set<string>;
  toggleCollapsed: (path: string) => void;
}) {
  const open = !collapsed.has(group.path);
  return (
    <li>
      <button
        type="button"
        onClick={() => toggleCollapsed(group.path)}
        className={cn(
          "flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-xs hover:bg-accent/50",
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
      onClick={() => onSelect(session.id)}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-xs",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
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

export function SessionManagerDialog({ open, onOpenChange }: SessionManagerDialogProps) {
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

  const invalidateSessions = () => queryClient.invalidateQueries({ queryKey: ["sessions"] });

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
      <DialogContent className="flex h-[560px] max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>{t("session.title")}</DialogTitle>
          <DialogDescription>{t("session.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[210px_1fr]">
          {/* Grouped session tree */}
          <div className="flex min-h-0 flex-col border-r">
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("session.list")}</span>
              <Button variant="ghost" size="icon-xs" aria-label={t("session.new")} onClick={() => selectSession(null)}>
                <Plus />
              </Button>
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
