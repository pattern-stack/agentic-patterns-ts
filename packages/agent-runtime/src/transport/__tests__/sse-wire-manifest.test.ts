/**
 * Guards the committed SSE wire-vocabulary manifest against the runtime's
 * authoritative `SSE_WIRE_EVENT_NAMES` (#286/#324).
 *
 * The manifest is the cross-package bridge the STANDALONE dashboard reads to
 * drift-check its own client union (the dashboard can't import the runtime —
 * see #291 / tools/gen-sse-manifest.ts). This test keeps the manifest honest:
 * add or remove a wire name and this fails until the manifest is regenerated
 * with `bun run tools/gen-sse-manifest.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SSE_WIRE_EVENT_NAMES } from "../sse-formatter.js";

const MANIFEST_PATH = join(__dirname, "..", "sse-event-manifest.json");

function readManifestNames(): string[] {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  const parsed = JSON.parse(raw) as { names: string[] };
  return parsed.names;
}

describe("SSE wire-event manifest", () => {
  it("is in sync with SSE_WIRE_EVENT_NAMES (regenerate with `bun run tools/gen-sse-manifest.ts`)", () => {
    const manifest = readManifestNames();
    const expected = [...SSE_WIRE_EVENT_NAMES].sort();
    expect(manifest).toEqual(expected);
  });

  it("contains the #324-added kinds", () => {
    const manifest = new Set(readManifestNames());
    expect(manifest.has("gate.decision")).toBe(true);
    expect(manifest.has("harness.native")).toBe(true);
    // #286's five previously-drifted names
    for (const name of [
      "iteration.start",
      "iteration.end",
      "llm.start",
      "llm.end",
      "claude_code.hook",
    ]) {
      expect(manifest.has(name)).toBe(true);
    }
  });

  it("is free of duplicates", () => {
    const names = readManifestNames();
    expect(new Set(names).size).toBe(names.length);
  });
});
