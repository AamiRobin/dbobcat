import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { StarIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import { msSinceLastErrorToast } from "@/lib/toast";
import { useLogStore } from "@/stores/log";
import { isDue, useStarPromptStore } from "@/stores/star-prompt";
import { useUiStore } from "@/stores/ui";

const REPO_URL = "https://github.com/AamiRobin/dbobcat";

/** Delay after launch before the first arm attempt (let the user settle in). */
const ARM_DELAY_MS = 12_000;
/** Re-check interval while a query is running or an error is fresh. */
const BUSY_RETRY_MS = 15_000;
/** Arm attempts before giving up for this launch (a later launch retries). */
const MAX_BUSY_RETRIES = 4;
/** A toast or log entry younger than this defers the prompt. */
const QUIET_AFTER_ERROR_MS = 8_000;

/** True while the user is mid-task or dealing with a failure. */
function sceneBusy(): boolean {
  if (useUiStore.getState().dataStats?.running) return true;
  if (msSinceLastErrorToast() < QUIET_AFTER_ERROR_MS) return true;
  const logs = useLogStore.getState().logs;
  const last = logs[logs.length - 1];
  return last?.level === "error" && Date.now() - last.ts < QUIET_AFTER_ERROR_MS;
}

/** GitHub mark (Octicons, MIT). lucide dropped brand icons. */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

/**
 * Launch-milestone star prompt. Store state decides IF due; this component
 * decides WHEN within the launch: a settle-in delay plus quiet checks, so a
 * star request never lands on top of a running query or a fresh error.
 */
export function StarPromptDialog() {
  const due = useStarPromptStore(isDue);
  const dismiss = useStarPromptStore((s) => s.dismiss);
  const starClicked = useStarPromptStore((s) => s.starClicked);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    let timer: ReturnType<typeof setTimeout>;
    let retries = 0;
    const attempt = () => {
      if (!sceneBusy()) {
        setArmed(true);
        return;
      }
      if (++retries <= MAX_BUSY_RETRIES) timer = setTimeout(attempt, BUSY_RETRY_MS);
    };
    timer = setTimeout(attempt, ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  // ESC / overlay / close icon route here too: any close without a star
  // click is a dismissal for the state machine. Programmatic closes (the
  // two buttons below) re-render `open` to false without calling this.
  const handleOpenChange = (open: boolean) => {
    if (!open) dismiss();
  };

  const handleStar = () => {
    starClicked();
    void openUrl(REPO_URL).catch(() => window.open(REPO_URL, "_blank"));
  };

  return (
    <Dialog open={due && armed} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitHubMark className="size-5" />
            {t("star.title")}
          </DialogTitle>
          <DialogDescription>{t("star.description")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => dismiss()}>
            {t("star.later")}
          </Button>
          <Button size="sm" onClick={handleStar}>
            <StarIcon className="size-4" />
            {t("star.action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
