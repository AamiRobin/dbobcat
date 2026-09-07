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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";
import { dispatchAction, formatCombo } from "@/lib/shortcuts";
import { openImportWizard } from "@/stores/import-dialog";
import { openFindTextDialog } from "@/stores/find-dialog";
import { useConnectionStore } from "@/stores/connection";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { openServerToolTab, openTab, type TabType } from "@/stores/tabs";

function NewTabMenu() {
  const items: { type: TabType; label: string; icon: typeof FileCode }[] = [
    { type: "query", label: t("tabs.newQuery"), icon: FileCode },
    { type: "data", label: t("tabs.newData"), icon: Table },
    { type: "designer", label: t("tabs.newDesigner"), icon: Workflow },
  ];

  return (
    <div className="flex items-center">
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 rounded-r-none"
        onClick={() => openTab("query")}
      >
        <Plus />
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
        <DropdownMenuContent align="start" className="w-44">
          {items.map(({ type, label, icon: Icon }) => (
            <DropdownMenuItem key={type} onClick={() => openTab(type)}>
              <Icon data-icon="inline-start" />
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function DBobcatGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden>
      {/* den mound */}
      <rect x="3" y="17.5" width="18" height="4.5" rx="2.25" />
      {/* body + head + tufted ears */}
      <path d="M8.6 6.6 8 1.6l2.4 3Z" />
      <path d="M15.4 6.6 16 1.6l-2.4 3Z" />
      <circle cx="12" cy="8" r="3.9" />
      <path d="M12 7c-3 0-5 2-6.2 4.8-.9 2.1-1.1 3.9-1.1 5.7h14.6c0-1.8-.2-3.6-1.1-5.7C17 9 15 7 12 7Z" />
    </svg>
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
  // other platforms keep the native title bar, so no extra inset is needed.
  const trafficLightInset = /Mac/i.test(navigator.userAgent) ? "pl-[78px]" : "";

  return (
    <header
      // "deep": any non-clickable header area drags the window, including the
      // brand cluster — buttons/links opt out automatically.
      data-tauri-drag-region="deep"
      className={cn(
        "flex h-11 shrink-0 items-center gap-2 border-b bg-muted/30 px-2",
        trafficLightInset,
      )}
    >
      {/* Brand */}
      <div className="flex items-center gap-2 pr-1">
        <div className="flex size-6 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground">
          <DBobcatGlyph />
        </div>
        <span className="text-[13px] font-semibold tracking-tight">DBobcat</span>
      </div>

      <Separator orientation="vertical" className="h-5" />

      {/* Primary actions — connected, refresh, import, new tab */}
      <div
        data-slot="button-group"
        className="flex h-7 items-center rounded-md border bg-background p-0.5 shadow-xs"
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSessionManagerOpen(true)}
          aria-label={t("toolbar.connect")}
          className="gap-1.5"
        >
          <Cable />
          {t("toolbar.connect")}
        </Button>

        <Separator orientation="vertical" className="h-4" />

        <NewTabMenu />

        <Separator orientation="vertical" className="h-4" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("toolbar.refresh")}
              onClick={() => void dispatchAction("tree.refresh")}
              className="gap-1.5"
            >
              <RefreshCw />
              {t("toolbar.refresh")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("toolbar.refresh")} ({formatCombo("Ctrl+R")})
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
              <FileUp />
              {t("toolbar.import")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("toolbar.importHint")}</TooltipContent>
        </Tooltip>
      </div>

      {/* Server tools — only on MySQL / PostgreSQL */}
      {serverToolsReady && (
        <>
          <Separator orientation="vertical" className="h-5" />
          <div
            data-slot="button-group"
            className="flex h-7 items-center rounded-md border bg-background p-0.5 shadow-xs"
          >
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
          </div>
        </>
      )}

      {/* Trailing utility cluster */}
      <div className="ml-auto flex items-center">
        <div
          data-slot="button-group"
          className="flex h-7 items-center rounded-md border bg-background p-0.5 shadow-xs"
        >
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
              {t("toolbar.palette")} ({formatCombo("Mod+K")})
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
        </div>
      </div>

      <SessionManagerDialog
        open={sessionManagerOpen}
        onOpenChange={setSessionManagerOpen}
        initialSelectedId={sessionManagerSelectId}
      />
    </header>
  );
}
