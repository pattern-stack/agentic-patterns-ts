/**
 * scope-echo — proves SessionScope (#308) survives the promoted-node
 * delegation seam, KEYLESS.
 *
 * `examples/agents/pipeline2` is the reference for `asAgent()` promotion
 * generally (a Sequential pipeline promoted to a chattable Agent). This
 * example is narrower: ONE pure `FunctionStep` — no LLM, no Sequential, no
 * retry — whose entire job is to read `NodeRunContext.scope` and hand back a
 * deterministic string echoing the bound values. That isolates exactly one
 * thing: does a conversation-bound scope actually reach a promoted node's
 * leaf, through the FULL server seam —
 *
 *   POST /conversations { scope }
 *     -> scope.parse() (validate + default)
 *     -> buildScopeHost(parsed)                  (agent-runtime/scope-host.ts)
 *     -> Conversation._host                       (fixed for the conversation's life)
 *     -> NodeBackedRunner.run() options.host.scope (agent-runtime/as-agent.ts)
 *     -> NodeRunContext.scope
 *     -> this FunctionStep's `ctx` argument
 *
 * — with no API key anywhere on that path. A chat reply that contains the
 * bound `workspace`/`user` values IS the proof; nothing here calls a model.
 *
 * Discovery: `ap playground examples` picks this up via the wrapper default
 * export ({ id, name, agent, scope }) — `agent` is the `asAgent()`-promoted
 * node, exactly the shape `workflows/as-agent.ts`'s `isPromotedAgent` /
 * `agent-cli`'s `isAgentLikeShape` expect.
 */

import { type ScopeValue, SessionScope, scopeItem } from "@pattern-stack/agentic-core";
import { FunctionStep, asAgent, readScope } from "@pattern-stack/agentic-runtime";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Run scope — small on purpose: workspace + user, the same two fields
// `workspace`'s SessionScope declares (minus `region`), so the promoted-node
// path and the ordinary-Agent path are directly comparable.
// ---------------------------------------------------------------------------

const echoScope = new SessionScope(
  {
    workspace: scopeItem(z.string().min(1), { description: "Tenant workspace" }),
    user: scopeItem(z.string().email(), { description: "Acting user" }),
  },
  {
    defaults: { workspace: "acme-sales", user: "sam@acme.dev" },
    presets: {
      "sam @ acme": { workspace: "acme-sales", user: "sam@acme.dev" },
    },
  },
);

type EchoScope = ScopeValue<typeof echoScope>;

// ---------------------------------------------------------------------------
// The one leaf — deterministic, no LLM. `readScope` accepts a node's
// `NodeRunContext` directly (`ctx.scope`) as well as a tool's
// `ToolExecutionContext` (`ctx.host.scope`) — same accessor as
// `support-desk`'s tools use, different context shape.
// ---------------------------------------------------------------------------

const echoStep = new FunctionStep<string, string>({
  name: "echo-scope",
  fn: (message, _scratchpad, ctx) => {
    const scope = readScope(ctx) as EchoScope | undefined;
    if (!scope) {
      return `No scope bound for this run. You said: "${message}"`;
    }
    return `Bound scope: workspace=${scope.workspace}, user=${scope.user}. You said: "${message}"`;
  },
});

// ---------------------------------------------------------------------------
// Promote + wrap — `TIn = string` so no `coerceIn` is needed; the default
// `renderOut` (string passthrough) is correct since `echoStep` already
// returns a string.
// ---------------------------------------------------------------------------

export default {
  id: "scope-echo",
  name: "Scope Echo",
  description:
    "Promoted single-FunctionStep pipeline that echoes the bound SessionScope — proves scope reaches a Node leaf with no LLM call.",
  agent: asAgent(echoStep, {
    role: {
      name: "ScopeEcho",
      description: "Echoes the bound SessionScope from a pure FunctionStep — keyless.",
    },
  }),
  scope: echoScope,
};
