/**
 * Provenance tests — registry-lookup attribution, never a bare heuristic.
 *
 * Fixtures are generated into a throwaway temp dir at setup and removed
 * after. The temp dir lives IN-TREE (next to this file) rather than in
 * os.tmpdir(), for the same reason discover's fixtures do: vitest's module
 * runner refuses to load modules from outside the project root.
 * The fake agent only has the SHAPES matchSlot duck-types (`.data`-carrying
 * judgments/personas) — plus one REAL preset instance from the runtime barrel
 * for the reference-equality path.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROUTING } from "@pattern-stack/agentic-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachProvenance, computeProvenance } from "../provenance.js";

let root: string;
let agentFile: string;
/** The library judgment instance, imported through the SAME url provenance uses. */
let libJudgment: unknown;

const LIB_MODULE = `export const CONTEXT_JUDGMENT = Object.freeze({
  data: Object.freeze({
    domain: "library_context",
    heuristics: ["prefer the library's framing"],
    constraints: [],
    escalationTriggers: [],
    examples: [],
  }),
  toPrompt() {
    return "";
  },
});
`;

const HERE = path.dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
  root = mkdtempSync(path.join(HERE, ".tmp-provenance-"));

  mkdirSync(path.join(root, "roles"), { recursive: true });
  writeFileSync(path.join(root, "roles", "context.mjs"), LIB_MODULE);

  mkdirSync(path.join(root, "agents", "demo"), { recursive: true });
  agentFile = path.join(root, "agents", "demo", "agent.mjs");
  writeFileSync(agentFile, "export const notASlot = 42;\n");

  // Same file URL → same module instance as provenance's library import,
  // so the reference-equality path is exercised for tier "library".
  const mod = (await import(pathToFileURL(path.join(root, "roles", "context.mjs")).href)) as {
    CONTEXT_JUDGMENT: unknown;
  };
  libJudgment = mod.CONTEXT_JUDGMENT;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function judgmentLike(domain: string, heuristics: string[]): unknown {
  return Object.freeze({
    data: Object.freeze({
      domain,
      heuristics,
      constraints: [],
      escalationTriggers: [],
      examples: [],
    }),
    toPrompt: () => "",
  });
}

function demoAgent(): { id: string; file: string; agent: unknown } {
  // Reuses ROUTING's name (domain) with DIFFERENT content → must be "preset?".
  const presetNameClone = judgmentLike(ROUTING.data.domain, ["not what ROUTING says"]);

  return {
    id: "demo",
    file: agentFile,
    agent: {
      role: {
        name: "Demo Role",
        persona: {
          data: { identity: "a demo agent", tone: "plain", priorities: [], principles: [] },
          toPrompt: () => "",
        },
        judgments: [
          libJudgment,
          judgmentLike("hand_rolled", ["made up on the spot"]),
          presetNameClone,
          ROUTING,
        ],
        responsibilities: [],
        capabilities: [],
      },
      mission: {},
      awareness: {},
      background: {},
    },
  };
}

describe("computeProvenance — tier attribution per slot", () => {
  it("attributes each judgment to its enumerated source", async () => {
    const map = await computeProvenance([demoAgent()], root);
    const prov = map.get("demo");
    expect(prov).toBeDefined();
    expect(prov?.file).toBe(agentFile);

    const judgments = prov?.slots.filter((s) => s.slotType === "judgment") ?? [];
    expect(judgments).toHaveLength(4);

    // 1. imported from a roles/ library module → "library" + module path
    expect(judgments[0]).toMatchObject({
      name: "library_context",
      index: 0,
      tier: "library",
      sourcePath: path.join("roles", "context.mjs"),
    });

    // 2. constructed inline → "inline", no source
    expect(judgments[1]).toMatchObject({ name: "hand_rolled", index: 1, tier: "inline" });
    expect(judgments[1]?.sourcePath).toBeUndefined();

    // 3. preset NAME with different content → uncertain "preset?", never "preset".
    // Shares slot 4's name — `index` is what keeps the two chips distinct
    // downstream (the composition join is slotType + index, never name).
    expect(judgments[2]).toMatchObject({
      name: ROUTING.data.domain,
      index: 2,
      tier: "preset?",
      sourcePath: "@pattern-stack/agentic-runtime",
    });

    // 4. the preset const itself → confident "preset"
    expect(judgments[3]).toMatchObject({
      name: ROUTING.data.domain,
      index: 3,
      tier: "preset",
      sourcePath: "@pattern-stack/agentic-runtime",
    });
  });

  it("reports the persona slot under the role's name", async () => {
    const map = await computeProvenance([demoAgent()], root);
    const persona = map.get("demo")?.slots.find((s) => s.slotType === "persona");
    expect(persona).toMatchObject({ name: "Demo Role", index: 0, tier: "inline" });
  });
});

describe("attachProvenance — failure-isolated enrichment", () => {
  it("attaches provenance to each discovered agent", async () => {
    const [enriched] = await attachProvenance([demoAgent()], root);
    expect(enriched?.provenance?.file).toBe(agentFile);
    expect(enriched?.provenance?.slots.length).toBeGreaterThan(0);
  });

  it("returns agents untouched when the project root is unusable", async () => {
    const agents = [demoAgent()];
    // A root that cannot be globbed must not throw out of attachProvenance.
    const enriched = await attachProvenance(agents, "\0invalid");
    expect(enriched).toHaveLength(1);
    expect(enriched[0]?.id).toBe("demo");
  });
});
