/**
 * workspace — a demo agent that carries BOTH multiple capabilities AND a
 * per-conversation run scope (deps), so the playground's chat surface has
 * something to show in every panel:
 *
 *   - Tools rail: two capabilities, each with its own overarching description
 *     and a small toolbox of pure tools — grouped, hover/click-inspectable.
 *   - Scope ("deps") readout: this agent exports an `instantiate(context)`
 *     hook + `instantiateDefaults`, so the chat binds a per-user scope
 *     ({ workspace, user, region }) and the rail can show who the run acts on
 *     behalf of. `fetchTips`-style, the tools CLOSE OVER that scope, so the
 *     canned data they return is visibly scoped to the bound user.
 *
 * Everything is pure/offline (no network, no clock, no randomness), so it runs
 * key-free for introspection; chatting routes through the shared LLM runner
 * like any hand-built agent.
 *
 * Discovery: `ap playground examples` picks this up via the wrapper default
 * export ({ id, name, agent, instantiate, instantiateDefaults }).
 */

import {
  AgentBuilder,
  Capability,
  Judgment,
  ManualSection,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
  SimpleManual,
  type ToolDefinition,
  Toolbox,
} from "@agentic-patterns/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Run scope (deps) — who the agent acts on behalf of
// ---------------------------------------------------------------------------

interface WorkspaceScope {
  workspace: string;
  user: string;
  region: string;
}

const DEFAULT_SCOPE: WorkspaceScope = {
  workspace: "acme-sales",
  user: "sam@acme.dev",
  region: "us-east",
};

// ---------------------------------------------------------------------------
// Toolbox 1 — ambient workspace context (read-only), scoped to `scope.user`
// ---------------------------------------------------------------------------

class WorkspaceAmbientToolbox extends Toolbox {
  readonly name = "workspace-ambient";
  readonly description =
    "Read-only ambient context about the operator's workspace — meetings, mail, and open action items.";

  constructor(private readonly scope: WorkspaceScope) {
    super();
  }

  readonly tools: Record<string, ToolDefinition> = {
    list_meetings: {
      description: "Upcoming meetings on the operator's calendar.",
      parameters: z.object({}),
      returns: z.object({ meetings: z.array(z.object({ title: z.string(), when: z.string() })) }),
      execute: async () => ({
        meetings: [
          { title: `Pipeline review (${this.scope.user})`, when: "Mon 10:00" },
          { title: "Renewal call — Northwind", when: "Tue 14:00" },
        ],
      }),
    },
    list_emails: {
      description: "Recent email threads in the operator's inbox.",
      parameters: z.object({}),
      returns: z.object({ threads: z.array(z.object({ subject: z.string(), from: z.string() })) }),
      execute: async () => ({
        threads: [
          { subject: "Re: pricing", from: "buyer@northwind.io" },
          { subject: "Contract redlines", from: "legal@acme.dev" },
        ],
      }),
    },
    list_action_items: {
      description: "Open action items assigned to the operator.",
      parameters: z.object({}),
      returns: z.object({ items: z.array(z.string()) }),
      execute: async () => ({
        items: ["Send Northwind the security packet", "Confirm renewal date with legal"],
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Toolbox 2 — deal resolution (fuzzy reference → concrete record)
// ---------------------------------------------------------------------------

class DealResolutionToolbox extends Toolbox {
  readonly name = "deal-resolution";
  readonly description =
    "Resolve a fuzzy reference — a name, a participant, or an org — to a concrete deal record.";

  readonly tools: Record<string, ToolDefinition> = {
    resolve_by_name: {
      description: "Resolve a deal by its name or a close match.",
      parameters: z.object({ query: z.string().describe("Deal name or fragment") }),
      returns: z.object({ dealId: z.string(), name: z.string(), confidence: z.number() }),
      execute: async (args) => {
        const { query } = args as { query: string };
        return { dealId: "deal_northwind", name: `Northwind — ${query}`, confidence: 0.82 };
      },
    },
    resolve_by_participant: {
      description: "Find deals a given participant is on.",
      parameters: z.object({ email: z.string().describe("Participant email") }),
      returns: z.object({ deals: z.array(z.string()) }),
      execute: async (args) => {
        const { email } = args as { email: string };
        return { deals: email.includes("northwind") ? ["deal_northwind"] : [] };
      },
    },
    resolve_org: {
      description: "Resolve an organization to its deals.",
      parameters: z.object({ org: z.string().describe("Organization name") }),
      returns: z.object({ org: z.string(), deals: z.array(z.string()) }),
      execute: async (args) => {
        const { org } = args as { org: string };
        return { org, deals: ["deal_northwind", "deal_northwind_expansion"] };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Manual for the ambient capability (so its Capabilities detail page is rich)
// ---------------------------------------------------------------------------

const ambientManual = new SimpleManual(
  "Workspace Ambient Manual",
  "How to read the operator's workspace context without side effects.",
  [
    new ManualSection("Vocabulary", "Terms used across the ambient tools.", [
      { name: "operator", description: "The user this run is scoped to (see the run scope)" },
      { name: "thread", description: "An email conversation, newest message first" },
    ]),
    new ManualSection("Rules", "Hard constraints.", [
      { name: "read-only", description: "These tools never write — never claim you sent or changed anything" },
      { name: "scoped", description: "All results are for the bound operator only, never another user" },
    ]),
  ],
);

// ---------------------------------------------------------------------------
// Build — Role x Mission, scoped to a given run context
// ---------------------------------------------------------------------------

function buildWorkspaceAgent(scope: WorkspaceScope) {
  const role = new RoleBuilder("workspace")
    .withPersona(
      new Persona({
        identity: "A sales-workspace copilot that reads ambient context and resolves deals",
        tone: "crisp and helpful",
        priorities: ["act only on behalf of the scoped operator", "never fabricate records"],
      }),
    )
    .withJudgment(
      new Judgment({
        domain: "sales workspace",
        heuristics: ["Resolve fuzzy references before acting on them"],
        constraints: ["Only surface data for the bound operator"],
      }),
    )
    .withCapability(
      new Capability(
        "workspace-ambient",
        "Read-only ambient context about the operator's workspace — meetings, mail, and open action items.",
        new WorkspaceAmbientToolbox(scope),
        ambientManual,
      ),
    )
    .withCapability(
      new Capability(
        "deal-resolution",
        "Resolve a fuzzy reference — a name, a participant, or an org — to a concrete deal record.",
        new DealResolutionToolbox(),
      ),
    )
    .withResponsibility(
      new Responsibility({
        key: "assist",
        name: "Assist the operator",
        description: "Read ambient context and resolve deals for the scoped operator",
      }),
    )
    .withDefaultModel("haiku")
    .build();

  const mission = new Mission({
    objective: "Help the scoped operator navigate their workspace and deals",
    success_criteria: ["Every answer is scoped to the bound operator", "Fuzzy refs are resolved, not guessed"],
  });

  return new AgentBuilder(role).withMission(mission).build();
}

// ---------------------------------------------------------------------------
// Wrapper export — carries the per-conversation `instantiate(context)` hook so
// the playground binds a run scope (deps) and echoes it back for display.
// ---------------------------------------------------------------------------

export default {
  id: "workspace",
  name: "Workspace",
  description: "Sales-workspace copilot — reads ambient context and resolves deals, scoped per operator.",
  agent: buildWorkspaceAgent(DEFAULT_SCOPE),
  instantiate: async (context?: Record<string, unknown>) =>
    buildWorkspaceAgent({ ...DEFAULT_SCOPE, ...(context ?? {}) } as WorkspaceScope),
  instantiateDefaults: DEFAULT_SCOPE,
};
