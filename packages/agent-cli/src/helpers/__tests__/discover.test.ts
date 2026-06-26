/**
 * Discovery tests — convention-bounded scan + structural Agent introspection.
 *
 * Fixtures live in-tree under `__fixtures__/` (committed `.mjs` files). They
 * use a fake "agent" that only has the Agent SHAPE (role/mission/awareness/
 * background) that `isAgentShape` duck-types — not a real agent-core Agent.
 * (In-tree fixtures, not os.tmpdir, so vitest's module runner can import them.)
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverAgents, inferIdentity, loadAgentsFromFile } from "../discover.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, "__fixtures__");
const agents = path.join(FX, "agents");

describe("loadAgentsFromFile — accepted export shapes", () => {
  it("bare default export → inferred id/name from folder", async () => {
    const [a] = await loadAgentsFromFile(path.join(agents, "calc/agent.mjs"), FX);
    expect(a).toMatchObject({ id: "calc", name: "Calc" });
    expect(a?.description).toBeUndefined();
  });

  it("`rootAgent` named export (ADK spelling) → inferred from folder", async () => {
    const [a] = await loadAgentsFromFile(path.join(agents, "coach/agent.mjs"), FX);
    expect(a).toMatchObject({ id: "coach", name: "Coach" });
  });

  it("arbitrary named export → name from export key (trailing 'Agent' stripped)", async () => {
    const [a] = await loadAgentsFromFile(path.join(agents, "pack/agent.mjs"), FX);
    expect(a).toMatchObject({ id: "reviewer", name: "Reviewer" });
  });

  it("multiple agents per file → all discovered", async () => {
    const found = await loadAgentsFromFile(path.join(agents, "multi/agent.mjs"), FX);
    expect(found.map((a) => a.id).sort()).toEqual(["alpha", "beta"]);
  });

  it("legacy registration wrapper → explicit id/name/description honored", async () => {
    const [a] = await loadAgentsFromFile(path.join(agents, "todo/agent.mjs"), FX);
    expect(a).toMatchObject({ id: "todo", name: "Todo Manager", description: "tasks" });
  });

  it("non-agent exports are skipped; a file with none errors", async () => {
    await expect(loadAgentsFromFile(path.join(agents, "helpers/agent.mjs"), FX)).rejects.toThrow(
      /no Agent exports/,
    );
  });

  it("does NOT invoke arbitrary named functions (only default/rootAgent)", async () => {
    // `boom` throws if called — its presence must not break discovery.
    const found = await loadAgentsFromFile(path.join(agents, "safe/agent.mjs"), FX);
    expect(found.map((a) => a.id)).toEqual(["safe"]);
  });
});

describe("inferIdentity — domain namespacing", () => {
  it("top-level agents/ → no domain", () => {
    const file = path.join(FX, "agents/calculator/agent.ts");
    expect(inferIdentity(file, "default", FX)).toEqual({ id: "calculator", name: "Calculator" });
  });

  it("nested {domain}/agents/ → id namespaced by domain", () => {
    const file = path.join(FX, "dealbrain/agents/retrieval/agent.ts");
    expect(inferIdentity(file, "default", FX)).toEqual({
      id: "dealbrain/retrieval",
      name: "Retrieval",
    });
  });

  it("flat <name>.agent.ts filename form", () => {
    const file = path.join(FX, "agents/echo.agent.ts");
    expect(inferIdentity(file, "default", FX)).toEqual({ id: "echo", name: "Echo" });
  });
});

describe("discoverAgents — recursive across domains + dedupe", () => {
  it("finds child agents in nested {domain}/agents/ and namespaces their ids", async () => {
    const { agents: found, errors } = await discoverAgents(FX, ["*/agents/**/agent.{ts,js,mjs}"]);
    expect(errors).toEqual([]);
    expect(found.map((a) => a.id).sort()).toEqual(["canvas/writer", "dealbrain/retrieval"]);
  });
});
