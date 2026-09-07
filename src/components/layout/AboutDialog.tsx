import logoUrl from "@/assets/dbobcat-logo.png";

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
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUiStore } from "@/stores/ui";

const REPO_URL = "https://github.com/AamiRobin/dbobcat";

/** About box: version from the build define, MIT note, HeidiSQL credits. */
export function AboutDialog() {
  const open = useUiStore((s) => s.aboutOpen);
  const setOpen = useUiStore((s) => s.setAboutOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <img src={logoUrl} alt="" className="size-6 rounded-md" />
            {t("about.title")}
          </DialogTitle>
          <DialogDescription>{t("about.tagline")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 text-xs text-muted-foreground">
          <p className="font-mono text-sm text-foreground">v{__APP_VERSION__}</p>
          <p>{t("about.license")}</p>
          <p>{t("about.credits")}</p>
          <button
            type="button"
            className="text-primary underline-offset-2 hover:underline"
            onClick={() => void openUrl(REPO_URL).catch(() => window.open(REPO_URL, "_blank"))}
          >
            {t("about.repository")}
          </button>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {t("dialog.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
