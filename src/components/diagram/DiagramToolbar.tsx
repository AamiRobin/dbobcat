import {
  Copy,
  Download,
  Image,
  Maximize,
  RefreshCw,
  Shrink,
  UnfoldVertical,
  FoldVertical,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";

/**
 * Diagram toolbar strip (h-8): fit / relayout / zoom display, keys-only
 * mode (ToggleGroup), collapse & expand all, the Export ▸ menu and refresh.
 */
export interface DiagramToolbarProps {
  zoom: number;
  keysOnly: boolean;
  busy: boolean;
  onKeysOnlyChange: (keysOnly: boolean) => void;
  onFit: () => void;
  onRelayout: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onExportPng: () => void;
  onExportSvg: () => void;
  onCopyImage: () => void;
  onRefresh: () => void;
}

function ToolButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" onClick={onClick} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function DiagramToolbar(props: DiagramToolbarProps) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b bg-muted/40 px-2">
      <ToolButton label={t("er.toolbar.fit")} onClick={props.onFit}>
        <Maximize />
      </ToolButton>
      <ToolButton label={t("er.toolbar.relayout")} onClick={props.onRelayout}>
        <Shrink />
      </ToolButton>

      <span className="min-w-9 text-center text-xs tabular-nums text-muted-foreground">
        {Math.round(props.zoom * 100)}%
      </span>

      <Separator orientation="vertical" className="mx-1 h-4" />

      <ToggleGroup
        type="single"
        size="sm"
        spacing={0}
        variant="outline"
        value={props.keysOnly ? "keys" : "all"}
        onValueChange={(value) => props.onKeysOnlyChange(value === "keys")}
      >
        <ToggleGroupItem value="all" className="px-2 text-xs">
          {t("er.toolbar.keysAll")}
        </ToggleGroupItem>
        <ToggleGroupItem value="keys" className="px-2 text-xs">
          {t("er.toolbar.keysOnly")}
        </ToggleGroupItem>
      </ToggleGroup>

      <Separator orientation="vertical" className="mx-1 h-4" />

      <ToolButton
        label={t("er.toolbar.collapseAll")}
        onClick={props.onCollapseAll}
        disabled={props.busy}
      >
        <FoldVertical />
      </ToolButton>
      <ToolButton
        label={t("er.toolbar.expandAll")}
        onClick={props.onExpandAll}
        disabled={props.busy}
      >
        <UnfoldVertical />
      </ToolButton>

      <div className="ml-auto flex items-center gap-1">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" disabled={props.busy}>
                  <Download data-icon="inline-start" />
                  {t("er.toolbar.export")}
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("er.toolbar.export")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={props.onExportPng}>
                <Image data-icon="inline-start" />
                {t("er.toolbar.exportPng")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={props.onExportSvg}>
                <Download data-icon="inline-start" />
                {t("er.toolbar.exportSvg")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={props.onCopyImage}>
                <Copy data-icon="inline-start" />
                {t("er.toolbar.copyImage")}
              </DropdownMenuItem>

            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <ToolButton label={t("er.toolbar.refresh")} onClick={props.onRefresh}>
          <RefreshCw />
        </ToolButton>
      </div>
    </div>
  );
}
