/**
 * CSV sniffing helpers for the import wizard (pure, unit-tested).
 * The Rust side does the actual parsing; these only drive UI defaults.
 */

const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"] as const;

/**
 * Guess the field delimiter by scoring consistency of occurrence counts on
 * the first lines (outside quoted sections). Falls back to ",".
 */
export function guessDelimiter(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 10);
  if (lines.length === 0) return ",";

  let best = ",";
  let bestScore = -1;
  for (const d of CANDIDATE_DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, d));
    // All non-empty candidates must agree and appear at least once per line.
    if (counts.some((c) => c === 0)) continue;
    const spread = Math.max(...counts) - Math.min(...counts);
    const total = counts.reduce((a, b) => a + b, 0);
    const score = total - spread * 2;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Count occurrences of `needle` outside double-quoted spans. */
function countOutsideQuotes(line: string, needle: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++; // doubled quote stays inside
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && line.startsWith(needle, i)) {
      count++;
    }
  }
  return count;
}

/** True when the first line looks like a header (mostly identifiers). */
export function looksLikeHeader(firstLine: string, delimiter: string): boolean {
  const cells = firstLine.split(delimiter);
  if (cells.length < 2) return false;
  return cells.every((c) => {
    const t = c.trim().replace(/^"|"$/g, "");
    return t.length > 0 && !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) && /^[A-Za-z_@#\p{L}]/u.test(t);
  });
}
