import {
  Activity,
  Braces,
  Clock,
  Eye,
  FileCode,
  Network,
  Plus,
  Sigma,
  SlidersHorizontal,
  Table,
  Users,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useTabsStore, type TabType } from "@/stores/tabs";

export const TAB_ICONS: Record<TabType, LucideIcon> = {
  query: FileCode,
  data: Table,
  designer: Workflow,
  diagram: Network,
  object: Braces,
  users: Users,
  processes: Activity,
  variables: SlidersHorizontal,
};

/** Per-object tab icons resolved from the serializable `tab.icon` key. */
const ICON_BY_KEY: Record<string, LucideIcon> = {
  braces: Braces,
  sigma: Sigma,
  zap: Zap,
  clock: Clock,
  eye: Eye,
  network: Network,
  users: Users,
  activity: Activity,
  "sliders-horizontal": SlidersHorizontal,
};

function CloseButton({ id, active }: { id: string; active: boolean }) {
  const closeTab = useTabsStore((s) => s.closeTab);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={t("tabs.close")}
      title={t("tabs.close")}
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation();
        closeTab(id);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "-mr-1 size-4 rounded-sm text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/tab:opacity-100",
        active && "opacity-100",
      )}
    >
      <X />
    </Button>
  );
}

/** Horizontal tab strip backed by the tabs store. */
export function TabsBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const setActive = useTabsStore((s) => s.setActive);
  const openTab = useTabsStore((s) => s.openTab);

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-0.5 border-b bg-muted/40 px-1">
      <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const Icon =
            ICON_BY_KEY[tab.icon] ?? TAB_ICONS[tab.type] ?? FileCode;
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => setActive(tab.id)}
              onKeyDown={(e) => e.key === "Enter" && setActive(tab.id)}
              className={cn(
                "group/tab my-1 flex cursor-default select-none items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium outline-none transition-colors",
                active
                  ? "border-border bg-background text-foreground shadow-xs"
                  : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon
                className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")}
              />
              <span className="truncate">{tab.title}</span>
              {tab.closable && <CloseButton id={tab.id} active={active} />}
            </div>
          );
        })}
      </div>

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="my-1 self-center" aria-label={t("tabs.newTab")}>
                <Plus />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("tabs.newTabHint")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => openTab("query")}>
            <FileCode data-icon="inline-start" />
            {t("tabs.newQuery")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openTab("data")}>
            <Table data-icon="inline-start" />
            {t("tabs.newData")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openTab("designer")}>
            <Workflow data-icon="inline-start" />
            {t("tabs.newDesigner")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
