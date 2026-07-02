/**
 * Composition introspection route tests.
 *
 * The routes duck-type against live registrations, but the tests build REAL
 * core Agents so the payloads are exercised against the actual composition
 * algebra (Role reference sharing, renderSections invariant, coherence).
 */

import {
  Agent,
  Awareness,
  Background,
  Capability,
  Judgment,
  Mission,
  Persona,
  type PlayDefinition,
  Playbook,
  Role,
  TextManual,
  type ToolDefinition,
  Toolbox,
} from "@agentic-patterns/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer } from "../app.js";
import type { AgentRegistration, ServerConfig } from "../config.js";

/* ------------------------------------------------------------------------ */
/* Fixtures — real core objects                                              */
/* ------------------------------------------------------------------------ */

class FileToolbox extends Toolbox {
  readonly name = "file-tools";
  readonly description = "Read and write local files";
  readonly tools: Record<string, ToolDefinition> = {
    read_file: {
      description: "Read a file from disk",
      parameters: z.object({ path: z.string() }),
      returns: z.object({ content: z.string() }),
      execute: async () => ({ content: "" }),
    },
    write_file: {
      description: "Write a file to disk",
      parameters: z.object({ path: z.string(), content: z.string() }),
      execute: async () => ({}),
    },
  };
}

class CurationPlaybook extends Playbook {
  readonly name = "curation-plays";
  readonly description = "Named curation plays";
  readonly plays: Record<string, PlayDefinition> = {
    archive_stale: {
      description: "Archive files not touched recently",
      parameters: z.object({ days: z.number() }),
      execute: async () => ({}),
    },
  };
}

const fileToolbox = new FileToolbox();

const fileCapability = new Capability(
  "File Management",
  "Manage files on the local disk",
  fileToolbox,
  new TextManual("File Manual", "Prefer reads over writes."),
);

// Second capability mounting the SAME toolbox — the sharesToolboxWith edge.
const curationCapability = new Capability(
  "Data Curation",
  "Curate and prune stored data",
  fileToolbox,
  undefined,
  new CurationPlaybook(),
);

const triageJudgment = new Judgment({
  domain: "triage",
  heuristics: ["Prefer reversible actions"],
});

function makeResearcherRole(): Role {
  return new Role({
    name: "Researcher",
    persona: new Persona({ identity: "a meticulous researcher", tone: "precise" }),
    judgments: [triageJudgment],
    capabilities: [fileCapability, curationCapability],
    defaultModel: "claude-sonnet-4-20250514",
  });
}

// One shared reference for two agents; a structural twin (equal structure,
// different reference) for the third — must NOT merge, only cross-flag.
const researcherRole = makeResearcherRole();
const researcherTwin = makeResearcherRole();

const coveredAwareness = new Awareness({
  domains: [
    {
      name: "Filesystem",
      description: "Local files reachable via file-tools",
      accessMethod: "read_file",
    },
  ],
});

const unreachableAwareness = new Awareness({
  domains: [
    {
      name: "CRM records",
      description: "Customer data in Salesforce",
      accessMethod: "salesforce_api",
    },
  ],
});

const agentAlpha = new Agent({
  role: researcherRole,
  awareness: coveredAwareness,
  background: new Background({ teamContext: { team: "research" } }),
  mission: new Mission({ objective: "Summarize the corpus" }),
  model: "claude-opus-4-20250514",
});

// Zero awareness domains → zero coherence warnings.
const agentBeta = new Agent({
  role: researcherRole,
  mission: new Mission({ objective: "Index the archive" }),
});

const agentGamma = new Agent({
  role: researcherTwin,
  awareness: unreachableAwareness,
  mission: new Mission({ objective: "Audit the records" }),
});

const mockRunner = {
  async run() {
    return {
      response: "ok",
      inputTokens: 0,
      outputTokens: 0,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: "stop",
    };
  },
};

function register(id: string, name: string, agent: Agent): AgentRegistration {
  return { id, name, agent, runner: mockRunner };
}

const registrations = [
  register("alpha", "Alpha", agentAlpha),
  register("beta", "Beta", agentBeta),
  register("gamma", "Gamma", agentGamma),
];

