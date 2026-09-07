import {
  Activity,
  Cable,
  ChevronDown,
  FileCode,
  FileUp,
  Moon,
  Plus,
  RefreshCw,
  Search,
  TextSearch,
  SlidersHorizontal,
  Sun,
  Table,
  Users,
  Workflow,
} from "lucide-react";

import { SessionManagerDialog } from "@/components/session-manager/SessionManagerDialog";
import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
} from "@/components/ui/button-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";
import { dispatchAction, formatCombo } from "@/lib/shortcuts";
import { openImportWizard } from "@/stores/import-dialog";
import { openFindTextDialog } from "@/stores/find-dialog";
import { useConnectionStore } from "@/stores/connection";
import { useUiStore } from "@/stores/ui";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { openServerToolTab, openTab, type TabType } from "@/stores/tabs";
import { isMac, usesInAppWindowControls } from "@/lib/platform";
import { WindowControls } from "@/components/layout/WindowControls";

function NewTabMenu() {
  const items: { type: TabType; label: string; icon: typeof FileCode }[] = [
    { type: "query", label: t("tabs.newQuery"), icon: FileCode },
    { type: "data", label: t("tabs.newData"), icon: Table },
    { type: "designer", label: t("tabs.newDesigner"), icon: Workflow },
  ];

  return (
    <ButtonGroup className="flex items-center">
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 rounded-r-none"
        onClick={() => openTab("query")}
      >
        <Plus data-icon="inline-start" />
        <span>{t("toolbar.newQuery")}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-l-none"
            aria-label={t("tabs.newTab")}
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            {items.map(({ type, label, icon: Icon }) => (
              <DropdownMenuItem key={type} onClick={() => openTab(type)}>
                <Icon data-icon="inline-start" />
                {label}
              </DropdownMenuItem>
            ))}

          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

export function Toolbar() {
  const theme = useUiStore((s) => s.theme);
  const sessionManagerOpen = useUiStore((s) => s.sessionManagerOpen);
  const sessionManagerSelectId = useUiStore((s) => s.sessionManagerSelectId);
  const setSessionManagerOpen = useUiStore((s) => s.setSessionManagerOpen);
  const status = useConnectionStore((s) => s.status);
  const connId = useConnectionStore((s) => s.connId);
  const dialect = useConnectionStore((s) => s.serverInfo?.dialect ?? null);

  // Server tools exist on MySQL/PostgreSQL only (P7 scope: SQLite skipped).
  const serverToolsReady = status === "connected" && connId !== null && dialect !== "sqlite";

  // macOS draws the traffic lights over the header (titleBarStyle: Overlay);
  // other platforms go frameless and render Windows-style controls on the
  // right instead (see WindowControls).
  const trafficLightInset = isMac ? "pl-[78px]" : "";

  return (
    <header
      // "deep": any non-clickable header area drags the window, including the
      // brand cluster — buttons/links opt out automatically.
      data-tauri-drag-region="deep"
      className={cn(
        "flex h-11 shrink-0 items-center gap-2 border-b bg-muted/40 px-2",
        trafficLightInset,
      )}
    >
      {/* Brand */}
      <div className="flex items-center pr-1">
        <span className="text-[13px] font-semibold tracking-tight">DBobcat</span>
      </div>

      <Separator orientation="vertical" className="h-5" />

      {/* Primary actions — connected, refresh, import, new tab */}
      <ButtonGroup className="h-7 items-center rounded-md border bg-background p-0.5 shadow-xs">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSessionManagerOpen(true)}
          aria-label={t("toolbar.connect")}
          className="gap-1.5"
        >
          <Cable data-icon="inline-start" />
          {t("toolbar.connect")}
        </Button>

        <ButtonGroupSeparator className="h-4 bg-border" />

        <NewTabMenu />

        <ButtonGroupSeparator className="h-4 bg-border" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("toolbar.refresh")}
              onClick={() => void dispatchAction("tree.refresh")}
              className="gap-1.5"
            >
              <RefreshCw data-icon="inline-start" />
              {t("toolbar.refresh")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("toolbar.refresh")} (<Kbd>{formatCombo("Ctrl+R")}</Kbd>)
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={status !== "connected" || connId === null}
              onClick={() => connId !== null && openImportWizard({ connId })}
              className="gap-1.5"
            >
              <FileUp data-icon="inline-start" />
              {t("toolbar.import")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("toolbar.importHint")}</TooltipContent>
        </Tooltip>
      </ButtonGroup>

      {/* Server tools — only on MySQL / PostgreSQL */}
      {serverToolsReady && (
        <>
          <Separator orientation="vertical" className="h-5" />
          <ButtonGroup className="h-7 items-center rounded-md border bg-background p-0.5 shadow-xs">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("toolbar.users")}
                  onClick={() => connId !== null && openServerToolTab(connId, "users")}
                >
                  <Users />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("toolbar.users")}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("toolbar.processes")}
                  onClick={() =>
                    connId !== null && openServerToolTab(connId, "processes")
                  }
                >
                  <Activity />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("toolbar.processes")}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("toolbar.variables")}
                  onClick={() =>
                    connId !== null && openServerToolTab(connId, "variables")
                  }
                >
                  <SlidersHorizontal />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("toolbar.variables")}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("toolbar.findText")}
                  onClick={() => connId !== null && openFindTextDialog({ connId })}
                >
                  <TextSearch />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("toolbar.findTextHint")}</TooltipContent>
            </Tooltip>
          </ButtonGroup>
        </>
      )}

      {/* Trailing utility cluster */}
      <div className="ml-auto flex items-center">
        <ButtonGroup className="h-7 items-center rounded-md border bg-background p-0.5 shadow-xs">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("toolbar.palette")}
                onClick={() => void dispatchAction("palette.open")}
              >
                <Search />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t("toolbar.palette")} (<Kbd>{formatCombo("Mod+K")}</Kbd>)
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void dispatchAction("view.toggle-theme")}
                aria-label={t("toolbar.toggleTheme")}
              >
                {theme === "dark" ? <Sun /> : <Moon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("toolbar.toggleTheme")}</TooltipContent>
          </Tooltip>
        </ButtonGroup>
      </div>

      {usesInAppWindowControls && <WindowControls />}

      <SessionManagerDialog
        open={sessionManagerOpen}
        onOpenChange={setSessionManagerOpen}
        initialSelectedId={sessionManagerSelectId}
      />
    </header>
  );
}
