import { describe, expect, it } from "bun:test";

import {
  commonPrivileges,
  formatUptime,
  singlePkFilterValue,
  userLabel,
} from "./server-queries";

describe("userLabel", () => {
  it("renders user@host for MySQL and bare names for PG roles", () => {
    expect(userLabel({ user: "app", host: "%" })).toBe("app@%");
    expect(userLabel({ user: "owner", host: "localhost" })).toBe("owner@localhost");
    expect(userLabel({ user: "postgres", host: null })).toBe("postgres");
  });
});

describe("commonPrivileges", () => {
  it("switches the list per dialect", () => {
    const mysql = commonPrivileges("mysql");
    const pg = commonPrivileges("postgres");
    expect(mysql).toContain("ALL PRIVILEGES");
    expect(mysql).toContain("CREATE TEMPORARY TABLES");
    expect(pg).toContain("TRUNCATE");
    expect(pg).toContain("CONNECT");
    // Engine-specific entries never leak into the other list.
    expect(pg).not.toContain("CREATE TEMPORARY TABLES");
    expect(mysql).not.toContain("CONNECT");
  });
});

describe("singlePkFilterValue", () => {
  it("accepts scalar PKs only", () => {
    expect(singlePkFilterValue("42")).toBe("42");
    expect(singlePkFilterValue("abc")).toBe("abc");
    expect(singlePkFilterValue("")).toBeNull();
    expect(singlePkFilterValue("a|b")).toBeNull();
  });
});

describe("formatUptime", () => {
  it("formats compact durations", () => {
    expect(formatUptime(45)).toBe("0m");
    expect(formatUptime(600)).toBe("10m");
    expect(formatUptime(7322)).toBe("2h 2m");
    expect(formatUptime(90061)).toBe("1d 1h");
    expect(formatUptime(Number.NaN)).toBe("—");
  });
});
