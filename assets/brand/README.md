# DBobcat brand icon

A 3D database cylinder with a query-builder badge on a blue rounded tile.

## Files

- `dbobcat-1024.png` — canonical source (1024×1024 RGBA, square, transparent corners). All app icons are generated from this.
- `dbobcat-app-icon.png` — 512×512 export used in `README.md`.

## Regenerating app icons

After replacing `dbobcat-1024.png`, run:

```sh
bunx tauri icon assets/brand/dbobcat-1024.png
```

This rewrites everything in `src-tauri/icons/` (`icon.icns`, `icon.ico`, and the PNG sizes referenced by `tauri.conf.json`). It also emits `ios/` and `android/` icon sets — delete those folders, this app is desktop-only.

## Other exports

- `src/assets/dbobcat-logo.webp` — About dialog logo (128×128), shown at 24 px.
- `public/dbobcat.png` — favicon (64×64), referenced from `index.html`.

Regenerate them from the source at any size with e.g. Pillow or sips, keeping the filenames so no code changes are needed.