const mockAdminService = {
  async getDashboardStats() {
    return {
      agents: [],
      activeAgentCount: 0,
      totalTokensUsed: 0,
      totalToolCalls: 0,
      totalErrors: 0,
      activeConversationCount: 0,
      uptimeMs: 0,
    };
  },
  async getAgentStats() {
    return undefined;
  },
  async getAllAgentStats() {
    return [];
  },
  async getRecentEvents() {
    return [];
  },
  async getTraceSummaries() {
    return [];
  },
  async getConversations() {
    return [];
  },
  async getToolAnalytics() {
    return [];
  },
  async getTokenUsage() {
    return [];
  },
};

function makeApp(agents: AgentRegistration[] = registrations) {
  const config: ServerConfig = {
    agents,
    adminService: mockAdminService,
    eventBus: {
      subscribe: () => () => {},
      subscribeAll: () => () => {},
      unsubscribeAll: () => {},
      emit: () => {},
    } as unknown as ServerConfig["eventBus"],
    sseExporter: { connect: () => new ReadableStream(), disconnect: () => {} },
  };
  return createServer(config);
}

/* ------------------------------------------------------------------------ */
/* GET /agents/:id/composition                                               */
/* ------------------------------------------------------------------------ */

describe("GET /agents/:id/composition", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await makeApp().request("/agents/nope/composition");
    expect(res.status).toBe(404);
  });

  it("returns the full two-tier payload", async () => {
    const res = await makeApp().request("/agents/alpha/composition");
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;

    expect(body.id).toBe("alpha");
    expect(body.model).toBe("claude-opus-4-20250514");

    // Role slot stack
    expect(body.role.name).toBe("Researcher");
    expect(body.role.defaultModel).toBe("claude-sonnet-4-20250514");
    expect(body.role.persona.text).toContain("meticulous researcher");
    expect(body.role.judgments).toEqual([
      { name: "triage", text: expect.stringContaining("Prefer reversible actions") },
    ]);

    // Capabilities: toolbox tools carry JSON-schema parameters
    expect(body.role.capabilities).toHaveLength(2);
    const fileCap = body.role.capabilities[0];
    expect(fileCap.name).toBe("File Management");
    expect(fileCap.toolbox.name).toBe("file-tools");
    const readTool = fileCap.toolbox.tools.find((t: { name: string }) => t.name === "read_file");
    expect(readTool.parameters.type).toBe("object");
    expect(readTool.parameters.properties.path).toBeDefined();
    expect(readTool.returns.properties.content).toBeDefined();
    expect(fileCap.manual.text).toContain("Prefer reads over writes.");
    expect(fileCap.playbook).toBeNull();
    const curationCap = body.role.capabilities[1];
    expect(curationCap.manual).toBeNull();
    expect(curationCap.playbook).toEqual({ plays: ["archive_stale"] });

    // Instantiation delta
    expect(body.instance.background.teamContext).toEqual({ team: "research" });
    expect(body.instance.mission.objective).toBe("Summarize the corpus");
    expect(body.instance.modelOverride).toBe("claude-opus-4-20250514");
  });

  it("reports null modelOverride when inheriting the role default", async () => {
    const res = await makeApp().request("/agents/beta/composition");
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;
    expect(body.instance.modelOverride).toBeNull();
    expect(body.model).toBe("claude-sonnet-4-20250514");
  });

  it("renders prompt sections whose join reproduces the initial prompt", async () => {
    const res = await makeApp().request("/agents/alpha/composition");
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;

    expect(body.prompt.renderPath).toBe("sections");
    expect(body.prompt.sections.length).toBeGreaterThan(0);
    for (const section of body.prompt.sections) {
      expect(["role", "instance"]).toContain(section.source);
    }
    const joined = body.prompt.sections.map((s: { text: string }) => s.text).join("\n\n");
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).toBe(agentAlpha.renderInitialPrompt());
  });

  it("falls back to the joined render path when renderSections is absent", async () => {
    const legacyAgent = {
      getModel: () => "legacy-model",
      getTools: () => [],
      renderInitialPrompt: () => "Legacy prompt",
      role: { name: "Legacy" },
    };
    const app = makeApp([{ id: "legacy", name: "Legacy", agent: legacyAgent, runner: mockRunner }]);
    const res = await app.request("/agents/legacy/composition");
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;
    expect(body.prompt.renderPath).toBe("joined");
    // The joined blob mixes role AND instance content — its source is
    // honestly "unknown", never confidently attributed to the role.
    expect(body.prompt.sections).toEqual([
      { name: "system", source: "unknown", text: "Legacy prompt" },
    ]);
  });

  it("joins provenance chips from the registration blob", async () => {
    const reg: AgentRegistration = {
      ...register("alpha", "Alpha", agentAlpha),
      file: "agents/alpha/agent.ts",
      provenance: {
        file: "agents/alpha/agent.ts",
        slots: [
          { slotType: "judgment", name: "triage", tier: "library", sourcePath: "src/ctx/j.ts" },
          { slotType: "capability", name: "File Management", tier: "local" },
        ],
      },
    };
    const res = await makeApp([reg]).request("/agents/alpha/composition");
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;
    expect(body.role.judgments[0].provenance).toEqual({
      tier: "library",
      sourcePath: "src/ctx/j.ts",
    });
    expect(body.role.capabilities[0].provenance).toEqual({ tier: "local" });
    expect(body.role.capabilities[1].provenance).toBeUndefined();
  });

  it("joins duplicate-named slots by index — the fork never inherits the preset chip", async () => {
    // Same domain twice: the true preset and a modified fork — exactly the
    // collision class §5 exists to surface. The chips must stay per-slot.
    const forkedRole = new Role({
      name: "Forked",
      persona: new Persona({ identity: "a forked researcher", tone: "wary" }),
      judgments: [triageJudgment, new Judgment({ domain: "triage", heuristics: ["Read broadly"] })],
    });
    const reg: AgentRegistration = {
      ...register(
        "forked",
        "Forked",
        new Agent({ role: forkedRole, mission: new Mission({ objective: "Diverge" }) }),
      ),
      provenance: {
        file: "agents/forked/agent.ts",
        slots: [
          { slotType: "persona", name: "Forked", index: 0, tier: "local", sourcePath: "p.ts" },
          { slotType: "judgment", name: "triage", index: 0, tier: "preset" },
          { slotType: "judgment", name: "triage", index: 1, tier: "preset?" },
        ],
      },
    };
    const res = await makeApp([reg]).request("/agents/forked/composition");
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;
    expect(body.role.persona.provenance).toEqual({ tier: "local", sourcePath: "p.ts" });
    expect(body.role.judgments[0].provenance).toEqual({ tier: "preset" });
    expect(body.role.judgments[1].provenance).toEqual({ tier: "preset?" });
  });
});

