/**
 * support-desk — a demo agent exercising SessionScope's "ambient" mode
 * (#308 Mode B): a scope declared WITHOUT an `instantiate` hook.
 *
 * Contrast with `examples/agents/workspace`, which pairs its SessionScope
 * with an `instantiate(context)` hook that CLOSES a fresh agent instance
 * over the parsed scope at conversation-creation time. This agent has no
 * hook at all — the wrapper below declares only `{ id, name, description,
 * agent, scope }`. The server still parses/validates/redacts/defaults the
 * scope on `POST /conversations` (widened availability, decisions.md D5:
 * `instantiation.available = hasHook || hasScope`) and stamps it onto
 * `RunOptions.host.scope` for every turn — this agent's tools just read
 * that live, at CALL TIME, via `readScope`/`requireScope`
 * (`@agentic-patterns/runtime`) instead of a constructor closure. Same
 * scope-bound behavior, no per-conversation object rebuild.
 *
 * The scope is deliberately widget-diverse to exercise more of
 * `SessionScope`/`ScopeItem` than `workspace`'s three plain strings:
 *   - `operator`  — z.string().email(), required
 *   - `tier`      — z.enum(["free", "pro", "enterprise"]), required
 *   - `sandbox`   — z.boolean().default(true) — a per-FIELD zod default,
 *                   distinct from SessionScope's own `.defaults` option
 *   - `apiKey`    — z.string().optional(), redact: true — exercises the
 *                   redaction path end to end (echoed as "[redacted]")
 *
 * Everything is pure/offline (no network, no clock, no randomness), so it
 * runs key-free for introspection; chatting routes through the shared LLM
 * runner like any hand-built agent.
 *
 * Discovery: `ap playground examples` picks this up via the wrapper default
 * export ({ id, name, description, agent, scope }).
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
import { requireScopeAs } from "@agentic-patterns/runtime";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Run scope (deps) — who the agent acts on behalf of, and how
// ---------------------------------------------------------------------------

const supportDeskScope = new SessionScope(
  {
    operator: scopeItem(z.string().email(), {
      description: "The support agent this run is scoped to",
    }),
    tier: scopeItem(z.enum(["free", "pro", "enterprise"]), {
      description: "The customer plan tier this run is scoped to",
    }),
    sandbox: scopeItem(z.boolean().default(true), {
      description: "Sandbox (non-production) mode — true unless explicitly turned off",
    }),
    apiKey: scopeItem(z.string().optional(), {
      description: "Upstream helpdesk API key, when the run needs to act as a real integration",
      redact: true,
    }),
  },
  {
    // Only the fields with no per-field zod default need a value here —
    // `sandbox` and `apiKey` are self-sufficient (schema default / optional).
    // Declaring SessionScope-level defaults at all means a bare
    // `POST /conversations` with no body succeeds instead of 400ing on the
    // required `operator`/`tier` fields (see support-desk/README's DX note).
    defaults: { operator: "duty@support.example", tier: "free" },
    presets: {
      "duty free sandbox": { operator: "duty@support.example", tier: "free", sandbox: true },
      "enterprise on-call": {
        operator: "oncall@support.example",
        tier: "enterprise",
        sandbox: false,
        apiKey: "sk-helpdesk-live-000",
      },
    },
  },
);

type SupportDeskScope = ScopeValue<typeof supportDeskScope>;

// A render-time-only awareness: appears when the caller supplies `{ scope }`
// on renderInitialPrompt/render (the runner does this for every turn once a
// registration declares `scope`, hook or not) and is silently absent
// otherwise (see Awareness.fromScope).
const supportDeskAwareness = Awareness.fromScope(
  supportDeskScope,
  (s) =>
    `Acting for ${s.operator}, scoped to the ${s.tier} tier${s.sandbox ? " (sandbox mode)" : ""}.`,
);

// ---------------------------------------------------------------------------
// Toolbox — ambient support context, scoped to the CALL-TIME operator/tier
// ---------------------------------------------------------------------------

const TierEnum = z.enum(["free", "pro", "enterprise"]).describe("Bound plan tier");

/**
 * Unlike `workspace`'s `WorkspaceAmbientToolbox` (scope injected once via a
 * constructor closure, from an `instantiate` hook), this toolbox holds no
 * scope at all — there is no hook to close it over. Each tool reads the
 * live, per-call scope off `ToolExecutionContext.host.scope` via
 * `requireScopeAs` (fail-loud read + typed cast in one call). That scope is
 * still the SAME parsed/redacted value for the conversation's whole lifetime
 * (Conversation forwards one fixed `_host` to every turn) — the only thing
 * that moved is WHEN the tool reads it: dispatch time instead of build time.
 */
