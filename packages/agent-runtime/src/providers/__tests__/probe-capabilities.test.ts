/**
 * Unit tests for `scripts/probe-capabilities.mjs`'s matrix/skip/`--check`
 * plumbing (#390), against a STUB provider — no network call, no
 * `@ai-sdk/*` package install required. Live probes stay manual/CI-optional
 * by design (see the script's own doc comment); this pins the logic around
 * them.
 *
 * Imports the script directly by relative path — its own internal imports
 * (into `packages/agent-runtime/node_modules/...` and `dist/index.js`) are
 * resolved relative to ITS file location, not this test's, so this works
 * regardless of where the script is imported from. Requires
 * `packages/agent-runtime/dist/index.js` to exist (`bun run build`) — same
 * precondition the script itself documents.
 */

import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs script, no .d.ts declaration file; re-typed
// below via explicit casts so the rest of this file stays fully typed.
import * as probeCapabilities from "../../../../../scripts/probe-capabilities.mjs";

interface ProbeRow {
  provider: string;
  model: string;
  capability: string;
  outcome: string;
  date: string;
  note: string;
}

interface CapabilityValueLike {
  support: string;
  verifiedBy: string;
  lastVerified?: string;
}

interface StubProvider {
  name: string;
  envVars: string[];
  tiers: Record<string, string>;
  load: (modelId: string) => Promise<unknown>;
}

const row = probeCapabilities.row as (
  provider: string,
  model: string,
  capability: string,
  outcome: string,
  note?: string,
) => ProbeRow;
const printTable = probeCapabilities.printTable as (rows: ProbeRow[]) => void;
const probeProvider = probeCapabilities.probeProvider as (
  provider: StubProvider,
) => Promise<ProbeRow[]>;
const daysSince = probeCapabilities.daysSince as (isoDate: string) => number;
const checkDrift = probeCapabilities.checkDrift as (
  rows: ProbeRow[],
  lookupCapabilities?: (modelId: string) => Record<string, CapabilityValueLike> | undefined,
) => { drift: ProbeRow[]; stale: ProbeRow[] };

/** A stub `ProviderProtocol`-shaped object — no real `@ai-sdk/*` adapter. */
function stubProvider(overrides: Partial<StubProvider> = {}): StubProvider {
  return {
    name: "stub-provider",
    envVars: ["STUB_PROVIDER_API_KEY_390"],
    tiers: { opus: "stub-opus", sonnet: "stub-sonnet", haiku: "stub-haiku" },
    load: async () => {
      throw new Error("stub provider should never actually load a model in these tests");
    },
    ...overrides,
  };
}

describe("row / printTable", () => {
  it("row() stamps today's date and defaults note to an empty string", () => {
    const r = row("openai", "gpt-4o", "structuredOutput", "PASS");
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-4o");
    expect(r.capability).toBe("structuredOutput");
    expect(r.outcome).toBe("PASS");
    expect(r.note).toBe("");
    expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("printTable() doesn't throw on an empty or populated row set", () => {
    expect(() => printTable([])).not.toThrow();
    expect(() =>
      printTable([row("openai", "gpt-4o", "structuredOutput", "PASS", "note")]),
    ).not.toThrow();
  });
});

describe("probeProvider — skip/fail plumbing (stub provider)", () => {
  it("returns a single SKIP (no key) row when none of the provider's envVars are set", async () => {
    const provider = stubProvider({ envVars: ["STUB_PROVIDER_KEY_THAT_IS_DEFINITELY_UNSET_390"] });
    const rows = await probeProvider(provider);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("SKIP (no key)");
    expect(rows[0]?.capability).toBe("*");
    expect(rows[0]?.model).toBe("stub-haiku");
    expect(rows[0]?.note).toContain("STUB_PROVIDER_KEY_THAT_IS_DEFINITELY_UNSET_390");
  });

  it("returns a single FAIL (load) row when the key IS set but provider.load() throws", async () => {
    const envVar = "STUB_PROVIDER_KEY_390_SET_FOR_TEST";
    const provider = stubProvider({
      envVars: [envVar],
      load: async () => {
        throw new Error("simulated load failure — no @ai-sdk/* package installed");
      },
    });
    const original = process.env[envVar];
    process.env[envVar] = "fake-key-for-test";
    try {
      const rows = await probeProvider(provider);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe("FAIL (load)");
      expect(rows[0]?.note).toContain("simulated load failure");
    } finally {
      if (original === undefined) delete process.env[envVar];
      else process.env[envVar] = original;
    }
  });

  it("runs the full 4-row matrix when the key is set and load() succeeds (against a fake model)", async () => {
    const envVar = "STUB_PROVIDER_KEY_390_MATRIX_TEST";
    // A fake "model" object — probeProvider only passes it through to
    // generateText(), which we don't reach for a fake, non-ai-sdk model
    // object (it will throw inside each probe step's try/catch, which is
    // exactly the FAIL path each probe step is built to report through).
    const provider = stubProvider({
      envVars: [envVar],
      load: async () => ({ modelId: "stub-haiku" }),
    });
    const original = process.env[envVar];
    process.env[envVar] = "fake-key-for-test";
    try {
      const rows = await probeProvider(provider);
      // (a) structuredOutput, (b) toolsWithStructuredOutput, (c) strictSchemaMode, (d) reasoningEffort
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.capability)).toEqual([
        "structuredOutput",
        "toolsWithStructuredOutput",
        "strictSchemaMode",
        "reasoningEffort",
      ]);
      // A fake model object can't actually generate — every step degrades to
      // its own FAIL branch rather than throwing out of probeProvider itself.
      for (const r of rows) {
        expect(r.outcome.startsWith("FAIL") || r.outcome.startsWith("PASS")).toBe(true);
      }
    } finally {
      if (original === undefined) delete process.env[envVar];
      else process.env[envVar] = original;
    }
  });
});

