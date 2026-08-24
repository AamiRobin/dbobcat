import { describe, expect, test } from "bun:test";

import { compileTreeFilter } from "./tree-filter";

describe("compileTreeFilter", () => {
  test("empty pattern disables filtering", () => {
    expect(compileTreeFilter("")).toBeNull();
    expect(compileTreeFilter("   ")).toBeNull();
  });

  test("plain text behaves like a case-insensitive substring match", () => {
    const m = compileTreeFilter("SERS")!;
    // "SERS" is a valid (metachar-free) regex with the i flag.
    expect(m.matches("users")).toBe(true);
    expect(m.matches("USERS")).toBe(true);
    expect(m.matches("orders")).toBe(false);
  });

  test("valid regex is honored", () => {
    const m = compileTreeFilter("^user_.*2024$")!;
    expect(m.mode).toBe("regex");
    expect(m.matches("user_logs_2024")).toBe(true);
    expect(m.matches("logs_user_2024x")).toBe(false);
  });

  test("invalid regex falls back to literal substring", () => {
    const m = compileTreeFilter("user(s(")!;
    expect(m.mode).toBe("substring");
    expect(m.matches("user(s(backup)")).toBe(true);
    expect(m.matches("users_backup")).toBe(false);
  });

  test("regex character classes work", () => {
    const m = compileTreeFilter("tmp_\\d{4}")!;
    expect(m.mode).toBe("regex");
    expect(m.matches("tmp_2024")).toBe(true);
    expect(m.matches("tmp_abcd")).toBe(false);
  });
});
