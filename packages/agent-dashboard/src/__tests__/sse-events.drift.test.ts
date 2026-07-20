/**
 * Build-time DRIFT CHECK (#286/#324): the dashboard's client event union
 * (`CLIENT_EVENT_NAMES`) must cover every wire event name the runtime emits.
 *
 * WHY A MANIFEST, NOT A DIRECT RUNTIME IMPORT:
 * The dashboard is architecturally STANDALONE — no `@agentic-patterns/runtime`
 * dependency (CLAUDE.md), and #291 forbids its browser bundle (`graph/`,
 * `chat/`) from importing runtime/server code (the `bun:sqlite` hazard). So the
 * dashboard cannot import the runtime's `SSE_WIRE_EVENT_NAMES` directly. Instead
 * the runtime commits a generated manifest (`tools/gen-sse-manifest.ts`, guarded
 * fresh by `sse-wire-manifest.test.ts`); this test reads it via `fs` — a
 * test-only read that never enters the browser bundle, so the boundary holds.
 *
 * This is the CI gate: if the runtime adds a wire name and the dashboard union
 * isn't extended to match, `missingFromClient` is non-empty and this FAILS.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_EVENT_NAMES } from "../api/sse-events";

/** Pure diff: wire names present in `manifest` but absent from the client union. */
function missingFromClient(manifest: readonly string[], clientNames: readonly string[]): string[] {
  const client = new Set(clientNames);
  return manifest.filter((name) => !client.has(name));
}

const MANIFEST_REL = "agent-runtime/src/transport/sse-event-manifest.json";

function readRuntimeManifest(): string[] {
  // Cross-package read to the runtime's committed manifest. The dashboard's
  // vitest runs under jsdom (module URLs are http-scheme, so import.meta.url is
  // unusable) — resolve from cwd instead, which vitest sets to the package root.
  // Candidates cover both `--filter` (cwd = package) and root-level invocations.
  const candidates = [
    resolve(process.cwd(), "..", MANIFEST_REL), // cwd = packages/agent-dashboard
    resolve(process.cwd(), "packages", MANIFEST_REL), // cwd = repo root
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    throw new Error(
      `SSE manifest not found (looked in: ${candidates.join(", ")}). Regenerate with \`bun run tools/gen-sse-manifest.ts\`.`,
    );
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { names: string[] };
  return parsed.names;
}

describe("SSE event-union drift check", () => {
  it("dashboard CLIENT_EVENT_NAMES covers every runtime wire name (#286)", () => {
    const manifest = readRuntimeManifest();
    const missing = missingFromClient(manifest, CLIENT_EVENT_NAMES);
    // A non-empty list means the runtime emits a wire event the dashboard has no
    // typed client view for — extend `ClientEvent`/`CLIENT_EVENT_NAMES`.
    expect(missing).toEqual([]);
  });

  it("covers the #324-added kinds explicitly", () => {
    const client = new Set<string>(CLIENT_EVENT_NAMES);
    for (const name of [
      "gate.decision",
      "harness.native",
      "iteration.start",
      "iteration.end",
      "llm.start",
      "llm.end",
      "claude_code.hook",
    ]) {
      expect(client.has(name)).toBe(true);
    }
  });

  it("PROOF: the check FAILS when the unions diverge", () => {
    // Simulate the runtime adding a name the dashboard hasn't caught up to.
    const driftedManifest = [...CLIENT_EVENT_NAMES, "some.future.event"];
    const missing = missingFromClient(driftedManifest, CLIENT_EVENT_NAMES);
    expect(missing).toEqual(["some.future.event"]);
    // ...and stays green once the client union catches up.
    const caughtUp = missingFromClient(driftedManifest, [
      ...CLIENT_EVENT_NAMES,
      "some.future.event",
    ]);
    expect(caughtUp).toEqual([]);
  });
});
