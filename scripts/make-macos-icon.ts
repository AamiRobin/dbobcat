#!/usr/bin/env bun
/**
 * Rebuild src-tauri/icons/icon.icns from the canonical brand icon.
 *
 * macOS 26+ masks app icons into its own squircle and wraps artwork that
 * doesn't fill the canvas in an auto-generated frame. The canonical
 * dbobcat-1024.png is a rounded tile with baked-in margins — correct for
 * Windows (.ico) and Linux (.png), but it must never go into the .icns
 * as-is. The .icns is therefore compiled from a full-bleed, edge-to-edge
 * variant: the artwork pasted over a background extended from the tile's
 * own edge pixels, so the gradient reads as designed full-bleed art.
 *
 * If you re-export the artwork as a true full-bleed square (no rounded
 * corners, no margins, fully opaque), compile it directly — no derivation:
 *
 *   bun scripts/make-macos-icon.ts assets/brand/dbobcat-fullbleed.png
 *
 * macOS only (uses sips/iconutil). Note: tauri-bundler has no support yet
 * for Icon Composer ".icon" files — it only copies a listed .icns or packs
 * PNGs into one — so a full-bleed .icns is the correct format.
 */

import { execFileSync } from "node:child_process";
import { mkdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "assets/brand/dbobcat-1024.png");
const DERIVED = path.join(ROOT, "assets/brand/dbobcat-1024-macos.png");
const OUT = path.join(ROOT, "src-tauri/icons/icon.icns");
const SIZE = 1024;

interface Rgba {
  data: Buffer;
  width: number;
  height: number;
}

/** Bounding box of pixels whose alpha is at least `min`. */
function alphaBBox({ data, width, height }: Rgba, min: number) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] >= min) {
        if (x < left) left = x;
        if (y < top) top = y;
        if (x > right) right = x;
        if (y > bottom) bottom = y;
      }
    }
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

async function cropRaw(img: Rgba, box: { left: number; top: number; width: number; height: number }): Promise<Rgba> {
  const data = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .extract(box)
    .raw()
    .toBuffer();
  return { data, width: box.width, height: box.height };
}

async function resizeRaw(img: Rgba, width: number, height: number): Promise<Rgba> {
  const data = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(width, height, { kernel: "lanczos3" })
    .raw()
    .toBuffer();
  return { data, width, height };
}

async function blurRaw(img: Rgba, sigma: number): Promise<Rgba> {
  const data = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .blur(sigma)
    .raw()
    .toBuffer();
  return { data, width: img.width, height: img.height };
}

