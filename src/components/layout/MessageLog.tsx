import { useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Eraser, Terminal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";
import { useLogStore, type LogLevel } from "@/stores/log";

const LEVEL_CLASS: Record<LogLevel, string> = {
  info: "text-foreground",
  success: "text-success",
  warn: "text-warning",
  error: "text-destructive",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Collapsible bottom panel showing timestamped application/IPC messages. */
export function MessageLog() {
  const logs = useLogStore((s) => s.logs);
  const clearLogs = useLogStore((s) => s.clearLogs);
  const collapsed = useUiStore((s) => s.logCollapsed);
  const setCollapsed = useUiStore((s) => s.setLogCollapsed);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the latest entry in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden" aria-label="Message log">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b bg-muted/40 px-2">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          <Terminal className="size-3.5" />
          Messages
        </button>
        <Badge variant="secondary" className="h-4 px-1.5 text-[10px] tabular-nums">
          {logs.length}
        </Badge>
        {!collapsed && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Clear messages"
            disabled={logs.length === 0}
            onClick={clearLogs}
            className="ml-auto text-muted-foreground"
          >
            <Eraser />
          </Button>
        )}
      </div>

      {!collapsed && (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <ScrollArea className="h-full">
            <div className="px-3 py-1.5 font-mono text-[11px] leading-relaxed">
              {logs.length === 0 ? (
                <p className="text-muted-foreground/60">No messages yet.</p>
              ) : (
                logs.map((entry) => (
                  <div key={entry.id} className="flex gap-2 whitespace-pre-wrap">
                    <span className="shrink-0 tabular-nums text-muted-foreground/60">
                      {formatTime(entry.ts)}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 w-14 uppercase",
                        LEVEL_CLASS[entry.level],
                      )}
                    >
                      {entry.level === "success" ? "ok" : entry.level}
                    </span>
                    <span className={LEVEL_CLASS[entry.level]}>{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </section>
  );
}
