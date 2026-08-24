import { useEffect } from "react";
import { Group, Panel } from "react-resizable-panels";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AboutDialog } from "@/components/layout/AboutDialog";
import { ShortcutsDialog } from "@/components/layout/ShortcutsDialog";
import { DbTree } from "@/components/db-tree/DbTree";
import { MessageLog } from "@/components/layout/MessageLog";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { StatusBar } from "@/components/layout/StatusBar";
import { TabContent, NoTabsPlaceholder } from "@/components/layout/TabContent";
import { TabsBar } from "@/components/layout/TabsBar";
import { Toolbar } from "@/components/layout/Toolbar";
import { onBackendEvent, ipc } from "@/lib/ipc";
import { consumeLaunchIntent } from "@/lib/launch";
import { dispatchAction, useShortcuts } from "@/lib/shortcuts";
import { installTabPersistence, restoreTabs } from "@/lib/tab-restore";
import { installConnStatusListener } from "@/stores/connection";
import { log } from "@/stores/log";
import { useTabsStore } from "@/stores/tabs";

// Heavy global dialogs load on demand (Phase 8 bundle hygiene); their open
// state lives in stores, so a not-yet-loaded dialog simply renders nothing.
import { lazy, Suspense } from "react";
const ExportDialog = lazy(() =>
  import("@/components/export/ExportDialog").then((m) => ({ default: m.ExportDialog })),
);
const ImportWizard = lazy(() =>
  import("@/components/import/ImportWizard").then((m) => ({ default: m.ImportWizard })),
);
const FindTextDialog = lazy(() =>
  import("@/components/server/FindTextDialog").then((m) => ({ default: m.FindTextDialog })),
);

function EditorArea() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const active = tabs.find((t) => t.id === activeId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabsBar />
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        {active ? <TabContent key={active.id} tab={active} /> : <NoTabsPlaceholder />}
      </div>
    </div>
  );
}

function MainSplit() {
  return (
    <Group orientation="horizontal" className="min-h-0">
      <Panel defaultSize="22" minSize="10" className="border-r">
        <DbTree />
      </Panel>
      <ResizeHandle />
      <Panel minSize="30">
        <Group orientation="vertical" className="min-h-0">
          <Panel minSize="20">
            <EditorArea />
          </Panel>
          <ResizeHandle direction="vertical" />
          {/*
            The log panel stays a fixed-height strip while "collapsed" — the
            chevron in MessageLog's header toggles the store flag; drag-resize
            still works between minSize and defaultSize.
          */}
          <Panel defaultSize="26" minSize="7">
            <MessageLog />
          </Panel>
        </Group>
      </Panel>
    </Group>
  );
}

/** Prove the IPC round-trip works and surface it in the message log. */
async function checkBackend() {
  try {
    const reply = await ipc<string>("ping");
    log("success", `Backend ready — ${reply}`);
  } catch (err) {
    log("error", `Backend health check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Guards against React StrictMode double-invoking the mount effect in dev.
let bootstrapped = false;

export default function App() {
  // One capture-phase listener owns every keyboard shortcut (F9 outside the
  // editor, Ctrl+T/W/R/Q/O/Tab, find-text, …).
  useShortcuts();

  useEffect(() => {
    // One-time bootstrap (guarded against StrictMode double-mount).
    if (!bootstrapped) {
      bootstrapped = true;
      log("info", `HeidiClone v${__APP_VERSION__} started.`);
      void checkBackend();
      restoreTabs();
    }
    // Listeners/subscriptions are per-effect-cycle so StrictMode's
    // unmount→remount pair always leaves exactly one of each installed.
    const uninstallPersist = installTabPersistence();
    const stopLaunchIntents = consumeLaunchIntent();
    const stopConnStatus = installConnStatusListener();
    // Native menu clicks share the shortcut action map.
    const unlistenMenu = onBackendEvent<string>("menu://click", (id) => {
      const action = MENU_ACTIONS[id];
      if (action) void dispatchAction(action);
    });
    return () => {
      uninstallPersist();
      stopLaunchIntents();
      void stopConnStatus.then((fn) => fn());
      void unlistenMenu.then((fn) => fn());
    };
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full w-full flex-col overflow-hidden">
        <Toolbar />
        <main className="min-h-0 flex-1">
          <MainSplit />
        </main>
        <StatusBar />
        {/* Global dialogs, driven by their stores; bodies load on demand */}
        <Suspense fallback={null}>
          <ExportDialog />
          <ImportWizard />
          <FindTextDialog />
        </Suspense>
        <ShortcutsDialog />
        <AboutDialog />
        {/* Action-feedback toasts (theme synced via the ui store) */}
        <Toaster position="bottom-right" />
      </div>
    </TooltipProvider>
  );
}

/** Native-menu item id → shared action id (see src-tauri lib.rs menu). */
const MENU_ACTIONS: Record<string, string> = {
  "menu-session-manager": "session-manager.open",
  "menu-new-query": "tab.new-query",
  "menu-quit": "app.quit",
  "menu-toggle-theme": "view.toggle-theme",
  "menu-toggle-log": "view.toggle-log",
  "menu-refresh-tree": "tree.refresh",
  "menu-shortcuts": "help.shortcuts",
  "menu-check-updates": "help.check-updates",
  "menu-about": "help.about",
};
