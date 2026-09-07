import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";

// Renders the brand mark to the PNG that `bunx tauri icon` consumes
// (see assets/brand/README.md).
const svg = readFileSync("assets/brand/dbobcat-mark.svg", "utf8");
const png = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng();
writeFileSync("assets/brand/dbobcat-1024.png", png);
console.log(`wrote assets/brand/dbobcat-1024.png (${png.length} bytes)`);
