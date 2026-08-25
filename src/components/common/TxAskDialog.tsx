import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import { ipc } from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { notify } from "@/lib/toast";
import { useConnectionStore } from "@/stores/connection";
import { useTransactionStore, type TxAskReason } from "@/stores/transaction";
import { log } from "@/stores/log";

/** Resolve the pending intent once the ledger is clean. */
async function proceedWithIntent(reason: TxAskReason): Promise<void> {
  switch (reason) {
    case "disconnect":
      await useConnectionStore.getState().disconnect();
      break;
    case "quit":
      // Same path as the app.quit shortcut (which already passed the tx gate).
      await ipc("app_exit");
      break;
    case "window-close":
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      void getCurrentWindow().destroy();
      break;
  }
}

const ACTION_KEY: Record<
  TxAskReason,
  "tx.dialog.action.disconnect" | "tx.dialog.action.quit" | "tx.dialog.action.windowClose"
> = {
  disconnect: "tx.dialog.action.disconnect",
  quit: "tx.dialog.action.quit",
  "window-close": "tx.dialog.action.windowClose",
};

/**
 * Three-way gate for leaving with an open transaction (disconnect / app
 * quit / window close): Commit or Roll back and proceed with the pending
 * intent, or Cancel to stay. The ledger must be idle before proceeding.
 */
export function TxAskDialog() {
  const open = useTransactionStore((s) => s.askOpen);
  const reason = useTransactionStore((s) => s.askReason);
  const dmlCount = useTransactionStore((s) => s.tx?.dmlCount ?? 0);
  const commit = useTransactionStore((s) => s.commit);
  const rollback = useTransactionStore((s) => s.rollback);
  const closeAsk = useTransactionStore((s) => s.closeAsk);
  const [busy, setBusy] = useState<"commit" | "rollback" | null>(null);

  const resolveAndProceed = async (kind: "commit" | "rollback") => {
    setBusy(kind);
    const cleared = kind === "commit" ? await commit() : await rollback();
    setBusy(null);
    if (cleared === null) return; // failure logged; dialog stays open
    if (kind === "commit") {
      notify.success("tx.toast.committed", { count: cleared });
    } else {
      notify.info("tx.toast.rolledBack", { count: cleared });
    }
    closeAsk();
    if (reason) {
      try {
        await proceedWithIntent(reason);
      } catch (err) {
        log("error", err instanceof Error ? err.message : String(err));
      }
    }
  };

  if (!open || !reason) return null;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && closeAsk()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("tx.dialog.title")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              {t("tx.dialog.body", {
                count: dmlCount,
                action: t(ACTION_KEY[reason]),
              })}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy !== null}>{t("dialog.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            disabled={busy !== null}
            onClick={(e) => {
              e.preventDefault(); // closes via the caller's flow
              void resolveAndProceed("rollback");
            }}
          >
            {busy === "rollback" && <Spinner data-icon="inline-start" />}
            {t("tx.dialog.rollback")}
          </AlertDialogAction>
          <AlertDialogAction
            disabled={busy !== null}
            onClick={(e) => {
              e.preventDefault();
              void resolveAndProceed("commit");
            }}
          >
            {busy === "commit" && <Spinner data-icon="inline-start" />}
            {t("tx.dialog.commit")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