describe("daysSince", () => {
  it("computes whole days between an ISO date and today", () => {
    const d = new Date();
    d.setDate(d.getDate() - 200);
    const iso = d.toISOString().slice(0, 10);
    expect(daysSince(iso)).toBeGreaterThanOrEqual(199);
    expect(daysSince(iso)).toBeLessThanOrEqual(201);
  });

  it("returns ~0 for today", () => {
    const iso = new Date().toISOString().slice(0, 10);
    expect(Math.abs(daysSince(iso))).toBeLessThanOrEqual(1);
  });
});

describe("checkDrift — with an injected stub capabilities lookup", () => {
  const capabilityValue = (support: "yes" | "no" | "unknown", lastVerified?: string) => ({
    support,
    verifiedBy: support === "unknown" ? "unverified" : "docs",
    lastVerified,
  });

  const recentIso = new Date().toISOString().slice(0, 10);

  it("flags drift when a live PASS disagrees with a mapped support:'no'", () => {
    const rows = [row("stub", "stub-haiku", "structuredOutput", "PASS")];
    const lookup = () => ({ structuredOutput: capabilityValue("no", recentIso) });
    const { drift, stale } = checkDrift(rows, lookup);
    expect(drift).toHaveLength(1);
    expect(stale).toHaveLength(0);
  });

  it("flags drift when a live FAIL disagrees with a mapped support:'yes'", () => {
    const rows = [row("stub", "stub-haiku", "structuredOutput", "FAIL (error)", "boom")];
    const lookup = () => ({ structuredOutput: capabilityValue("yes", recentIso) });
    const { drift } = checkDrift(rows, lookup);
    expect(drift).toHaveLength(1);
  });

  it("does NOT flag drift when live and map agree", () => {
    const rows = [row("stub", "stub-haiku", "structuredOutput", "PASS")];
    const lookup = () => ({ structuredOutput: capabilityValue("yes", recentIso) });
    const { drift } = checkDrift(rows, lookup);
    expect(drift).toHaveLength(0);
  });

  it("flags staleness (independent of drift) when lastVerified is >180 days old", () => {
    const old = new Date();
    old.setDate(old.getDate() - 200);
    const oldIso = old.toISOString().slice(0, 10);
    const rows = [row("stub", "stub-haiku", "structuredOutput", "PASS")];
    const lookup = () => ({ structuredOutput: capabilityValue("yes", oldIso) });
    const { drift, stale } = checkDrift(rows, lookup);
    expect(drift).toHaveLength(0); // live agrees with the map — not drift
    expect(stale).toHaveLength(1); // but the evidence is old
  });

  it("ignores SKIP rows and rows the lookup can't resolve", () => {
    const rows = [row("stub", "stub-haiku", "*", "SKIP (no key)")];
    const lookup = () => undefined;
    const { drift, stale } = checkDrift(rows, lookup);
    expect(drift).toHaveLength(0);
    expect(stale).toHaveLength(0);
  });
});
