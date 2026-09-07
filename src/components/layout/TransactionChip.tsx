import { ArrowDownRight, ArrowUpRight, FileText, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { t } from "@/lib/i18n";
import { notify } from "@/lib/toast";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection";
import { useTransactionStore } from "@/stores/transaction";
import type { IsolationLevel, TxEntry, TxState } from "@/types/ipc";

const ISOLATION_LEVELS: IsolationLevel[] = [
  "read_uncommitted",
  "read_committed",
  "repeatable_read",
  "serializable",
];

const KIND_ICON: Record<TxEntry["kind"], typeof FileText> = {
  select: ArrowDownRight,
  dml: ArrowUpRight,
  ddl: Settings2,
  other: FileText,
};

/** "42s ago"-style label; entries never outlive a transaction. */
function relativeTime(startedMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function isolationLabel(level: IsolationLevel): string {
  switch (level) {
    case "read_uncommitted":
      return t("tx.isolation.readUncommitted");
    case "read_committed":
      return t("tx.isolation.readCommitted");
    case "repeatable_read":
      return t("tx.isolation.repeatableRead");
    case "serializable":
      return t("tx.isolation.serializable");
  }
}

/** Chip color/label per ledger state. */
function chipOf(state: TxState): { className: string; label: string } {
  if (state.phase === "aborted") {
    return {
      className: "bg-destructive/15 text-destructive",
      label: t("tx.chip.aborted"),
    };
  }
  if (state.mode === "auto") {
    return { className: "bg-muted text-muted-foreground", label: t("tx.chip.auto") };
  }
  if (state.phase === "open") {
    return {
      className: "bg-warning/15 text-warning animate-pulse",
      label: t("tx.chip.manualOpen", { count: state.dmlCount }),
    };
  }
  return { className: "bg-icon-blue/15 text-icon-blue", label: t("tx.chip.manualIdle") };
}

/**
 * Status-bar transaction chip + ledger popover (Transactions Phase 1).
 * Hidden entirely for SQLite sessions and while disconnected.
 */
export function TransactionChip() {
  const status = useConnectionStore((s) => s.status);
  const link = useConnectionStore((s) => s.link);
  const dialect = useConnectionStore((s) => s.serverInfo?.dialect ?? null);
  const tx = useTransactionStore((s) => s.tx);
  const commit = useTransactionStore((s) => s.commit);
  const rollback = useTransactionStore((s) => s.rollback);
  const setMode = useTransactionStore((s) => s.setMode);
  const setIsolation = useTransactionStore((s) => s.setIsolation);

  if (status !== "connected" || dialect === null || dialect === "sqlite") {
    return null;
  }
  if (!tx) {
    // Ledger snapshot not received yet — show the neutral auto state.
    return (
      <Badge variant="secondary" className="h-auto rounded-md px-1.5 py-0.5 text-[10px]">
        {t("tx.chip.auto")}
      </Badge>
    );
  }

  const chip = chipOf(tx);
  const dimmed = link === "reconnecting";
  const manual = tx.mode === "manual";

  const handleModeToggle = (manualNext: boolean) => {
    void setMode(manualNext ? "manual" : "auto").then((ok) => {
      if (!ok && !manualNext) {
        notify.warning("tx.toast.modeSwitchRefused");
      }
    });
  };

  const handleCommit = () => {
    void commit().then((cleared) => {
      if (cleared !== null) notify.success("tx.toast.committed", { count: cleared });
    });
  };

  const handleRollback = () => {
    void rollback().then((cleared) => {
      if (cleared !== null) notify.info("tx.toast.rolledBack", { count: cleared });
    });
  };

  return (
    <Popover>
      <PopoverTrigger
        data-testid="tx-chip"
        aria-label={t("tx.chip.title")}
        disabled={dimmed}
        className={cn(
          "rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-opacity",
          chip.className,
          dimmed && "opacity-40",
        )}
      >
        {chip.label}
      </PopoverTrigger>

      <PopoverContent align="start" className="w-96 min-w-72 p-3">
        {/* Entries ------------------------------------------------------ */}
        <div className="mb-2 max-h-56 overflow-y-auto">
          {tx.entries.length === 0 ? (
            <p className="px-1 py-3 text-xs leading-relaxed text-muted-foreground">
              {t("tx.popover.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {tx.entries.map((entry, i) => (
                <li
                  key={`${entry.startedMs}-${i}`}
                  className="flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-accent"
                >
                  {(() => {
                    const Icon = KIND_ICON[entry.kind] ?? FileText;
                    return (
                      <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                    );
                  })()}
                  <code className="min-w-0 flex-1 truncate font-mono" title={entry.sql}>
                    {entry.sql}
                  </code>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {entry.rowsAffected > 0 ? t("tx.popover.rowsAffected", { count: entry.rowsAffected }) : ""}
                  </span>
                  <span className="w-7 shrink-0 text-right tabular-nums text-muted-foreground/70">
                    {relativeTime(entry.startedMs)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Separator className="my-2" />

        {/* Commit / Rollback ------------------------------------------- */}
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            className="flex-1"
            disabled={tx.phase !== "open"}
            onClick={handleCommit}
          >
            {t("tx.popover.commit")}
          </Button>
          <Button
            size="xs"
            variant={tx.phase === "aborted" ? "destructive" : "outline"}
            className="flex-1"
            disabled={tx.phase === "idle"}
            onClick={handleRollback}
          >
            {t("tx.popover.rollback")}
          </Button>
        </div>

        <Separator className="my-2" />

        {/* Mode toggle -------------------------------------------------- */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col">
            <Label className="text-xs">{t("tx.popover.mode")}</Label>
            <span className="text-xs text-muted-foreground">
              {t("tx.popover.modeHint")}
            </span>
          </div>
          <Switch checked={manual} onCheckedChange={handleModeToggle} />
        </div>

        {/* Isolation ---------------------------------------------------- */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <Label className="text-xs">{t("tx.popover.isolation")}</Label>
          <Select
            value={tx.isolation ?? ""}
            disabled={tx.phase !== "idle"}
            onValueChange={(next) => {
              if (next) void setIsolation(next as IsolationLevel);
            }}
          >
            <SelectTrigger size="sm" className="h-6 w-44 px-2 text-xs">
              {tx.isolation ? isolationLabel(tx.isolation) : t("session.form.isolation.default")}
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {ISOLATION_LEVELS.map((level) => (
                  <SelectItem key={level} value={level} className="text-xs">
                    {isolationLabel(level)}
                  </SelectItem>
                ))}

              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <Separator className="my-2" />
        <p className="text-xs leading-snug text-muted-foreground/70">
          {t("tx.footer.note")}
        </p>
      </PopoverContent>
    </Popover>
  );
}
