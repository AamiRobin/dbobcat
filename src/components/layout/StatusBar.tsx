import { Circle, Download } from "lucide-react";

import { Separator } from "@/components/ui/separator";
import { TransactionChip } from "@/components/layout/TransactionChip";
import { Spinner } from "@/components/ui/spinner";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useConnectionStore, type LinkState } from "@/stores/connection";
import { useUpdaterStore } from "@/stores/updater";
import { useUiStore } from "@/stores/ui";

/** Link-health dot colors: green ok, amber pulsing reconnecting, red lost. */
function linkDotClass(link: LinkState): string {
  switch (link) {
    case "reconnecting":
      return "fill-warning text-warning animate-pulse";
    case "lost":
      return "fill-destructive text-destructive";
    default:
      return "fill-success text-success";
  }
}

/** Bottom status strip: connection state + active data-grid metrics. */
export function StatusBar() {
  const status = useConnectionStore((s) => s.status);
  const link = useConnectionStore((s) => s.link);
  const session = useConnectionStore((s) => s.session);
  const serverInfo = useConnectionStore((s) => s.serverInfo);
  const dataStats = useUiStore((s) => s.dataStats);
  const updateStatus = useUpdaterStore((s) => s.status);
  const updateVersion = useUpdaterStore((s) => s.version);
  const updateProgress = useUpdaterStore((s) => s.progress);
  const installUpdate = useUpdaterStore((s) => s.install);

  const connected = status === "connected" && session !== null;
  const pending = status === "connecting" || status === "error";

  return (
    <footer className="flex h-6 shrink-0 items-center gap-2 border-t bg-background px-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 font-medium">
        <Circle
          className={cn(
            "size-2",
            connected
              ? linkDotClass(link)
              : pending
                ? "fill-warning text-warning"
                : "fill-muted-foreground/40 text-muted-foreground/40",
          )}
        />
        {connected && session ? (
          <>
            {session.color && (
              <span
                aria-hidden
                className="size-2 rounded-full border border-black/10"
                style={{ backgroundColor: session.color }}
              />
            )}
            <span className="truncate">
              {session.name} — {session.endpoint}
            </span>
          </>
        ) : status === "connecting" ? (
          t("status.connecting")
        ) : (
          t("status.notConnected")
        )}
      </span>

      {connected && link === "reconnecting" && (
        <span className="text-warning">{t("status.reconnecting")}</span>
      )}
      {connected && link === "lost" && (
        <span className="text-destructive">{t("status.linkLost")}</span>
      )}

      <TransactionChip />

      <span className="ml-auto flex items-center gap-2 tabular-nums">
        {updateStatus !== "idle" && (
          <>
            {updateStatus === "available" && (
              <button
                type="button"
                onClick={() => void installUpdate()}
                title={`Download and install update ${updateVersion}`}
                className="flex items-center gap-1 rounded-sm px-1 font-medium text-success hover:bg-muted"
              >
                <Download className="size-3" />
                Update v{updateVersion} — install
              </button>
            )}
            {updateStatus === "downloading" && (
              <span className="flex items-center gap-1" aria-live="polite">
                <Spinner className="size-3" />
                Downloading update{updateProgress != null ? ` — ${updateProgress}%` : "…"}
              </span>
            )}
            {updateStatus === "ready" && (
              <span className="flex items-center gap-1 font-medium text-success">
                <Download className="size-3" />
                Update installed — restart to apply
              </span>
            )}
            <Separator orientation="vertical" className="h-3!" />
          </>
        )}
        {connected && serverInfo && (
          <>
            <span>
              {serverInfo.product} {serverInfo.version}
            </span>
            <Separator orientation="vertical" className="h-3!" />
          </>
        )}
        <span>
          {t("status.rows")}{" "}
          {dataStats
            ? `${dataStats.rowsLoaded.toLocaleString()}${
                dataStats.totalRowsEstimate != null
                  ? ` / ~${dataStats.totalRowsEstimate.toLocaleString()}`
                  : ""
              }`
            : "—"}
        </span>
        <Separator orientation="vertical" className="h-3!" />
        <span>{t("status.elapsed")} {dataStats?.running ? t("status.executing") : dataStats?.elapsedMs != null ? `${dataStats.elapsedMs} ms` : "— ms"}</span>
        <Separator orientation="vertical" className="h-3!" />
        <span>v{__APP_VERSION__}</span>
      </span>
    </footer>
  );
}