/* ------------------------------------------------------------------------ */
/* Coherence check                                                           */
/* ------------------------------------------------------------------------ */

describe("coherence check", () => {
  it("stays silent when awareness domains match the capability surface", async () => {
    const res = await makeApp().request("/agents/alpha/composition");
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;
    expect(body.coherence.heuristic).toBe(true);
    expect(body.coherence.warnings).toEqual([]);
  });

  it("produces zero warnings for agents with zero domains", async () => {
    const res = await makeApp().request("/agents/beta/composition");
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;
    expect(body.coherence.warnings).toEqual([]);
  });

  it("warns on unreachable domains and undescribed capabilities", async () => {
    const res = await makeApp().request("/agents/gamma/composition");
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;
    const kinds = body.coherence.warnings.map((w: { kind: string }) => w.kind);
    expect(kinds).toContain("domain-unreachable");
    expect(kinds).toContain("capability-undescribed");
    const unreachable = body.coherence.warnings.find(
      (w: { kind: string }) => w.kind === "domain-unreachable",
    );
    expect(unreachable.subject).toBe("CRM records");
  });
});

/* ------------------------------------------------------------------------ */
/* GET /roles + /roles/:id                                                   */
/* ------------------------------------------------------------------------ */

describe("GET /roles", () => {
  it("groups by role reference and flags structural twins without merging", async () => {
    const res = await makeApp().request("/roles");
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any[];

    expect(body).toHaveLength(2);
    const [shared, twin] = body;

    // Shared reference → one role entry with both agents.
    expect(shared.id).toBe("researcher");
    expect(shared.agents).toEqual([
      { id: "alpha", name: "Alpha" },
      { id: "beta", name: "Beta" },
    ]);

    // Structural twin → separate entry, deterministic -2 suffix, cross-flagged.
    expect(twin.id).toBe("researcher-2");
    expect(twin.agents).toEqual([{ id: "gamma", name: "Gamma" }]);
    expect(shared.similarTo).toEqual(["researcher-2"]);
    expect(twin.similarTo).toEqual(["researcher"]);
  });
});

