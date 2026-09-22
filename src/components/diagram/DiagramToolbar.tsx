import {
  ClipboardCopy,
  Copy,
  Download,
  FileCode,
  Image,
  Maximize,
  RefreshCw,
  Search,
  Shrink,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";

/**
 * Diagram toolbar strip (h-8): fit / relayout, keys-only mode (ToggleGroup),
 * search-in-diagram, the Export ▸ menu (image + copy as SQL/Markdown) and
 * refresh. Zoom controls live on the canvas (React Flow Controls).
 */
export interface DiagramToolbarProps {
  keysOnly: boolean;
  busy: boolean;
  onKeysOnlyChange: (keysOnly: boolean) => void;
  onFit: () => void;
  onRelayout: () => void;
  /** Live diagram search: matches table/column/type names. */
  search: string;
  onSearchChange: (value: string) => void;
  /** "n/total" match counter label, or null when the box is empty. */
  matchLabel: string | null;
  onSearchZoom: () => void;
  onExportPng: () => void;
  onExportSvg: () => void;
  onCopyImage: () => void;
  onCopySql: () => void;
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

      {/* Search-in-diagram */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/60" />
        <Input
          value={props.search}
          onChange={(e) => props.onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              props.onSearchZoom();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              props.onSearchChange("");
            }
          }}
          placeholder={t("er.toolbar.search")}
          aria-label={t("er.toolbar.search")}
          className="h-6 w-40 border-none bg-transparent pl-6 pr-7 text-xs focus-visible:ring-1"
        />
        {props.search && (
          <button
            type="button"
            aria-label={t("er.toolbar.searchClear")}
            onClick={() => props.onSearchChange("")}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent"
          >
            <X className="size-3" />
          </button>
        )}
      </div>
      {props.matchLabel && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {props.matchLabel}
        </span>
      )}

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
                <FileCode data-icon="inline-start" />
                {t("er.toolbar.exportSvg")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={props.onCopyImage}>
                <Copy data-icon="inline-start" />
                {t("er.toolbar.copyImage")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={props.onCopySql}>
                <ClipboardCopy data-icon="inline-start" />
                {t("er.toolbar.copySql")}
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
