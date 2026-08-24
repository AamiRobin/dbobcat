import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, RefreshCw, Search, SlidersHorizontal } from "lucide-react";

import { EmptyPlaceholder } from "@/components/layout/EmptyPlaceholder";
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchStatus, fetchVariables, formatUptime, serverKeys } from "@/lib/server-queries";
import { log } from "@/stores/log";
import type { Tab } from "@/stores/tabs";
import type { StatusVariable, ServerVariable } from "@/types/ipc";

/**
 * Variables & status dashboards (Phase 7). Filter-as-you-type over
 * `SHOW VARIABLES` / `SHOW GLOBAL STATUS` (or their PG equivalents). The
 * status tab notes "since server start" and surfaces uptime when present.
 */
export function ServerVarsView({ tab }: { tab: Tab }) {
  const connId = tab.meta.connId;
  if (typeof connId !== "number") {
    return (
      <EmptyPlaceholder
        icon={SlidersHorizontal}
        title="No connection"
        hint="Connect to a server first."
      />
    );
  }
  return <ServerVarsInner key={tab.id} connId={connId} />;
}

function ServerVarsInner({ connId }: { connId: number }) {
  const [filter, setFilter] = useState("");

  const variables = useQuery({
    queryKey: serverKeys.variables(connId),
    queryFn: () => fetchVariables(connId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const status = useQuery({
    queryKey: serverKeys.status(connId),
    queryFn: () => fetchStatus(connId),
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });

  const f = filter.trim().toLowerCase();
  const filteredVars = useMemo(
    () => (variables.data ?? []).filter((v) => !f || v.name.toLowerCase().includes(f)),
    [variables.data, f],
  );
  const filteredStatus = useMemo(
    () => (status.data ?? []).filter((v) => !f || v.name.toLowerCase().includes(f)),
    [status.data, f],
  );

  // Uptime comes through as a plain "Uptime" status entry on both engines.
  const uptimeEntry = useMemo<StatusVariable | undefined>(
    () => status.data?.find((s) => s.name === "Uptime"),
    [status.data],
  );

  function refresh() {
    void variables.refetch();
    void status.refetch();
    log("info", "Refreshing server variables and status…");
  }

  return (
    <Tabs defaultValue="variables" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <TabsList className="h-7">
          <TabsTrigger value="variables" className="text-xs">
            Variables ({filteredVars.length})
          </TabsTrigger>
          <TabsTrigger value="status" className="text-xs">
            Status ({filteredStatus.length})
          </TabsTrigger>
        </TabsList>
        <div className="relative ml-auto w-56">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name…"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <Button variant="outline" size="icon-xs" aria-label="Refresh" onClick={refresh}>
          {status.isFetching || variables.isFetching ? (
            <Spinner />
          ) : (
            <RefreshCw />
          )}
        </Button>
      </div>

      <TabsContent value="variables" className="min-h-0 flex-1 overflow-auto">
        <NameValueTable
          rows={filteredVars as NameValueRow[]}
          isLoading={variables.isLoading}
          error={(variables.error as Error | null)?.message ?? null}
          emptyLabel="No variables match."
        />
      </TabsContent>
      <TabsContent value="status" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <p className="flex items-center gap-1.5 border-b bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
          <Clock className="size-3" />
          Counters since server start
          {uptimeEntry && <> · uptime {formatUptime(Number(uptimeEntry.value))}</>}
        </p>
        <div className="min-h-0 flex-1 overflow-auto">
          <NameValueTable
            rows={filteredStatus as NameValueRow[]}
            isLoading={status.isLoading}
            error={(status.error as Error | null)?.message ?? null}
            emptyLabel="No counters match."
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}

type NameValueRow = ServerVariable | StatusVariable;

function NameValueTable({
  rows,
  isLoading,
  error,
  emptyLabel,
}: {
  rows: NameValueRow[];
  isLoading: boolean;
  error: string | null;
  emptyLabel: string;
}) {
  if (error) {
    return <p className="p-4 text-center text-xs text-destructive">{error}</p>;
  }
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-6">
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    );
  }
  return (
    <Table className="text-xs">
      <TableHeader className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
        <TableRow>
          <TableHead className="w-[45%]">Name</TableHead>
          <TableHead>Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.name}>
            <TableCell className="font-mono">{r.name}</TableCell>
            <TableCell
              className="cursor-text font-mono select-all"
              title="Click to select for copying"
              onClick={(e) => window.getSelection()?.selectAllChildren(e.currentTarget)}
            >
              {r.value === "" ? (
                <span className="italic text-muted-foreground/60">empty</span>
              ) : (
                r.value
              )}
            </TableCell>
          </TableRow>
        ))}
        {!isLoading && rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={2} className="text-center text-muted-foreground">
              {emptyLabel}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
