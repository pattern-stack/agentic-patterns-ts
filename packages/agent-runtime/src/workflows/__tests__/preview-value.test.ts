import { describe, expect, it } from "vitest";
import { PREVIEW_MARKER, previewValue, renderPreviewSource } from "../state-events.js";

describe("renderPreviewSource — absence vs value", () => {
  it("renders undefined as empty, not the literal 'undefined'", () => {
    // Regression: reading an unset scratchpad slot surfaced `key · read ·
    // undefined` in the chat Δ frame — absence reported as though it were a
    // value. JSON.stringify(undefined) returns undefined, which fell into the
    // String(value) fallback.
    expect(renderPreviewSource(undefined)).toBe("");
  });

  it("still renders null as 'null' — null IS a value", () => {
    expect(renderPreviewSource(null)).toBe("null");
  });

  it("passes strings through verbatim", () => {
    expect(renderPreviewSource("universe")).toBe("universe");
  });

  it("serializes plain values and objects as JSON", () => {
    expect(renderPreviewSource(23)).toBe("23");
    expect(renderPreviewSource(false)).toBe("false");
    expect(renderPreviewSource({ a: 1 })).toBe('{"a":1}');
    expect(renderPreviewSource([1, "b"])).toBe('[1,"b"]');
  });

  it("keeps the String() fallback for genuinely unserializable values", () => {
    // JSON.stringify returns undefined for these too — but they are values,
    // not absence, so the fallback is still correct.
    expect(renderPreviewSource(() => 1)).toContain("=>");
    expect(renderPreviewSource(Symbol("s"))).toBe("Symbol(s)");
  });

  it("does not throw on a circular structure", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => renderPreviewSource(cyclic)).not.toThrow();
  });
});

describe("previewValue", () => {
  it("returns empty for an unset slot", () => {
    expect(previewValue(undefined)).toBe("");
  });

  it("caps long values and marks them explicitly", () => {
    const long = "x".repeat(5000);
    const out = previewValue(long, 64);
    expect(out.endsWith(PREVIEW_MARKER)).toBe(true);
    expect(out.length).toBeLessThan(long.length);
  });

  it("leaves short values uncapped", () => {
    expect(previewValue("short", 64)).toBe("short");
  });
});
