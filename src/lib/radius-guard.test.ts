import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Radius policy guard: every `rounded-*` class in src must come from the
 * theme scale so corners stay consistent app-wide. The scale derives from
 * `--radius` (index.css): sm 6px, md 8px, lg 10px, xl 14px.
 *
 *   rounded-sm   micro elements only (kbd, tooltips, menu items, tab close,
 *                tiny hover targets, chips/badges)
 *   rounded-md   all working-surface chrome (buttons, inputs, selects, tree
 *                rows, tab items, grid controls)
 *   rounded-lg   floating overlays (popovers, dropdown menus, command palette)
 *   rounded-xl   dialogs
 *   rounded-full pills/chips/scrollbars; directional -none for attached edges
 *
 * Bare `rounded` (Tailwind's fixed 4px default) and hand-rolled
 * `rounded-[calc(...)]` bypass the scale — they silently desync from
 * `--radius` — so this guard fails on them, same spirit as version-sync.
 */

const ALLOWED = new Set([
  "rounded-sm",
  "rounded-md",
  "rounded-lg",
  "rounded-xl",
  "rounded-2xl",
  "rounded-3xl",
  "rounded-4xl",
  "rounded-full",
  "rounded-none",
  // shadcn primitive size clamps: resolve to --radius-md (8px) at runtime
  "rounded-[min(var(--radius-md),10px)]",
  "rounded-[min(var(--radius-md),12px)]",
  // scroll-area track inherits its container; tooltip arrow is a rotated square
  "rounded-[inherit]",
  "rounded-[2px]",
]);

const DIRECTIONS = new Set(["t", "b", "l", "r", "tl", "tr", "bl", "br", "s", "e", "ss", "se", "es", "ee"]);
const SUFFIXES = new Set(["sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "full", "none"]);

/** Class tokens can carry variant prefixes (hover:, data-[...]:, dark:…)
 * and suffixes (important "!"); prose may quote a class with punctuation. */
function normalize(token: string): string {
  let t = token.slice(token.lastIndexOf(":") + 1);
  while (t.length > 0 && /[;),.:"']$/.test(t)) t = t.slice(0, -1);
  return t.endsWith("!") ? t.slice(0, -1) : t;
}

function isAllowed(token: string): boolean {
  const t = normalize(token);
  if (ALLOWED.has(t)) return true;
  const m = t.match(/^rounded-([a-z]+)-([a-z0-9]+)$/);
  return m !== null && DIRECTIONS.has(m[1]) && SUFFIXES.has(m[2]);
}

/** Tokens that look like a radius class on this line. */
function radiusTokens(line: string): string[] {
  return line
    .split(/[\s"'`{}]+/)
    .filter((tok) => tok.includes("rounded"))
    .map(normalize)
    .filter((tok) => tok.startsWith("rounded"));
}

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsx(full));
    } else if ((entry.endsWith(".tsx") || entry.endsWith(".ts")) && !entry.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

describe("radius policy", () => {
  test("every rounded-* class comes from the theme scale", () => {
    const violations: string[] = [];
    for (const file of walkTsx(join(import.meta.dir, ".."))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const tok of radiusTokens(line)) {
          if (!isAllowed(tok)) violations.push(`${file}:${i + 1}: ${tok}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
