import { useEffect } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AboutDialog } from "@/components/layout/AboutDialog";
import { ShortcutsDialog } from "@/components/layout/ShortcutsDialog";
import { DbTree } from "@/components/db-tree/DbTree";
import { MessageLog } from "@/components/layout/MessageLog";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
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
import {
  installTxStatusListener,
  shouldAskOnQuit,
  useTransactionStore,
} from "@/stores/transaction";
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
const CommandPalette = lazy(() =>
  import("@/components/palette/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
const TxAskDialog = lazy(() =>
  import("@/components/common/TxAskDialog").then((m) => ({ default: m.TxAskDialog })),
);

function EditorArea() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const active = tabs.find((t) => t.id === activeId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabsBar />
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        {/* Tab bodies remount per switch (key); a short fade softens the swap. */}
        {active ? (
          <div key={active.id} className="h-full animate-in fade-in-0 duration-150">
            <TabContent tab={active} />
          </div>
        ) : (
          <NoTabsPlaceholder />
        )}
      </div>
    </div>
  );
}

function MainSplit() {
  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0">
      {/* Sidebar tokens (not plain background) so the tree panel reads as a
          distinct layer over the editor/log area, VS Code-style. */}
      <ResizablePanel
        defaultSize="22"
        minSize="10"
        className="border-r border-sidebar-border bg-sidebar"
      >
        <DbTree />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize="30">
        <ResizablePanelGroup orientation="vertical" className="min-h-0">
          <ResizablePanel minSize="20">
            <EditorArea />
          </ResizablePanel>
          <ResizableHandle />
          {/*
            The log panel stays a fixed-height strip while "collapsed" — the
            chevron in MessageLog's header toggles the store flag; drag-resize
            still works between minSize and defaultSize.
          */}
          <ResizablePanel defaultSize="26" minSize="7">
            <MessageLog />
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
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
      log("info", `DBobcat v${__APP_VERSION__} started.`);
      void checkBackend();
      restoreTabs();
    }
    // Listeners/subscriptions are per-effect-cycle so StrictMode's
    // unmount→remount pair always leaves exactly one of each installed.
    const uninstallPersist = installTabPersistence();
    const stopLaunchIntents = consumeLaunchIntent();
    const stopConnStatus = installConnStatusListener();
    const stopTxStatus = installTxStatusListener();
    // Window-close gate (Transactions Phase 1): an open transaction must be
    // resolved before the webview goes away. `onCloseRequested` listens via
    // core:event, covered by the `core:default` capability. Errors are
    // swallowed like every other listener (e.g. running outside Tauri).
    let unlistenClose: (() => void) | null = null;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onCloseRequested((event) => {
          if (shouldAskOnQuit(useTransactionStore.getState().tx)) {
            event.preventDefault();
            useTransactionStore.getState().requestAsk("window-close");
          }
        }),
      )
      .then((fn) => {
        unlistenClose = fn;
      })
      .catch(() => {});
    // Native menu clicks share the shortcut action map.
    const unlistenMenu = onBackendEvent<string>("menu://click", (id) => {
      const action = MENU_ACTIONS[id];
      if (action) void dispatchAction(action);
    });
    return () => {
      uninstallPersist();
      stopLaunchIntents();
      void stopConnStatus.then((fn) => fn());
      void stopTxStatus.then((fn) => fn());
      unlistenClose?.();
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
          <CommandPalette />
          <TxAskDialog />
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
