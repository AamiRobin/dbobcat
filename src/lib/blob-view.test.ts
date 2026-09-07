import { describe, expect } from "bun:test";
import { test } from "bun:test";

import { base64ToBytes, bytesToBase64 } from "./blob-view";

describe("blob base64 transfer", () => {
  test("round-trips ASCII bytes", () => {
    const bytes = [104, 101, 108, 108, 111]; // "hello"
    expect(bytesToBase64(bytes)).toBe("aGVsbG8=");
    expect(base64ToBytes("aGVsbG8=")).toEqual(bytes);
  });

  test("round-trips binary bytes above 0x7f", () => {
    const bytes = [0, 1, 2, 127, 128, 200, 254, 255];
    const encoded = bytesToBase64(bytes);
    // btoa/atob use the same standard alphabet as the Rust STANDARD engine.
    expect(base64ToBytes(encoded)).toEqual(bytes);
  });

  test("round-trips an empty payload", () => {
    expect(bytesToBase64([])).toBe("");
    expect(base64ToBytes("")).toEqual([]);
  });

  test("round-trips a large payload crossing the chunk boundary", () => {
    const bytes = Array.from({ length: 0x8000 + 37 }, (_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  test("accepts Uint8Array input", () => {
    const u8 = new Uint8Array([1, 2, 3]);
    expect(base64ToBytes(bytesToBase64(u8))).toEqual([1, 2, 3]);
  });
});
