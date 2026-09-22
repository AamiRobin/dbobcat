import { Panel } from "@xyflow/react";
import { Diamond, Hash, KeyRound, Link } from "lucide-react";

import { t } from "@/lib/i18n";

/**
 * Canvas legend as a single-line pill, bottom-center (Controls stay
 * bottom-left, MiniMap bottom-right — nothing overlaps).
 */
export function DiagramLegend() {
  return (
    <Panel position="bottom-center">
      <div className="flex items-center gap-3 whitespace-nowrap rounded-md border bg-popover/95 px-2.5 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur-sm">
        <span className="flex items-center gap-1">
          <KeyRound className="size-3 text-amber-500" />
          {t("er.legend.pk")}
        </span>
        <span className="flex items-center gap-1">
          <Link className="size-3 text-sky-500" />
          {t("er.legend.fk")}
        </span>
        <span className="flex items-center gap-1">
          <Diamond className="size-3 text-muted-foreground" />
          {t("er.legend.unique")}
        </span>
        <span className="flex items-center gap-1">
          <Hash className="size-3 text-muted-foreground" />
          {t("er.legend.identity")}
        </span>
        <span className="flex items-center gap-1">
          <span className="font-mono text-muted-foreground/60">type</span>
          {t("er.legend.nullable")}
        </span>
      </div>
    </Panel>
  );
}
