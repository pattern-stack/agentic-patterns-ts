/**
 * workspace — a demo agent that carries BOTH multiple capabilities AND a
 * per-conversation run scope (deps), so the playground's chat surface has
 * something to show in every panel:
 *
 *   - Tools rail: two capabilities, each with its own overarching description
 *     and a small toolbox of pure tools — grouped, hover/click-inspectable.
 *   - Scope readout: this agent declares a `SessionScope`
 *     ({ workspace, user, region }, validated + defaulted + presets) plus an
 *     `instantiate(context)` hook, so the chat binds a per-user scope and the
 *     rail can show who the run acts on behalf of. `fetchTips`-style, the
 *     tools CLOSE OVER that scope, so the canned data they return is visibly
 *     scoped to the bound user.
 *
 * Everything is pure/offline (no network, no clock, no randomness), so it runs
 * key-free for introspection; chatting routes through the shared LLM runner
 * like any hand-built agent.
 *
 * Discovery: `ap playground examples` picks this up via the wrapper default
 * export ({ id, name, agent, scope, instantiate }).
 */

import {
  AgentBuilder,
  Awareness,
  Capability,
  Judgment,
  ManualSection,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
  type ScopeValue,
  SessionScope,
  SimpleManual,
  defineTool,
  scopeItem,
  toolbox,
} from "@agentic-patterns/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Run scope (deps) — who the agent acts on behalf of
// ---------------------------------------------------------------------------

const DEFAULT_SCOPE = {
  workspace: "acme-sales",
  user: "sam@acme.dev",
  region: "us-east",
};

const workspaceScope = new SessionScope(
  {
    workspace: scopeItem(z.string().min(1), { description: "Tenant workspace" }),
    user: scopeItem(z.string().email(), { description: "Acting user" }),
    region: scopeItem(z.string().min(1), { description: "Data region" }),
  },
  {
    defaults: DEFAULT_SCOPE,
    presets: {
      "sam @ acme": DEFAULT_SCOPE,
      "li @ globex": { workspace: "globex-ops", user: "li@globex.dev", region: "eu-west" },
    },
  },
);

type WorkspaceScope = ScopeValue<typeof workspaceScope>;

// A render-time-only awareness: no domains, just a scope-derived line that
// appears when the caller supplies `{ scope }` on renderInitialPrompt/render
// and is silently absent otherwise (see Awareness.fromScope).
const workspaceAwareness = Awareness.fromScope(
  workspaceScope,
  (s) => `Acting on behalf of ${s.user} in workspace ${s.workspace} (${s.region}).`,
);

// ---------------------------------------------------------------------------
// Toolbox 1 — ambient workspace context (read-only), scoped to `scope.user`
// ---------------------------------------------------------------------------

/**
 * Dependency injection without a class: the scope is a plain function
 * parameter, and each `execute` closes over it. A `toolbox()` literal handles
 * constructor-injected state exactly as well as `class X extends Toolbox` did —
 * the closure IS the constructor.
 */
const workspaceAmbientTools = (scope: WorkspaceScope) =>
  toolbox(
    "workspace-ambient",
    "Read-only ambient context about the operator's workspace — meetings, mail, and open action items.",
    {
      list_meetings: defineTool({
        description: "Upcoming meetings on the operator's calendar.",
        parameters: z.object({}),
        returns: z.object({
          meetings: z
            .array(
              z.object({
                title: z.string().describe("Meeting title"),
                when: z.string().describe("Human-readable start time"),
              }),
            )
            .describe("Upcoming meetings"),
        }),
        execute: async () => ({
          meetings: [
            { title: `Pipeline review (${scope.user})`, when: "Mon 10:00" },
            { title: "Renewal call — Northwind", when: "Tue 14:00" },
          ],
        }),
      }),
      list_emails: defineTool({
        description: "Recent email threads in the operator's inbox.",
        parameters: z.object({}),
        returns: z.object({
          threads: z
            .array(
              z.object({
                subject: z.string().describe("Thread subject"),
                from: z.string().describe("Sender address"),
              }),
            )
            .describe("Recent threads"),
        }),
        execute: async () => ({
          threads: [
            { subject: "Re: pricing", from: "buyer@northwind.io" },
            { subject: "Contract redlines", from: "legal@acme.dev" },
          ],
        }),
      }),
      list_action_items: defineTool({
        description: "Open action items assigned to the operator.",
        parameters: z.object({}),
        returns: z.object({
          items: z.array(z.string()).describe("Open action items"),
        }),
        execute: async () => ({
          items: ["Send Northwind the security packet", "Confirm renewal date with legal"],
        }),
      }),
    },
  );

// ---------------------------------------------------------------------------
// Toolbox 2 — deal resolution (fuzzy reference → concrete record)
// ---------------------------------------------------------------------------

const dealResolutionTools = toolbox(
  "deal-resolution",
  "Resolve a fuzzy reference — a name, a participant, or an org — to a concrete deal record.",
  {
    resolve_by_name: defineTool({
      description: "Resolve a deal by its name or a close match.",
      parameters: z.object({ query: z.string().describe("Deal name or fragment") }),
      returns: z.object({
        dealId: z.string().describe("Resolved deal ID"),
        name: z.string().describe("Resolved deal name"),
        confidence: z.number().describe("Match confidence, 0-1"),
      }),
      execute: async ({ query }) => ({
        dealId: "deal_northwind",
        name: `Northwind — ${query}`,
        confidence: 0.82,
      }),
    }),
    resolve_by_participant: defineTool({
      description: "Find deals a given participant is on.",
      parameters: z.object({ email: z.string().describe("Participant email") }),
      returns: z.object({ deals: z.array(z.string()).describe("Matching deal IDs") }),
      execute: async ({ email }) => ({
        deals: email.includes("northwind") ? ["deal_northwind"] : [],
      }),
    }),
    resolve_org: defineTool({
      description: "Resolve an organization to its deals.",
      parameters: z.object({ org: z.string().describe("Organization name") }),
      returns: z.object({
        org: z.string().describe("Echoed organization name"),
        deals: z.array(z.string()).describe("Deal IDs for that org"),
      }),
      execute: async ({ org }) => ({
        org,
        deals: ["deal_northwind", "deal_northwind_expansion"],
      }),
    }),
  },
);

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
      {
        name: "read-only",
        description: "These tools never write — never claim you sent or changed anything",
      },
      {
        name: "scoped",
        description: "All results are for the bound operator only, never another user",
      },
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
        workspaceAmbientTools(scope),
        ambientManual,
      ),
    )
    .withCapability(
      new Capability(
        "deal-resolution",
        "Resolve a fuzzy reference — a name, a participant, or an org — to a concrete deal record.",
        dealResolutionTools,
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
    successCriteria: [
      "Every answer is scoped to the bound operator",
      "Fuzzy refs are resolved, not guessed",
    ],
  });

  return new AgentBuilder(role).withAwareness(workspaceAwareness).withMission(mission).build();
}

// ---------------------------------------------------------------------------
// Wrapper export — carries the per-conversation `instantiate(context)` hook so
// the playground binds a run scope (deps) and echoes it back for display.
// ---------------------------------------------------------------------------

export default {
  id: "workspace",
  name: "Workspace",
  description:
    "Sales-workspace copilot — reads ambient context and resolves deals, scoped per operator.",
  agent: buildWorkspaceAgent(DEFAULT_SCOPE),
  scope: workspaceScope,
  instantiate: async (context?: Record<string, unknown>) =>
    buildWorkspaceAgent(workspaceScope.parse({ ...DEFAULT_SCOPE, ...(context ?? {}) })),
};
