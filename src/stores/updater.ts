import { create } from "zustand";

import { notify } from "@/lib/toast";
import { log } from "@/stores/log";

/**
 * In-app auto-update state. The Tauri updater plugin only exists in signed
 * release builds (see `tauri.updater.conf.json` + `release.yml`); everywhere
 * else `check` fails and the store stays idle.
 *
 * `check` talks to the update feed and, when a newer version exists, flips
 * the status so the status bar can show an "Update" button. `install`
 * downloads + installs and offers a restart. The `Update` object itself is
 * kept module-side: it is a live handle, not serializable state.
 */
export type UpdateStatus = "idle" | "available" | "downloading" | "ready";

interface UpdaterState {
  status: UpdateStatus;
  /** Version the chip would install; null while idle. */
  version: string | null;
  /** 0–100 while downloading; null otherwise. */
  progress: number | null;
  check: (opts?: { silent?: boolean }) => Promise<void>;
  install: () => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pendingUpdate: any = null;
let inFlight: Promise<void> | null = null;

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: "idle",
  version: null,
  progress: null,

  check: async (opts) => {
    const silent = opts?.silent ?? false;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (!update) {
          if (!silent) notify.info("You are up to date.");
          return;
        }
        pendingUpdate = update;
        set({ status: "available", version: update.version });
        notify.info(`Update ${update.version} is available — see the button in the status bar.`);
      } catch (err) {
        // Dev/browser builds have no updater config; only the explicit menu
        // action should explain why.
        if (!silent) {
          const message = err instanceof Error ? err.message : String(err);
          log("warn", `Auto-update unavailable (${message}). Release builds bundle the updater endpoint.`);
        }
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  install: async () => {
    const update = pendingUpdate;
    if (!update || get().status === "downloading") return;
    set({ status: "downloading", progress: 0 });
    try {
      // DownloadEvent: Started{contentLength} → Progress{chunkLength}* → Finished.
      let contentLength = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event: { event: string; data: { contentLength?: number; chunkLength?: number } }) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          downloaded = 0;
          set({ progress: 0 });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength ?? 0;
          set({
            progress: contentLength
              ? Math.min(100, Math.round((downloaded / contentLength) * 100))
              : null,
          });
        } else if (event.event === "Finished") {
          set({ progress: 100 });
        }
      });
      set({ status: "ready" });
      notify.success(`Update ${update.version} installed.`);
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      const restart = await confirm("Update installed. Restart now?", {
        title: "Restart DBobcat",
        kind: "info",
      });
      if (restart) {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      }
    } catch (err) {
      set({ status: "available", progress: null });
      const message = err instanceof Error ? err.message : String(err);
      notify.error(`Update failed: ${message}`);
    }
  },
}));
