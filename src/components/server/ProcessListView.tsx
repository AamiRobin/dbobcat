import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Ban, RefreshCw } from "lucide-react";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { EmptyPlaceholder } from "@/components/layout/EmptyPlaceholder";
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchProcesses, killProcess, serverKeys } from "@/lib/server-queries";
import { cn } from "@/lib/utils";
import { log } from "@/stores/log";
import { notify } from "@/lib/toast";
import type { Tab } from "@/stores/tabs";
import type { ProcessInfo } from "@/types/ipc";

type Interval = "1000" | "2000" | "5000" | "off";

const INTERVAL_LABELS: Record<Interval, string> = {
  "1000": "1s",
  "2000": "2s",
  "5000": "5s",
  off: "off",
};

/**
 * Process list monitor (Phase 7). Polls `process_list` at a configurable
 * interval (paused while the tab/window is hidden), supports KILL QUERY /
 * KILL CONNECTION and highlights our own session row.
 */
export function ProcessListView({ tab }: { tab: Tab }) {
  const connId = tab.meta.connId;
  if (typeof connId !== "number") {
    return (
      <EmptyPlaceholder icon={RefreshCw} title="No connection" hint="Connect to a server first." />
    );
  }
  return <ProcessListInner key={tab.id} connId={connId} />;
}

function ProcessListInner({ connId }: { connId: number }) {
  const [intervalKey, setIntervalKey] = useState<Interval>("2000");
  const [hidden, setHidden] = useState(false);
  const [killTarget, setKillTarget] = useState<{ id: number; queryOnly: boolean } | null>(null);

  // Pause polling when the tab or window is not visible.
  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const enabled = intervalKey !== "off" && !hidden;
  const processes = useQuery({
    queryKey: serverKeys.processes(connId),
    queryFn: () => fetchProcesses(connId),
    refetchInterval: enabled ? Number(intervalKey) : false,
    refetchIntervalInBackground: false,
  });

  const kill = useMutation({
    mutationFn: (t: { id: number; queryOnly: boolean }) =>
      killProcess(connId, t.id, t.queryOnly),
    onSuccess: (_d, t) => {
      log(
        "warn",
        `${t.queryOnly ? "Killed query" : "Killed connection"} #${t.id}.`,
      );
      setKillTarget(null);
      void processes.refetch();
    },
    onError: (err) => notify.error(`Kill failed: ${err.message}`),
  });

  const rows = processes.data ?? [];
  const ownCount = rows.filter((p) => p.isOwn).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---- toolbar ---- */}
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <span className="text-xs font-semibold">Process list</span>
        <span className="text-[11px] text-muted-foreground">
          {rows.length} process{rows.length === 1 ? "" : "es"}
          {ownCount > 0 && ` · ${ownCount} this connection`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Auto-refresh</span>
          <Select value={intervalKey} onValueChange={(v) => setIntervalKey(v as Interval)}>
            <SelectTrigger size="sm" className="w-16 text-xs" aria-label="Refresh interval">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(INTERVAL_LABELS) as Interval[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {INTERVAL_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="Refresh now"
            onClick={() => void processes.refetch()}
          >
            {processes.isFetching ? (
              <Spinner />
            ) : (
              <RefreshCw />
            )}
          </Button>
        </div>
      </div>

      {/* ---- table ---- */}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table className="text-xs">
          <TableHeader className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
            <TableRow>
              <TableHead className="w-20">ID</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>DB</TableHead>
              <TableHead>Command</TableHead>
              <TableHead className="text-right">Time&nbsp;(s)</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Info</TableHead>
              <TableHead className="w-40 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <ProcessRow key={p.id} p={p} onKill={(queryOnly) => setKillTarget({ id: p.id, queryOnly })} />
            ))}
          </TableBody>
        </Table>
        {!processes.isLoading && rows.length === 0 && (
          <p className="p-4 text-center text-xs text-muted-foreground">
            No processes visible (missing PROCESS privilege shows only your own threads).
          </p>
        )}
        {processes.isError && (
          <p className="p-4 text-center text-xs text-destructive">
            {(processes.error as Error).message}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={killTarget !== null}
        onOpenChange={(v) => !v && setKillTarget(null)}
        title={
          killTarget?.queryOnly
            ? `Kill query #${killTarget?.id}?`
            : `Kill connection #${killTarget?.id}?`
        }
        description={
          killTarget?.queryOnly
            ? "Aborts the running statement but keeps the connection alive."
            : "Terminates the connection immediately."
        }
        confirmLabel={killTarget?.queryOnly ? "Kill query" : "Kill connection"}
        destructive
        busy={kill.isPending}
        onConfirm={() => killTarget && kill.mutate(killTarget)}
      />
    </div>
  );
}

function ProcessRow({ p, onKill }: { p: ProcessInfo; onKill: (queryOnly: boolean) => void }) {
  const info = useMemo(() => truncateOneLine(p.info ?? ""), [p.info]);
  return (
    <TableRow className={cn(p.isOwn && "bg-primary/10")}>
      <TableCell className="font-mono tabular-nums">
        {p.id}
        {p.isOwn && <span className="ml-1 text-[10px] text-primary">(this connection)</span>}
      </TableCell>
      <TableCell className="font-mono">{p.user}</TableCell>
      <TableCell className="max-w-44 truncate font-mono" title={p.host ?? undefined}>
        {p.host ?? "—"}
      </TableCell>
      <TableCell>{p.db ?? "—"}</TableCell>
      <TableCell>{p.command ?? "—"}</TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {formatSeconds(p.timeSeconds)}
      </TableCell>
      <TableCell className="max-w-36 truncate" title={p.waitEvent ?? p.state ?? undefined}>
        {p.waitEventType || p.waitEvent || p.state || "—"}
      </TableCell>
      <TableCell className="max-w-72 truncate font-mono text-[11px]" title={p.info ?? undefined}>
        {info}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="xs" onClick={() => onKill(true)}>
            <Ban data-icon="inline-start" />
            Kill query
          </Button>
          {!p.isOwn && (
            <Button variant="ghost" size="xs" className="text-destructive" onClick={() => onKill(false)}>
              Kill connection
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0";
  return seconds >= 100 ? String(Math.round(seconds)) : String(Math.round(seconds * 10) / 10);
}

/** Collapse whitespace for the inline Info cell. */
function truncateOneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}
