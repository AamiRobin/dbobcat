import { useEffect, useState } from "react";

import { ipc } from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { notify } from "@/lib/toast";
import type { SavedSession } from "@/types/ipc";

/**
 * MCP agent-access policy (Phase 13) — the GUI's view of the `"mcp"` key in
 * settings.json, which the headless `dbobcat mcp` server re-reads on every
 * request. The Rust side owns the enforcement (`src-tauri/src/mcp/`); this
 * module only flips the switches. Anything unreadable counts as "closed".
 */

export interface McpPolicy {
  enabled: boolean;
  allowed: string[];
}

const MCP_KEY = "mcp";

export async function fetchMcpPolicy(): Promise<McpPolicy> {
  try {
    const value = await ipc<unknown>("app_settings_get", { key: MCP_KEY });
    if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      return {
        enabled: v.enabled === true,
        allowed: Array.isArray(v.allowed) ? v.allowed.filter((x): x is string => typeof x === "string") : [],
      };
    }
  } catch {
    // fall through to closed
  }
  return { enabled: false, allowed: [] };
}

export async function saveMcpPolicy(policy: McpPolicy): Promise<void> {
  try {
    await ipc("app_settings_set", { key: MCP_KEY, value: policy as unknown as Record<string, unknown> });
  } catch (err) {
    console.warn("mcp policy save failed:", err);
    notify.error(t("ai.mcp.saveError"));
  }
}

/** Sessions available for the allowlist (metadata only). */
export async function fetchSessionsForMcp(): Promise<SavedSession[]> {
  try {
    const sessions = await ipc<SavedSession[]>("session_list");
    return sessions;
  } catch {
    return [];
  }
}

/** Small hook wrapper so the dialog stays declarative. */
export function useMcpPolicy(open: boolean) {
  const [policy, setPolicy] = useState<McpPolicy>({ enabled: false, allowed: [] });
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([fetchMcpPolicy(), fetchSessionsForMcp()]).then(([p, s]) => {
      if (cancelled) return;
      setPolicy(p);
      setSessions(s);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const update = (next: McpPolicy) => {
    setPolicy(next);
    void saveMcpPolicy(next);
  };

  return { policy, sessions, loaded, update };
}
