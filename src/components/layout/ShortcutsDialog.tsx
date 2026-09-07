import { Keyboard } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import { formatCombo, SHORTCUTS, type ShortcutGroup } from "@/lib/shortcuts";
import { useUiStore } from "@/stores/ui";

/**
 * Lists every registered keyboard shortcut, grouped by area. Grid keys are
 * handled locally by the data grid (not the global registry) and shown as
 * reference; Escape closes dialogs via Radix in every dialog component.
 */

const GROUP_ORDER: ShortcutGroup[] = ["Global", "Query", "Dialogs"];

const GRID_KEYS: Array<{ combo: string; label: string }> = [
  { combo: "Enter / F2", label: "Begin editing the focused cell" },
  { combo: "Ctrl+C", label: "Copy selected cells" },
  { combo: "Del", label: "Delete selected rows (posts as a change)" },
  { combo: "Esc", label: "Cancel cell edit / close dialog" },
];

/** Editor keys handled by CodeMirror's search keymap (Phase 9-B). */
const EDITOR_KEYS: Array<{ combo: string; label: string }> = [
  { combo: "Ctrl+F", label: "Find (with replace toggle)" },
  { combo: "Ctrl+H", label: "Find & replace" },
  { combo: "F3", label: "Find next" },
  { combo: "Esc", label: "Close find panel" },
];

export function ShortcutsDialog() {
  const open = useUiStore((s) => s.shortcutsOpen);
  const setOpen = useUiStore((s) => s.setShortcutsOpen);

  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: SHORTCUTS.filter((s) => s.group === group),
  })).filter((g) => g.items.length > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="size-4 text-muted-foreground" />
            {t("shortcuts.title")}
          </DialogTitle>
          <DialogDescription>{t("shortcuts.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 overflow-y-auto pr-1">
          {groups.map(({ group, items }) => (
            <section key={group} className="min-w-0">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {items.map((item) => (
                  <li key={item.id} className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate text-foreground/90">{item.label}</span>
                    <span className="flex shrink-0 gap-1">
                      <Kbd>{formatCombo(item.combos[0])}</Kbd>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Editor
            </h3>
            <ul className="flex flex-col gap-1.5">
              {EDITOR_KEYS.map(({ combo, label }) => (
                <li key={combo} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate text-foreground/90">{label}</span>
                  <Kbd className="shrink-0">{combo}</Kbd>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Grid
            </h3>
            <ul className="flex flex-col gap-1.5">
              {GRID_KEYS.map(({ combo, label }) => (
                <li key={combo} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate text-foreground/90">{label}</span>
                  <Kbd className="shrink-0">{combo}</Kbd>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Dialogs
            </h3>
            <ul className="flex flex-col gap-1.5 text-xs">
              <li className="flex items-baseline justify-between gap-3">
                <span className="text-foreground/90">Close dialog</span>
                <Kbd>Esc</Kbd>
              </li>
            </ul>
          </section>
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
