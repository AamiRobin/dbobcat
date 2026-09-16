/**
 * UI geometry preferences (log strip state, panel sizes, grid page size) —
 * localStorage-backed on purpose: they must apply from the first paint, and
 * an async round-trip to the settings file would flash the default layout
 * before restoring. Same storage + `dbobcat.` key style as the theme
 * preference in `stores/ui.ts`; all reads/writes are best-effort.
 */

const PREFIX = "dbobcat.";

function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Read a JSON pref; null when absent or unparsable. */
export function readPref(key: string): unknown {
  try {
    const raw = storage()?.getItem(PREFIX + key);
    return raw == null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    storage()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage unavailable or full — preferences are best-effort
  }
}

/** Read a number pref clamped to `[min, max]`; null when absent/invalid. */
export function readNumberPref(key: string, min: number, max: number): number | null {
  const v = readPref(key);
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}
