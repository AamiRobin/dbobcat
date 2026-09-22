import { describe, expect, test } from "bun:test";

import {
  dataUrlToBlob,
  dataUrlToBytes,
  diagramFileFilters,
  resolveDiagramBackground,
} from "./diagram-export";

describe("dataUrlToBytes", () => {
  test("decodes base64 payloads", () => {
    // "ABC" in base64 (with an unused-bit pad) round-trips through bytes.
    const bytes = dataUrlToBytes("data:image/png;base64,QUJD");
    expect(Array.from(bytes)).toEqual([65, 66, 67]);
  });

  test("handles payloads containing padding and plus/slash", () => {
    const bytes = dataUrlToBytes("data:image/svg+xml;base64,YWI/PT0=");
    expect(Array.from(bytes)).toEqual([97, 98, 63, 61, 61]);
  });
});

describe("dataUrlToBlob", () => {
  test("keeps the mime type from the data URL", () => {
    const blob = dataUrlToBlob("data:image/png;base64,QUJD");
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(3);
  });

  test("falls back to image/png without a mime section", () => {
    const blob = dataUrlToBlob("data:,QUJD");
    expect(blob.type).toBe("image/png");
  });
});

describe("diagramFileFilters", () => {
  test("png and svg presets", () => {
    expect(diagramFileFilters("png")).toEqual([{ name: "PNG image", extensions: ["png"] }]);
    expect(diagramFileFilters("svg")).toEqual([{ name: "SVG", extensions: ["svg"] }]);
  });
});

describe("resolveDiagramBackground", () => {
  test("falls back to white outside a styled document", () => {
    // In bun there is no DOM: the resolver must return the default, not throw.
    expect(resolveDiagramBackground()).toBe("#ffffff");
  });
});
