/**
 * Launch-intent handling (Phase 8).
 *
 * A second process instance (`murmeli --connect <session>` /
 * `--new-query [session]`) parks its CLI intent in Rust managed state and
 * pings `app://launch-intent`. The frontend pulls it once at mount via
 * `app_take_launch_intent`, resolves the target session, connects, and
 * optionally opens a fresh Query tab.
 */

import { ipc, onBackendEvent } from "@/lib/ipc";
import { log } from "@/stores/log";
import { useConnectionStore } from "@/stores/connection";
import { useUiStore } from "@/stores/ui";
import { openTab } from "@/stores/tabs";
import type { SavedSession } from "@/types/ipc";

interface LaunchIntent {
  sessionId: string | null;
  sessionName: string | null;
  newQuery: boolean;
}

/**
 * Resolve a session by id first, then by unique name. Ambiguous or missing
 * names return null so the caller can surface the session manager instead.
 */
function resolveSession(
  sessions: SavedSession[],
  intent: LaunchIntent,
): SavedSession | null {
  if (intent.sessionId) {
    const byId = sessions.find((s) => s.id === intent.sessionId);
    if (byId) return byId;
  }
  const name = intent.sessionName?.trim();
  if (!name) return null;
  const matches = sessions.filter((s) => s.name === name);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    log("error", `Session “${name}” is ambiguous (${matches.length} saved sessions share this name). Pick one in the session manager.`);
    return null;
  }
  log("error", `No saved session named “${name}”.`);
  return null;
}

async function applyIntent(intent: LaunchIntent): Promise<void> {
  const hasTarget = intent.sessionId !== null || intent.sessionName !== null;

  let session: SavedSession | null = null;
  if (hasTarget) {
    try {
      const sessions = await ipc<SavedSession[]>("session_list");
      session = resolveSession(sessions, intent);
    } catch (err) {
      log("error", `Could not load saved sessions for launch intent: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!session) {
      useUiStore.getState().setSessionManagerOpen(true);
      return;
    }
  }

  if (intent.newQuery && !hasTarget) {
    // `--new-query` with no session: just a fresh tab on whatever is open.
    openTab("query");
    return;
  }

  if (session) {
    const ok = await useConnectionStore.getState().connectSession({
      id: session.id,
      name: session.name,
      dbType: session.dbType,
      host: session.host,
      port: session.port,
      user: session.user,
    });
    if (!ok) return; // connectSession already logged the failure
  }

  if (intent.newQuery) openTab("query");
}

/**
 * Pull and apply the pending launch intent (if any), and listen for
 * single-instance handoff events. Returns a cleanup fn; call at app
 * bootstrap. Idempotent: the parked intent is consumed exactly once.
 */
export function consumeLaunchIntent(): () => void {
  const unlistenIntent = onBackendEvent<unknown>("app://launch-intent", () => {
    void ipc<LaunchIntent | null>("app_take_launch_intent").then((intent) => {
      if (intent) void applyIntent(intent);
    });
  });

  void ipc<LaunchIntent | null>("app_take_launch_intent")
    .then((intent) => {
      if (intent) return applyIntent(intent);
    })
    .catch((err) => {
      // Older backend without the command — non-fatal.
      log("warn", `Launch intent unavailable: ${err instanceof Error ? err.message : String(err)}`);
    });

  return () => {
    void unlistenIntent.then((fn) => fn()).catch(() => {});
  };
}
