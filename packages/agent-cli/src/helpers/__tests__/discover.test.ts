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
import {
  discoverAgents,
  inferIdentity,
  isAgentLikeShape,
  loadAgentsFromFile,
} from "../discover.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, "__fixtures__");
const agents = path.join(FX, "agents");

describe("loadAgentsFromFile — accepted export shapes", () => {
  it("bare default export → inferred id/name from folder", async () => {
    const [a] = await loadAgentsFromFile(path.join(agents, "calc/agent.mjs"), FX);
    expect(a).toMatchObject({ id: "calc", name: "Calc" });
    expect(a?.description).toBeUndefined();
  });

  it("`rootAgent` named export → inferred from folder", async () => {
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

// ---------------------------------------------------------------------------
// AgentLike discoverability (isAgentLikeShape / asAgent() promotion, issue #97)
// ---------------------------------------------------------------------------

describe("isAgentLikeShape", () => {
  it("accepts an AgentLike-shaped object (role.name + getModel/renderInitialPrompt)", () => {
    expect(
      isAgentLikeShape({
        role: { name: "Pipe" },
        getModel: () => "sonnet",
        renderInitialPrompt: () => "",
      }),
    ).toBe(true);
  });

  it("rejects a bare { role: { name } } with no methods", () => {
    expect(isAgentLikeShape({ role: { name: "just-a-name" } })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isAgentLikeShape(null)).toBe(false);
    expect(isAgentLikeShape(42)).toBe(false);
  });
});

describe("loadAgentsFromFile — AgentLike (promoted-Node) discoverability", () => {
  it("a promoted-shaped direct export is discovered via isAgentLikeShape", async () => {
    const [a] = await loadAgentsFromFile(path.join(agents, "promoted/agent.mjs"), FX);
    expect(a).toMatchObject({ id: "promoted" });
    expect(a?.agent.role.name).toBe("Promoted Pipe");
  });

  it("a promoted-shaped agent inside a registration wrapper is discovered", async () => {
    const [a] = await loadAgentsFromFile(path.join(agents, "promoted-wrapped/agent.mjs"), FX);
    expect(a).toMatchObject({ id: "wrapped-promoted", name: "Wrapped Promoted" });
  });

  it("no regression — a full core Agent (isAgentShape) still discovers unchanged", async () => {
    const [a] = await loadAgentsFromFile(path.join(agents, "calc/agent.mjs"), FX);
    expect(a).toMatchObject({ id: "calc", name: "Calc" });
  });

  it("negative case — an object satisfying neither shape is skipped, siblings still found", async () => {
    const found = await loadAgentsFromFile(path.join(agents, "near-miss/agent.mjs"), FX);
    expect(found.map((a) => a.id)).toEqual(["real"]);
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

describe("loadAgentsFromFile — registration `evals` declaration", () => {
  it("passes valid refs through and drops malformed entries", async () => {
    const agents = path.join(FX, "agents");
    const [a] = await loadAgentsFromFile(path.join(agents, "graded/agent.mjs"), FX);
    expect(a?.id).toBe("graded");
    expect(a?.evals).toEqual([
      { setId: "xd-interpret", grades: "scope shape", step: "interpret", scorer: "none" },
      { setId: "e2e-answer" },
    ]);
  });

  it("leaves evals undefined on registrations that declare none", async () => {
    const agents = path.join(FX, "agents");
    const [a] = await loadAgentsFromFile(path.join(agents, "todo/agent.mjs"), FX);
    expect(a?.evals).toBeUndefined();
  });
});

describe("loadAgentsFromFile — registration `contextRedactKeys` declaration (#268 PR-3)", () => {
  it("passes a well-formed array of strings through verbatim", async () => {
    const agents = path.join(FX, "agents");
    const [a] = await loadAgentsFromFile(path.join(agents, "scoped/agent.mjs"), FX);
    expect(a?.id).toBe("scoped");
    expect(a?.contextRedactKeys).toEqual(["userId", "secret"]);
  });

  it("drops a malformed declaration entirely (non-string entry) rather than salvaging a subset", async () => {
    const agents = path.join(FX, "agents");
    const [a] = await loadAgentsFromFile(path.join(agents, "scoped-bad/agent.mjs"), FX);
    expect(a?.id).toBe("scoped-bad");
    expect(a?.contextRedactKeys).toBeUndefined();
  });

  it("leaves contextRedactKeys undefined on registrations that declare none", async () => {
    const agents = path.join(FX, "agents");
    const [a] = await loadAgentsFromFile(path.join(agents, "todo/agent.mjs"), FX);
    expect(a?.contextRedactKeys).toBeUndefined();
  });
});

describe("loadAgentsFromFile — registration `scope` declaration (#308)", () => {
  it("passes a well-formed SessionScope-shaped object through by identity", async () => {
    const agents = path.join(FX, "agents");
    const [a] = await loadAgentsFromFile(path.join(agents, "session-scoped/agent.mjs"), FX);
    expect(a?.id).toBe("session-scoped");
    expect(a?.scope).toBeDefined();
    // Verbatim pass-through, not a copy — calling the fake's own `.parse`
    // proves the exact object made the trip (the duck-type check narrows,
    // it never reconstructs).
    expect(a?.scope?.parse({ tenant: "override" })).toEqual({ tenant: "override" });
    expect(a?.scope?.redactKeys).toEqual(["secret"]);
    expect(a?.scope?.defaults).toEqual({ tenant: "acme" });
  });

  it("drops a malformed declaration entirely (`.parse` not a function) rather than salvaging a subset", async () => {
    const agents = path.join(FX, "agents");
    const [a] = await loadAgentsFromFile(path.join(agents, "session-scoped-bad/agent.mjs"), FX);
    expect(a?.id).toBe("session-scoped-bad");
    expect(a?.scope).toBeUndefined();
  });

  it("leaves scope undefined on registrations that declare none", async () => {
    const agents = path.join(FX, "agents");
    const [a] = await loadAgentsFromFile(path.join(agents, "todo/agent.mjs"), FX);
    expect(a?.scope).toBeUndefined();
  });
});
