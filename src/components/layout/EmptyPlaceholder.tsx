import { Plus, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { t } from "@/lib/i18n";
import { useTabsStore } from "@/stores/tabs";

/** Shared empty-state body for panels and tab placeholders. */
export function EmptyPlaceholder({
  icon: Icon,
  title,
  hint,
  action = false,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: boolean;
}) {
  const openTab = useTabsStore((s) => s.openTab);

  return (
    <Empty className="h-full select-none">
      <EmptyHeader>
        <EmptyMedia>
          <Icon className="size-8 text-muted-foreground/40" strokeWidth={1.5} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {hint && <EmptyDescription>{hint}</EmptyDescription>}
      </EmptyHeader>
      {action && (
        <EmptyContent>
          <Button variant="outline" size="xs" onClick={() => openTab("query")}>
            <Plus data-icon="inline-start" />
            {t("empty.newQuery.button")}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}
