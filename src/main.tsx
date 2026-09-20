import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";

import App from "./App";
import { isTauri } from "./lib/platform";
import { queryClient } from "./lib/query-client";
import { applyTheme, useUiStore } from "./stores/ui";
import "./index.css";

// Apply the persisted theme preference (default: follow the OS appearance)
// to <html> before first paint.
applyTheme(useUiStore.getState().theme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);

// The window is created hidden (tauri.conf.json `visible: false`) so the
// window-state plugin restores geometry invisibly — a restore across Spaces
// or monitors would otherwise read as the window closing and reopening, and
// the unpainted webview as a white flash. The Rust side shows the window
// when the page finishes loading (primary path): on macOS WKWebView
// suspends rAF for a hidden webview, so this double-rAF show would never
// fire. It stays as the earlier trigger on platforms where hidden-window
// rAF does run; show/setFocus are idempotent either way.
if (isTauri) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const win = getCurrentWindow();
      void win.show();
      void win.setFocus();
    }),
  );
}
