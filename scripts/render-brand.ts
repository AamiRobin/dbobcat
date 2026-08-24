import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

function render(svgPath: string, width: number): { width: number; height: number; pixels: Uint8Array } {
  const svg = readFileSync(svgPath, "utf8");
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: width } });
  const image = resvg.render();
  return { width: image.width, height: image.height, pixels: image.pixels };
}

function alphaStats(pixels: Uint8Array): { opaque: number; translucent: number; transparent: number } {
  let opaque = 0;
  let translucent = 0;
  let transparent = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    const a = pixels[i];
    if (a === 255) opaque += 1;
    else if (a === 0) transparent += 1;
    else translucent += 1;
  }
  return { opaque, translucent, transparent };
}

mkdirSync("assets/brand", { recursive: true });

const full = render("assets/brand/murmeli-mark.svg", 1024);
writeFileSync("assets/brand/murmeli-1024.png", new Resvg(readFileSync("assets/brand/murmeli-mark.svg", "utf8"), { fitTo: { mode: "width", value: 1024 } }).render().asPng());
console.log(`murmeli-1024.png ${full.width}x${full.height} alpha=`, alphaStats(full.pixels));

const tiny = render("assets/brand/murmeli-mark.svg", 16);
const pngBytes = new Resvg(readFileSync("assets/brand/murmeli-mark.svg", "utf8"), { fitTo: { mode: "width", value: 16 } }).render().asPng();
writeFileSync("/tmp/opencode/murmeli-16.png", pngBytes);
console.log(`murmeli-16.png ${tiny.width}x${tiny.height} bytes=${pngBytes.length} alpha=`, alphaStats(tiny.pixels));
