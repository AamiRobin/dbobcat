/**
 * Binary payload inspection for the BLOB viewer: magic-byte image sniffing,
 * UTF-8 text detection and hex-dump rendering.
 */

export interface ImageMatch {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/** Sniff common raster formats by magic bytes. */
export function detectImage(bytes: number[] | Uint8Array): ImageMatch | null {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { mime: "image/png" };
  }
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { mime: "image/jpeg" };
  }
  // GIF: "GIF87a"/"GIF89a"
  if (
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 &&
    b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
  ) {
    return { mime: "image/gif" };
  }
  // WebP: "RIFF"...."WEBP"
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return { mime: "image/webp" };
  }
  return null;
}

/** Decode as strict UTF-8; null when the payload is not valid text. */
export function tryDecodeUtf8(bytes: number[] | Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
  } catch {
    return null;
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** Classic 16-bytes-per-row hex dump with an ASCII gutter. */
export function hexDump(bytes: number[] | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const lines: string[] = [];
  for (let offset = 0; offset < b.length; offset += 16) {
    const slice = b.subarray(offset, Math.min(offset + 16, b.length));
    const hexParts = Array.from(slice, (v) => HEX[v]);
    // Pad the hex column so ASCII gutters stay aligned on short rows.
    while (hexParts.length < 16) hexParts.push("  ");
    const ascii = Array.from(
      slice,
      (v) => (v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : "."),
    ).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hexParts.join(" ")}  |${ascii}|`);
  }
  return lines.join("\n");
}

/** Data URI for image previews (chunked to avoid call-stack limits). */
export function bytesToDataUrl(bytes: number[], mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