const supportAmbientTools = toolbox(
  "support-ambient",
  "Read-only ambient context about the operator's support queue — tickets, escalation policy, and who they're acting as.",
  {
    whoami: defineTool({
      description: "Who this run is acting on behalf of, and under what plan tier.",
      parameters: z.object({}),
      returns: z.object({
        operator: z.string().describe("Who the run acts for"),
        tier: TierEnum,
        sandbox: z.boolean().describe("True when running against sandbox data"),
      }),
      // `requireScopeAs<T>` = fail-loud read + typed cast in one call. Before it
      // existed this line read `requireScope(ctx) as SupportDeskScope`.
      execute: async (_args, ctx) => {
        const scope = requireScopeAs<SupportDeskScope>(ctx);
        return { operator: scope.operator, tier: scope.tier, sandbox: scope.sandbox };
      },
    }),
    list_open_tickets: defineTool({
      description: "Open tickets in the operator's queue, SLA-tagged by the bound plan tier.",
      parameters: z.object({}),
      returns: z.object({
        tickets: z
          .array(
            z.object({
              id: z.string().describe("Ticket ID"),
              subject: z.string().describe("Ticket subject line"),
              sla: z.string().describe("SLA implied by the bound tier"),
            }),
          )
          .describe("Open tickets in the operator's queue"),
      }),
      execute: async (_args, ctx) => {
        const scope = requireScopeAs<SupportDeskScope>(ctx);
        const sla = SLA_BY_TIER[scope.tier];
        const tag = scope.sandbox ? "[sandbox] " : "";
        return {
          tickets: [
            { id: "tkt_1001", subject: `${tag}Login failing after password reset`, sla },
            { id: "tkt_1002", subject: `${tag}Export stuck at 90%`, sla },
          ],
        };
      },
    }),
    escalation_policy: defineTool({
      description: "Who to escalate to for the bound plan tier.",
      parameters: z.object({}),
      returns: z.object({
        tier: TierEnum,
        contact: z.string().describe("Escalation contact for that tier"),
      }),
      execute: async (_args, ctx) => {
        const scope = requireScopeAs<SupportDeskScope>(ctx);
        return { tier: scope.tier, contact: ESCALATION_BY_TIER[scope.tier] };
      },
    }),
  },
);

const SLA_BY_TIER: Record<SupportDeskScope["tier"], string> = {
  free: "best-effort",
  pro: "24h",
  enterprise: "2h",
};

const ESCALATION_BY_TIER: Record<SupportDeskScope["tier"], string> = {
  free: "community forum",
  pro: "priority queue",
  enterprise: "named TAM (on-call)",
};

// ---------------------------------------------------------------------------
// Manual for the ambient capability
// ---------------------------------------------------------------------------

const ambientManual = new SimpleManual(
  "Support Ambient Manual",
  "How to read the operator's support queue without side effects.",
  [
    new ManualSection("Vocabulary", "Terms used across the ambient tools.", [
      { name: "operator", description: "The support agent this run is scoped to" },
      { name: "tier", description: "The customer plan tier — drives SLA and escalation path" },
      { name: "sandbox", description: "When true, ticket data is synthetic, never live" },
    ]),
    new ManualSection("Rules", "Hard constraints.", [
      {
        name: "read-only",
        description: "These tools never write — never claim you sent or changed anything",
      },
      {
        name: "scoped",
        description: "All results are for the bound operator/tier only, never another one",
      },
    ]),
  ],
);

// ---------------------------------------------------------------------------
// Build — Role x Mission. No scope parameter: this agent is built ONCE,
// module-load time, since there is no instantiate hook to rebuild it per
// conversation. Its tools stay correct per-conversation anyway, because they
// read the scope live at call time instead of from a build-time closure.
// ---------------------------------------------------------------------------

function buildSupportDeskAgent() {
  const role = new RoleBuilder("support-desk")
    .withPersona(
      new Persona({
        identity:
          "A support-desk copilot that reads the ambient ticket queue for the bound operator",
        tone: "crisp and reassuring",
        priorities: ["act only on behalf of the scoped operator", "never fabricate ticket data"],
      }),
    )
    .withJudgment(
      new Judgment({
        domain: "customer support",
        heuristics: ["Lead with SLA when a ticket's tier implies urgency"],
        constraints: ["Only surface tickets for the bound operator/tier"],
      }),
    )
    .withCapability(
      new Capability(
        "support-ambient",
        "Read-only ambient context about the operator's support queue — tickets, escalation policy, and who they're acting as.",
        supportAmbientTools,
        ambientManual,
      ),
    )
    .withResponsibility(
      new Responsibility({
        key: "assist",
        name: "Assist the operator",
        description: "Read ambient ticket context for the scoped operator and tier",
      }),
    )
    .withDefaultModel("haiku")
    .build();

  const mission = new Mission({
    objective: "Help the scoped operator triage their support queue",
    successCriteria: [
      "Every answer is scoped to the bound operator and tier",
      "SLA and escalation guidance matches the bound tier",
    ],
  });

  return new AgentBuilder(role).withAwareness(supportDeskAwareness).withMission(mission).build();
}

// ---------------------------------------------------------------------------
// Wrapper export — Mode B: no `instantiate`/`instantiateDefaults`. Just
// `{ id, name, description, agent, scope }`. The server still validates,
// defaults, redacts, and stamps `host.scope` from `scope` alone.
// ---------------------------------------------------------------------------

export default {
  id: "support-desk",
  name: "Support Desk",
  description:
    "Support-queue copilot — reads ambient ticket context scoped per operator and plan tier, no instantiate hook.",
  agent: buildSupportDeskAgent(),
  scope: supportDeskScope,
};