/** Feathered white rectangle (SVG blur) as an RGBA buffer with alpha = coverage. */
async function featheredMask(width: number, height: number): Promise<Rgba> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
       <filter id="f"><feGaussianBlur stdDeviation="8"/></filter>
       <rect x="12" y="12" width="${width - 24}" height="${height - 24}" fill="#fff" filter="url(#f)"/>
     </svg>`,
  );
  const { data, info } = await sharp(svg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Fill transparent zones by bleeding the opaque surroundings inward
 * (progressively larger blurs), so the background continues the tile's
 * gradient into the areas its rounded corners leave empty. Only colors
 * already present at the tile's boundary are used — no invented content.
 * Runs in premultiplied space so the transparent zones' black RGB never
 * contaminates the bleed.
 */
async function inpaintHoles(canvas: Rgba): Promise<Rgba> {
  const n = canvas.width * canvas.height;
  const hole = new Uint8Array(n);
  for (let i = 0; i < n; i++) hole[i] = canvas.data[i * 4 + 3] < 255 ? 1 : 0;

  const pre = Buffer.from(canvas.data);
  for (let i = 0; i < n; i++) {
    const a = pre[i * 4 + 3];
    if (a < 255) {
      pre[i * 4] = Math.round((pre[i * 4] * a) / 255);
      pre[i * 4 + 1] = Math.round((pre[i * 4 + 1] * a) / 255);
      pre[i * 4 + 2] = Math.round((pre[i * 4 + 2] * a) / 255);
    }
  }

  let img: Rgba = { data: pre, width: canvas.width, height: canvas.height };
  for (const sigma of [8, 16, 32, 64, 64]) {
    img = await blurRaw(img, sigma);
    for (let i = 0; i < n; i++) {
      if (!hole[i]) continue;
      canvas.data[i * 4] = img.data[i * 4];
      canvas.data[i * 4 + 1] = img.data[i * 4 + 1];
      canvas.data[i * 4 + 2] = img.data[i * 4 + 2];
      canvas.data[i * 4 + 3] = img.data[i * 4 + 3];
    }
    // keep the working copy in sync for the next, wider pass
    for (let i = 0; i < n; i++) {
      if (!hole[i]) continue;
      pre[i * 4] = canvas.data[i * 4];
      pre[i * 4 + 1] = canvas.data[i * 4 + 1];
      pre[i * 4 + 2] = canvas.data[i * 4 + 2];
      pre[i * 4 + 3] = canvas.data[i * 4 + 3];
    }
  }

  // un-premultiply the filled zones and make them fully opaque — any
  // residual transparency would be darkened by the final flatten
  for (let i = 0; i < n; i++) {
    if (!hole[i]) continue;
    const j = i * 4;
    const a = canvas.data[j + 3];
    if (a > 0) {
      canvas.data[j] = Math.min(255, Math.round((canvas.data[j] * 255) / a));
      canvas.data[j + 1] = Math.min(255, Math.round((canvas.data[j + 1] * 255) / a));
      canvas.data[j + 2] = Math.min(255, Math.round((canvas.data[j + 2] * 255) / a));
    }
    canvas.data[j + 3] = 255;
  }
  return canvas;
}

async function fullBleed(srcBuf: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(srcBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const src: Rgba = { data, width: info.width, height: info.height };

  // The tile has a soft baked-in drop shadow; its semi-transparent edge
  // would darken anything behind it, so composite only the solid region.
  const tile = await cropRaw(src, alphaBBox(src, 1));
  const solid = await cropRaw(tile, alphaBBox(tile, 254));
  const { width: w, height: h } = solid;

  // Background: the solid tile at exact cover size, centered. Its rounded
  // corners leave four empty corner zones, which inpaintHoles fills from
  // the tile's own edge colors.
  const cover = Math.max(SIZE / w, SIZE / h);
  const cw = Math.round(w * cover);
  const ch = Math.round(h * cover);
  const scaled = await resizeRaw(solid, cw, ch);
  const bg: Rgba = { data: Buffer.alloc(SIZE * SIZE * 4), width: SIZE, height: SIZE };
  const ox = (SIZE - cw) >> 1;
  const oy = (SIZE - ch) >> 1;
  for (let y = 0; y < SIZE; y++) {
    const sy = y - oy;
    if (sy < 0 || sy >= ch) continue;
    for (let x = 0; x < SIZE; x++) {
      const sx = x - ox;
      if (sx < 0 || sx >= cw) continue;
      const si = (sy * cw + sx) * 4;
      const di = (y * SIZE + x) * 4;
      bg.data[di] = scaled.data[si];
      bg.data[di + 1] = scaled.data[si + 1];
      bg.data[di + 2] = scaled.data[si + 2];
      bg.data[di + 3] = scaled.data[si + 3];
    }
  }
  await inpaintHoles(bg);

  // Foreground: solid tile at a hair over cover scale, feathered edge so
  // the boundary melts into the background.
  const fw = Math.round(w * cover * 1.04);
  const fh = Math.round(h * cover * 1.04);
  const fg = await resizeRaw(solid, fw, fh);
  const mask = await featheredMask(fw, fh);

  // Alpha-blend the fg's central window over the background.
  const fox = (fw - SIZE) >> 1;
  const foy = (fh - SIZE) >> 1;
  const out = Buffer.from(bg.data);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const fi = ((y + foy) * fw + x + fox) * 4;
      const a = mask.data[fi + 3] / 255;
      if (a === 0) continue;
      const oi = (y * SIZE + x) * 4;
      for (let c = 0; c < 3; c++) {
        const f = fg.data[fi + c];
        out[oi + c] = Math.round(f * a + out[oi + c] * (1 - a));
      }
    }
  }
  return sharp(out, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .flatten({ background: "#000000" })
    .png()
    .toBuffer();
}

const ICNS_SIZES = [
  [16, "icon_16x16"],
  [32, "icon_16x16@2x"],
  [32, "icon_32x32"],
  [64, "icon_32x32@2x"],
  [128, "icon_128x128"],
  [256, "icon_128x128@2x"],
  [256, "icon_256x256"],
  [512, "icon_256x256@2x"],
  [512, "icon_512x512"],
  [1024, "icon_512x512@2x"],
] as const;

async function buildIcns(src: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "dbobcat-icon-"));
  try {
    const iconset = path.join(dir, "icon.iconset");
    await mkdir(iconset);
    for (const [size, name] of ICNS_SIZES) {
      execFileSync("sips", ["-z", String(size), String(size), src, "--out", path.join(iconset, `${name}.png`)], {
        stdio: "pipe",
      });
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", OUT], { stdio: "pipe" });
  } finally {
    await rm(dir, { recursive: true });
  }
}

const customSource = process.argv[2];
if (customSource) {
  await buildIcns(path.resolve(customSource));
  console.log(`wrote ${path.relative(ROOT, OUT)} from ${path.relative(ROOT, path.resolve(customSource))}`);
} else {
  const derived = await fullBleed(await Bun.file(SRC).bytes());
  await Bun.write(DERIVED, derived);
  await buildIcns(DERIVED);
  console.log(`wrote ${path.relative(ROOT, DERIVED)} and ${path.relative(ROOT, OUT)}`);
}
