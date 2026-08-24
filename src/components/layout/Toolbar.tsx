import {
  Activity,
  Cable,
  ChevronDown,
  FileCode,
  FileUp,
  Moon,
  Plus,
  RefreshCw,
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
import { dispatchAction } from "@/lib/shortcuts";
import { openImportWizard } from "@/stores/import-dialog";
import { openFindTextDialog } from "@/stores/find-dialog";
import { useConnectionStore } from "@/stores/connection";
import { useUiStore } from "@/stores/ui";
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
        variant="outline"
        size="xs"
        className="rounded-r-none border-r-0"
        onClick={() => openTab("query")}
      >
        <Plus data-icon="inline-start" />
        <span>{t("toolbar.newQuery")}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon-xs" className="rounded-l-none">
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

export function Toolbar() {
  const theme = useUiStore((s) => s.theme);
  const sessionManagerOpen = useUiStore((s) => s.sessionManagerOpen);
  const setSessionManagerOpen = useUiStore((s) => s.setSessionManagerOpen);
  const status = useConnectionStore((s) => s.status);
  const connId = useConnectionStore((s) => s.connId);
  const dialect = useConnectionStore((s) => s.serverInfo?.dialect ?? null);
  const sessionColor = useConnectionStore((s) => s.session?.color ?? null);

  // Server tools exist on MySQL/PostgreSQL only (P7 scope: SQLite skipped).
  const serverToolsReady = status === "connected" && connId !== null && dialect !== "sqlite";

  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b bg-background px-2">
      {/* Logo placeholder */}
      <div className="mr-1 flex items-center gap-2">
        <div className="flex size-5 items-center justify-center rounded bg-primary text-primary-foreground">
          <Cable className="size-3.5" />
        </div>
        <span className="text-sm font-semibold tracking-tight">HeidiClone</span>
      </div>

      <Separator orientation="vertical" className="mx-1 h-5!" />

      <Button
        variant="ghost"
        size="xs"
        onClick={() => setSessionManagerOpen(true)}
        aria-label={t("toolbar.connect")}
      >
        <Cable data-icon="inline-start" />
        {t("toolbar.connect")}
        {/* Session color dot accent (Phase 9-B) */}
        {status === "connected" && sessionColor && (
          <span
            aria-hidden
            className="ml-0.5 size-2 rounded-full border border-black/10"
            style={{ backgroundColor: sessionColor }}
          />
        )}
      </Button>

      <NewTabMenu />

      {/* Shared action path with shortcuts + native menu */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            aria-label={t("toolbar.refresh")}
            onClick={() => void dispatchAction("tree.refresh")}
          >
            <RefreshCw data-icon="inline-start" />
            {t("toolbar.refresh")}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("toolbar.refresh")} (Ctrl+R)</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            disabled={status !== "connected" || connId === null}
            onClick={() => connId !== null && openImportWizard({ connId })}
          >
            <FileUp data-icon="inline-start" />
            {t("toolbar.import")}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("toolbar.importHint")}</TooltipContent>
      </Tooltip>

      {/* ---- server tools (MySQL / PostgreSQL only) ---- */}
      {serverToolsReady && (
        <>
          <Separator orientation="vertical" className="mx-1 h-5!" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("toolbar.users")}
                onClick={() => connId !== null && openServerToolTab(connId, "users")}
              >
                <Users data-icon="inline-start" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("toolbar.users")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("toolbar.processes")}
                onClick={() => connId !== null && openServerToolTab(connId, "processes")}
              >
                <Activity data-icon="inline-start" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("toolbar.processes")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("toolbar.variables")}
                onClick={() => connId !== null && openServerToolTab(connId, "variables")}
              >
                <SlidersHorizontal data-icon="inline-start" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("toolbar.variables")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("toolbar.findText")}
                onClick={() => connId !== null && openFindTextDialog({ connId })}
              >
                <TextSearch data-icon="inline-start" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("toolbar.findTextHint")}</TooltipContent>
          </Tooltip>
        </>
      )}

      <div className="ml-auto flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => void dispatchAction("view.toggle-theme")}
              aria-label={t("toolbar.toggleTheme")}
            >
              {theme === "dark" ? <Sun data-icon="inline-start" /> : <Moon data-icon="inline-start" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("toolbar.toggleTheme")}</TooltipContent>
        </Tooltip>
      </div>

      <SessionManagerDialog open={sessionManagerOpen} onOpenChange={setSessionManagerOpen} />
    </header>
  );
}