describe("GET /roles/:id", () => {
  it("returns 404 for unknown role", async () => {
    const res = await makeApp().request("/roles/nope");
    expect(res.status).toBe(404);
  });

  it("returns slots plus the instantiation matrix", async () => {
    const res = await makeApp().request("/roles/researcher");
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;

    expect(body.name).toBe("Researcher");
    expect(body.persona.text).toContain("meticulous researcher");
    expect(body.judgments[0].name).toBe("triage");
    expect(body.capabilities.map((c: { name: string }) => c.name)).toEqual([
      "File Management",
      "Data Curation",
    ]);

    // Per-slot edges (§6 — the slot drawer's data): the twin role carries the
    // identical triage judgment, so it shows as used-by, never merged away.
    expect(body.judgments[0].usedBy).toEqual({
      roles: ["researcher", "researcher-2"],
      agents: ["alpha", "beta", "gamma"],
    });
    expect(body.judgments[0].similar).toEqual([]);

    // Capability slots link into the capability catalog with their edges.
    expect(body.capabilities[0].id).toBe("file-management-file-tools");
    expect(body.capabilities[0].usedBy).toEqual({
      roles: ["researcher", "researcher-2"],
      agents: ["alpha", "beta", "gamma"],
    });
    expect(body.capabilities[0].sharesToolboxWith).toEqual(["data-curation-file-tools"]);

    // Matrix rows: raw instantiation data per member agent.
    expect(body.agents).toHaveLength(2);
    const [alpha, beta] = body.agents;
    expect(alpha.model).toBe("claude-opus-4-20250514");
    expect(alpha.mission.objective).toBe("Summarize the corpus");
    expect(alpha.awareness.domains).toHaveLength(1);
    expect(beta.model).toBe("claude-sonnet-4-20250514");
    expect(beta.background.teamContext).toEqual({});
  });
});

/* ------------------------------------------------------------------------ */
/* GET /capabilities + /capabilities/:id                                     */
/* ------------------------------------------------------------------------ */

describe("GET /capabilities", () => {
  it("returns the capability-keyed catalog with usedBy and toolbox edges", async () => {
    const res = await makeApp().request("/capabilities");
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any[];

    expect(body.map((e) => e.id)).toEqual([
      "file-management-file-tools",
      "data-curation-file-tools",
    ]);

    const fileEntry = body[0];
    expect(fileEntry.toolbox).toEqual({
      name: "file-tools",
      description: "Read and write local files",
      toolCount: 2,
    });
    // Both roles (shared + twin) mount it; all three agents inherit it.
    expect(fileEntry.usedBy.roles).toEqual(["researcher", "researcher-2"]);
    expect(fileEntry.usedBy.agents).toEqual(["alpha", "beta", "gamma"]);
    // The two capabilities share one toolbox reference.
    expect(fileEntry.sharesToolboxWith).toEqual(["data-curation-file-tools"]);
    expect(body[1].sharesToolboxWith).toEqual(["file-management-file-tools"]);
  });
});

describe("GET /capabilities/:id", () => {
  it("returns 404 for unknown capability", async () => {
    const res = await makeApp().request("/capabilities/nope");
    expect(res.status).toBe(404);
  });

  it("returns full tool schemas, manual, playbook, and edges", async () => {
    const res = await makeApp().request("/capabilities/data-curation-file-tools");
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;

    expect(body.name).toBe("Data Curation");
    expect(body.manual).toBeNull();
    expect(body.playbook).toEqual({ plays: ["archive_stale"] });
    const writeTool = body.toolbox.tools.find((t: { name: string }) => t.name === "write_file");
    expect(writeTool.parameters.properties.content).toBeDefined();
    expect(writeTool.returns).toBeUndefined();
    expect(body.usedBy.roles).toEqual(["researcher", "researcher-2"]);
    expect(body.sharesToolboxWith).toEqual(["file-management-file-tools"]);
  });
});
