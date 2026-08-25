import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const pkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./package.json", import.meta.url)),
    "utf8",
  ),
) as { version: string };

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  resolve: {
    alias: {
      "@": path.resolve(fileURLToPath(new URL("./src", import.meta.url))),
    },
  },

  build: {
    rollupOptions: {
      output: {
        // Pin the heavyweight editor/formatter stacks into their own chunks
        // so they load with the first query tab instead of the entry bundle.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("sql-formatter")) return "sql-formatter";
          // Dagre rides the lazy DiagramView chunk, not the entry bundle.
          if (id.includes("@dagrejs") || id.includes("dagre")) return "dagre";
          if (
            id.includes("@codemirror") ||
            id.includes("@uiw") ||
            id.includes("codemirror")
          ) {
            return "codemirror";
          }
          // React runtime stays eager but separate from application code.
          if (
            /node_modules\/(react|react-dom|scheduler)\//.test(id) ||
            id.includes("node_modules/react/")
          ) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
