import { Suspense, lazy } from "react";
import { Cable, FileCode, PlugZap } from "lucide-react";

import { DataView } from "@/components/data/DataView";
import { EmptyPlaceholder } from "@/components/layout/EmptyPlaceholder";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { t } from "@/lib/i18n";
import { useConnectionStore } from "@/stores/connection";
import { useUiStore } from "@/stores/ui";
import type { Tab } from "@/stores/tabs";

/**
 * Tab bodies. Heavy views (CodeMirror, designer, server tools) are
 * lazy-loaded so the initial bundle only carries the data grid; the
 * fallback shows while the chunk streams in.
 */
const QueryView = lazy(() =>
  import("@/components/query/QueryView").then((m) => ({ default: m.QueryView })),
);
const DesignerView = lazy(() =>
  import("@/components/designer/DesignerView").then((m) => ({ default: m.DesignerView })),
);
const DiagramView = lazy(() =>
  import("@/components/diagram/DiagramView").then((m) => ({ default: m.DiagramView })),
);
const ObjectEditorView = lazy(() =>
  import("@/components/objects/ObjectEditorView").then((m) => ({ default: m.ObjectEditorView })),
);
const UserManagerView = lazy(() =>
  import("@/components/server/UserManagerView").then((m) => ({ default: m.UserManagerView })),
);
const ProcessListView = lazy(() =>
  import("@/components/server/ProcessListView").then((m) => ({ default: m.ProcessListView })),
);
const ServerVarsView = lazy(() =>
  import("@/components/server/ServerVarsView").then((m) => ({ default: m.ServerVarsView })),
);

function LazyFallback() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Spinner className="size-5" />
    </div>
  );
}

/** Renders the body of the active tab. */
export function TabContent({ tab }: { tab: Tab }) {
  switch (tab.type) {
    case "query":
      return (
        <Suspense fallback={<LazyFallback />}>
          <QueryView tab={tab} />
        </Suspense>
      );
    case "data":
      return <DataView tab={tab} />;
    case "designer":
      return (
        <Suspense fallback={<LazyFallback />}>
          <DesignerView tab={tab} />
        </Suspense>
      );
    case "diagram":
      return (
        <Suspense fallback={<LazyFallback />}>
          <DiagramView tab={tab} />
        </Suspense>
      );
    case "object":
      return (
        <Suspense fallback={<LazyFallback />}>
          <ObjectEditorView tab={tab} />
        </Suspense>
      );
    case "users":
      return (
        <Suspense fallback={<LazyFallback />}>
          <UserManagerView tab={tab} />
        </Suspense>
      );
    case "processes":
      return (
        <Suspense fallback={<LazyFallback />}>
          <ProcessListView tab={tab} />
        </Suspense>
      );
    case "variables":
      return (
        <Suspense fallback={<LazyFallback />}>
          <ServerVarsView tab={tab} />
        </Suspense>
      );
  }
}

export function NoTabsPlaceholder() {
  const connected = useConnectionStore((s) => s.status === "connected");
  const setSessionManagerOpen = useUiStore((s) => s.setSessionManagerOpen);

  // Heidi-style empty state: until a session is live, invite connecting.
  if (!connected) {
    return (
      <Empty className="h-full select-none">
        <EmptyHeader>
          <EmptyMedia>
            <Cable className="size-10 text-muted-foreground/40" strokeWidth={1.5} />
          </EmptyMedia>
          <EmptyTitle className="text-muted-foreground">
            {t("empty.connect.title")}
          </EmptyTitle>
          <EmptyDescription>{t("empty.connect.hint")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => setSessionManagerOpen(true)}>
            <PlugZap data-icon="inline-start" />
            {t("empty.connect.button")}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <EmptyPlaceholder
      icon={FileCode}
      title={t("empty.noTabs.title")}
      hint={t("empty.noTabs.hint")}
      action
    />
  );
}
