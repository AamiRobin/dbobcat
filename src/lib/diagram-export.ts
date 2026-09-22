import { toPng, toSvg } from "html-to-image";

import { ipc } from "@/lib/ipc";
import type { FileDialogFilter } from "@/types/ipc";

/**
 * Diagram export: rasterizes/serializes the live React Flow viewport via
 * html-to-image (the same approach Supabase Studio uses), plus clipboard
 * copy and the file-save IPC (`dia_export_file`, honoring the
 * `file exists:` / overwrite convention shared with the export engine).
 */

/** Read the canvas background token so exports are opaque in both themes. */
export function resolveDiagramBackground(): string {
  if (typeof document === "undefined") return "#ffffff";
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--background")
    .trim();
  return value || "#ffffff";
}

export interface DiagramCapture {
  /** The `.react-flow__viewport` element. All nodes must be mounted — the
   * caller disables `onlyRenderVisibleElements` for the capture. */
  element: HTMLElement;
  /** Full image size in CSS px (graph bounds + padding, aspect-fitted). */
  width: number;
  height: number;
  /** React Flow transform placing the whole graph inside width × height. */
  viewport: { x: number; y: number; zoom: number };
  background: string;
}

const captureStyle = (capture: DiagramCapture): Partial<CSSStyleDeclaration> => ({
  width: `${capture.width}px`,
  height: `${capture.height}px`,
  transform: `translate(${capture.viewport.x}px, ${capture.viewport.y}px) scale(${capture.viewport.zoom})`,
  transformOrigin: "top left",
});

/** Render the diagram to a data URL (`data:image/png…` or `data:image/svg…`). */
export async function captureDiagramToDataUrl(
  kind: "png" | "svg",
  capture: DiagramCapture,
  pixelRatio = 2,
): Promise<string> {
  const options = {
    backgroundColor: capture.background,
    width: capture.width,
    height: capture.height,
    pixelRatio,
    style: captureStyle(capture),
    // NOTE: do NOT set skipFonts here. Embedding the app's web fonts keeps
    // glyph metrics identical in the serialized SVG — skipping them makes
    // text render in a fallback font and truncates every label. (The old
    // WebKit export failure was the NUL edge ids, not font embedding.)
  };
  return kind === "svg" ? toSvg(capture.element, options) : toPng(capture.element, options);
}

/** Decode a base64 data URL into raw file bytes. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decode a base64 data URL into a Blob (clipboard needs Blob parts). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const header = comma > -1 ? dataUrl.slice(0, comma) : dataUrl;
  const mime = header.startsWith("data:") ? header.slice(5).split(";")[0] : "";
  return new Blob([dataUrlToBytes(dataUrl)], { type: mime || "image/png" });
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

/** Overwrite variant used after the user confirms the Exists dialog. */
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
