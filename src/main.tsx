import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";

import App from "./App";
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
