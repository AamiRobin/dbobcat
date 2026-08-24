/**
 * DB-tree filter matching (Phase 9-B). The tree filter box accepts a plain
 * substring OR a JavaScript regex; an invalid regex falls back to literal
 * substring matching so typing "users(" never breaks the tree. Pure logic,
 * unit-tested in `tree-filter.test.ts`.
 */

export interface TreeMatcher {
  /** True when `name` should stay visible under this pattern. */
  matches: (name: string) => boolean;
  /** How the pattern was interpreted — surfaced as the input's hint. */
  mode: "regex" | "substring";
}

/**
 * Compile the filter text. Empty/whitespace-only patterns yield `null`
 * (= no filtering, normal lazy tree).
 */
export function compileTreeFilter(pattern: string): TreeMatcher | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;

  try {
    const re = new RegExp(trimmed, "i");
    return { matches: (name) => re.test(name), mode: "regex" };
  } catch {
    return {
      matches: (name) => name.toLowerCase().includes(trimmed.toLowerCase()),
      mode: "substring",
    };
  }
}
