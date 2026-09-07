# DBobcat brand mark

A tufted bobcat perched atop its den, drawn as a database cylinder. Geometry is flat fills only (no strokes in the silhouette) so it survives 16 px rasterization.

## Palette

| Name       | Hex       | Role                          |
| ---------- | --------- | ----------------------------- |
| Bedrock    | `#22262E` | Tile ground, nose             |
| Scree      | `#3B434F` | Den cylinder stone            |
| Boulder    | `#99A2B1` | Fur                           |
| Edelweiss  | `#F1EFE7` | Muzzle + belly                |
| Glacier    | `#57A8C4` | Disc seams, eye glint         |

## Usage

- `dbobcat-mark.svg` — primary mark on its own rounded tile; works on light and dark backgrounds.
- `dbobcat-mark-dark.svg` — tile-free variant for embedding directly on dark surfaces.
- `public/dbobcat.svg` — favicon build (seams dropped); regenerate PNGs with `bun scripts/render-brand.ts`, then `bunx tauri icon assets/brand/dbobcat-1024.png`.
