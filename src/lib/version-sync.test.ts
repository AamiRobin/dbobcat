import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// The Tauri updater compares the version embedded from tauri.conf.json against
// the release feed, whose version release.yml derives from the git tag. A
// release that bumps package.json but not tauri.conf.json ships a binary that
// still identifies as the old version, so the updater offers the same release
// forever (the v0.1.10 update loop). Keep every version source in lockstep; a
// partial bump now fails this test instead of shipping.

const root = join(import.meta.dir, "..", "..");

function cargoTomlVersion(): string {
  const text = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
  const match = /^version\s*=\s*"([^"]+)"/m.exec(text);
  if (!match) throw new Error("no version entry in src-tauri/Cargo.toml");
  return match[1]!;
}

describe("release version sync", () => {
  test("package.json, tauri.conf.json and Cargo.toml carry the same version", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
    const conf = JSON.parse(
      readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
    ).version as string;
    const cargo = cargoTomlVersion();

    expect(conf).toBe(pkg);
    expect(cargo).toBe(pkg);
  });
});
