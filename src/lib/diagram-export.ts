import { ipc } from "@/lib/ipc";
import type { FileDialogFilter } from "@/types/ipc";
import { CARD_WIDTH, ROW_HEIGHT, visibleRows, type DiagramNode } from "./diagram-model";
import type { CardBox, EdgeGeometry } from "./diagram-edge-paths";

/**
 * Diagram export (Phase 11): standalone SVG serialization with resolved
 * theme tokens inlined (no CSS variables — external viewers see real
 * colors), PNG rasterization through the canvas path, clipboard copy and
 * the file-save IPC (`dia_export_file`, honoring the `file exists:` /
 * overwrite convention shared with the export engine).
 */

export interface DiagramTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  border: string;
  mutedForeground: string;
  primary: string;
}

/** Resolve semantic tokens to concrete color strings for serialization. */
export function resolveDiagramTokens(): DiagramTokens {
  const styles =
    typeof document !== "undefined"
      ? getComputedStyle(document.documentElement)
      : null;
  const read = (name: string, fallback: string): string =>
    styles?.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--background", "#ffffff"),
    foreground: read("--foreground", "#171717"),
    card: read("--card", "#ffffff"),
    cardForeground: read("--card-foreground", "#171717"),
    border: read("--border", "#e5e5e5"),
    mutedForeground: read("--muted-foreground", "#737373"),
    primary: read("--primary", "#171717"),
  };
}

/** XML-escape attribute/text content (table & column names are user data). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Overall pixel size of the exported canvas (cards + margin). */
export function svgContentSize(
  nodes: DiagramNode[],
  boxes: Record<string, CardBox>,
  margin = 24,
): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const node of nodes) {
    const box = boxes[node.id];
    if (!box) continue;
    width = Math.max(width, box.x + CARD_WIDTH + margin);
    height = Math.max(height, box.y + box.height + margin);
  }
  return { width: Math.max(width, margin * 2), height: Math.max(height, margin * 2) };
}

interface SerializeInput {
  nodes: DiagramNode[];
  boxes: Record<string, CardBox>;
  edges: EdgeGeometry[];
  tokens: DiagramTokens;
  keysOnly: boolean;
  collapsed: Set<string>;
}

/** Approximate monospace advance used for truncating row text. */
const CHAR_PX = 5.6;

function truncate(text: string, maxWidthPx: number): string {
  if (text.length * CHAR_PX <= maxWidthPx) return text;
  const maxChars = Math.max(1, Math.floor(maxWidthPx / CHAR_PX) - 1);
  return `${text.slice(0, maxChars)}…`;
}

/**
 * Serialize the laid-out model to a STANDALONE SVG document. Mirrors the
 * on-screen anatomy (header / rows / footer, crow's feet) without any CSS
 * dependency so viewers and rasterizers render it faithfully.
 */
export function serializeModelToSvgString(input: SerializeInput): string {
  const { nodes, boxes, edges, tokens, keysOnly, collapsed } = input;
  const { width, height } = svgContentSize(nodes, boxes);
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-sans-serif, system-ui, sans-serif">`,
  );
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${tokens.background}"/>`);

  // Edges below cards.
  for (const edge of edges) {
    parts.push(
      `<path d="${edge.d}" fill="none" stroke="${tokens.border}" stroke-width="1.25"/>`,
    );
    if (edge.foot) {
      parts.push(
        `<path d="${edge.foot}" fill="${edge.filled ? tokens.border : "none"}" stroke="${tokens.border}" stroke-width="1.25"/>`,
      );
    }
  }

  const HEADER_H = 26;
  for (const node of nodes) {
    const box = boxes[node.id];
    if (!box) continue;
    const isCollapsed = collapsed.has(node.id);
    parts.push(
      `<g>` +
        `<rect x="${box.x}" y="${box.y}" width="${CARD_WIDTH}" height="${isCollapsed ? HEADER_H : box.height}" rx="6" fill="${tokens.card}" stroke="${tokens.border}"/>` +
        `<text x="${box.x + 10}" y="${box.y + 17}" font-size="11" font-weight="600" fill="${tokens.cardForeground}">${escapeXml(truncate(node.id, CARD_WIDTH - 40))}</text>` +
      `</g>`,
    );
    if (isCollapsed) continue;

    const { rows, hiddenCount } = visibleRows(node, keysOnly);
    rows.forEach((col, i) => {
      const y = box.y + HEADER_H + i * ROW_HEIGHT;
      const isPk = col.key === "PRI";
      const isFk = node.fkColumns.has(col.name);
      if (isPk) {
        parts.push(
          `<path d="M ${box.x + 9} ${y + 10} l 4 -4 l 4 4 Z" fill="${tokens.primary}"/>`,
        );
      } else if (isFk) {
        parts.push(
          `<circle cx="${box.x + 13}" cy="${y + 8}" r="2.5" fill="none" stroke="${tokens.mutedForeground}"/>`,
        );
      }
      parts.push(
        `<text x="${box.x + 22}" y="${y + 12}" font-size="10" fill="${tokens.cardForeground}"${isPk ? ' font-weight="600"' : ""}>${escapeXml(truncate(col.name, CARD_WIDTH - 96))}</text>`,
      );
      parts.push(
        `<text x="${box.x + CARD_WIDTH - 8}" y="${y + 12}" font-size="9" text-anchor="end" font-family="ui-monospace, Menlo, monospace" fill="${tokens.mutedForeground}">${escapeXml(truncate(col.dataType, 74))}</text>`,
      );
    });

    if (hiddenCount > 0) {
      const fy = box.y + HEADER_H + rows.length * ROW_HEIGHT;
      parts.push(
        `<line x1="${box.x}" y1="${fy}" x2="${box.x + CARD_WIDTH}" y2="${fy}" stroke="${tokens.border}"/>`,
      );
      parts.push(
        `<text x="${box.x + CARD_WIDTH / 2}" y="${fy + 13}" font-size="9" text-anchor="middle" fill="${tokens.mutedForeground}">+${hiddenCount} more</text>`,
      );
    }
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

/**
 * Rasterize the SVG at `scale` onto an opaque `background` canvas.
 * Requires a DOM (runs inside the webview; unit tests skip this path).
 */
export async function svgToPngBlob(
  svgString: string,
  scale = 2,
  background = "#ffffff",
): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("could not rasterize SVG"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Copy a PNG blob as an image; false when the webview can't. */
export async function copyPngToClipboard(blob: Blob): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    return false;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

/** Persist export bytes through the backend writer (Exists convention). */
export async function writeExportFile(path: string, bytes: Uint8Array): Promise<number> {
  return ipc<number>("dia_export_file", { path, bytes: Array.from(bytes), overwrite: false });
}

export async function writeExportFileOverwrite(
  path: string,
  bytes: Uint8Array,
): Promise<number> {
  return ipc<number>("dia_export_file", { path, bytes: Array.from(bytes), overwrite: true });
}

/** Save-dialog presets for the two file formats. */
export function diagramFileFilters(kind: "png" | "svg"): FileDialogFilter[] {
  return kind === "png"
    ? [{ name: "PNG image", extensions: ["png"] }]
    : [{ name: "SVG", extensions: ["svg"] }];
}
