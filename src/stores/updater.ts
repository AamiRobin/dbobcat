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
// Dedupes concurrent checks, keyed by `silent`: a manual check must not join
// the silent startup check, or it loses its "up to date" toast / warn log.
const inFlightChecks = new Map<boolean, Promise<void>>();
// The running install() promise. Status alone can't dedupe installs: two
// callers can both observe "available" before either flips it to "downloading".
let installInFlight: Promise<void> | null = null;

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: "idle",
  version: null,
  progress: null,

  check: async (opts) => {
    const silent = opts?.silent ?? false;
    // A running install owns the Update handle: re-querying the feed here
    // would clobber "downloading"/"ready" and let a second downloadAndInstall()
    // race on the same handle.
    if (get().status === "downloading" || get().status === "ready") return;

    const existing = inFlightChecks.get(silent);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (!update) {
          if (!silent) notify.info("You are up to date.");
          return;
        }
        // The feed call races the install button: once an install has started
        // (or finished) this check is moot. Update handles are Rust-side
        // Resources — a discarded one must be close()d, not leaked — but only
        // the freshly fetched one: closing the handle a running install holds
        // would abort the download.
        if (
          installInFlight !== null ||
          get().status === "downloading" ||
          get().status === "ready"
        ) {
          await update.close().catch(() => {});
          return;
        }
        // Grab the superseded handle, but close it only after the apply:
        // awaiting close() first would let an install click capture the
        // handle being closed and abort its download. Applied first, install()
        // can only ever capture the newly assigned handle, so closing the old
        // one is safe at any timing.
        const previous = pendingUpdate;
        // Final guard. No await past this point — synchronous guard+apply is
        // atomic against the event loop, and an install may have slipped in
        // during the fresh-handle close above.
        if (
          installInFlight !== null ||
          get().status === "downloading" ||
          get().status === "ready"
        ) {
          await update.close().catch(() => {});
          return;
        }
        pendingUpdate = update;
        set({ status: "available", version: update.version });
        notify.info(`Update ${update.version} is available — see the button in the status bar.`);
        if (previous && previous !== update) void previous.close().catch(() => {});
      } catch (err) {
        // Dev/browser builds have no updater config; only the explicit menu
        // action should explain why.
        if (!silent) {
          const message = err instanceof Error ? err.message : String(err);
          log("warn", `Auto-update unavailable (${message}). Release builds bundle the updater endpoint.`);
        }
      } finally {
        inFlightChecks.delete(silent);
      }
    })();
    inFlightChecks.set(silent, promise);
    return promise;
  },

  install: async () => {
    if (installInFlight) return;
    const update = pendingUpdate;
    if (!update) return;
    installInFlight = (async () => {
      try {
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
        } catch (err) {
          set({ status: "available", progress: null });
          const message = err instanceof Error ? err.message : String(err);
          notify.error(`Update failed: ${message}`);
          return;
        }
        // Flip to "ready" before prompting: only the download is failure-
        // isolated. A confirm()/relaunch() failure below must not reset the
        // chip to "available" — the update is already on disk.
        set({ status: "ready" });
        notify.success(`Update ${update.version} installed.`);
        try {
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
          const message = err instanceof Error ? err.message : String(err);
          log("warn", `Update ${update.version} is installed, but the restart prompt failed (${message}).`);
        }
      } finally {
        installInFlight = null;
      }
    })();
  },
}));
