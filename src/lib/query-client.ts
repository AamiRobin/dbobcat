import { QueryClient } from "@tanstack/react-query";

/**
 * Query client tuned for an IPC-backed desktop app:
 *  - no refetchOnWindowFocus (the webview never loses focus like a browser);
 *  - modest retry policy: IPC errors are usually deterministic (SQL/syntax),
 *    unlike flaky network requests;
 *  - short staleTime keeps tree/data grids snappy without hammering the DB.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
    },
    mutations: {
      retry: 0,
    },
  },
});
