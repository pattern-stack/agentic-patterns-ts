# @agentic-patterns/adk — design for bridging core into @google/adk

> Produced 2026-07-05 by a 3-lane parallel design workflow against real core source (v0.6.0) and the live @google/adk API (google/adk-js, docs at adk.dev). Draft code is UNCOMPILED — @google/adk is not yet a dependency; signatures marked verify-against-adk-js-source need a compile pass.

## Premise

core is a pure prompt-and-schema compiler (deps: zod only; zero execution). ADK owns the execution loop (Runner, sessions, model calls). The bridge package @agentic-patterns/adk (deps: core; peers: @google/adk + zod; deliberately NO @agentic-patterns/runtime) projects the algebra into ADK constructs at three seams: tools, agent construction, and runtime lifecycle.

Key alignment discovered: BOTH sides are Zod-native. core ToolDefinition.parameters is the original ZodTypeAny; ADK FunctionTool.parameters takes a Zod schema. The same schema object crosses with zero JSON-Schema round-trip.

---

## Tool bridge — Toolbox/Playbook/Capability → FunctionTool

### Design

The bridge exploits a lucky alignment: core's ToolDefinition.parameters is a raw ZodTypeAny (packages/agent-core/src/molecules/toolbox.ts:56) and ADK's FunctionTool also takes a Zod schema — so the ORIGINAL schema object is handed straight across with zero JSON-Schema round-trip and zero conversion loss (refinements, defaults, transforms, descriptions all survive).

Mapping, per function:

1. toFunctionTool(toolbox, name, options?) — looks up toolbox.tools[name] at build time (fail-fast with the known-tool list), passes def.parameters directly as FunctionTool.parameters, and wires execute through Toolbox.execute(name, params, ctx) — NOT def.execute — so core's Zod-parse + unknown-tool guard run identically to every other host (toolbox.ts:104-111). An opt-out (revalidate: false) dispatches def.execute directly for transform-bearing schemas where a second .parse() would double-apply transforms (see risks). Context mapping: core's ToolExecutionContext.host is documented as a host-declared opaque passthrough that core never interprets (toolbox.ts:37-45) — the ADK ToolContext goes there verbatim, so ADK-aware tools can narrow it to reach state.get/set and actions.transferToAgent, exactly the pattern runtime's nodeTool uses (#124). Correlation ids are extracted defensively (invocationId → runId/traceId, functionCallId → parentToolCallId) with a correlate() override since the JS field names weren't verifiable against installed types. emit forwards to an optional onToolEvent callback under the same swallow-everything non-throw contract as runtime's buildToolCtx (agent-runner.ts:227-247); with no callback, emit is left undefined (valid per core — every ctx field is optional). Results are normalized to ADK's declared Record<string,any>: plain objects pass through, everything else wraps as { result: value }.

2. toolboxToTools maps getToolNames() → toFunctionTool. capabilityToTools emits toolbox tools plus playbook plays (mirroring Capability.getTools(), capability.ts:43-49) with an explicit name-collision guard (core silently concatenates; two same-named ADK tools would shadow nondeterministically, so the bridge throws). Plays route through Playbook.execute, which by design catches everything and returns { error: message } envelopes (playbook.ts:63-76) — those surface to the model as ORDINARY successful tool results, meaning ADK's onToolErrorCallback/plugin error path never fires for play failures, while toolbox-tool throws DO propagate into ADK's tool-error plumbing. This asymmetry is core semantics, preserved and documented, not papered over.

3. ToolSchema-only paths (fromOpenAI ingest, no retained Zod schema): v1 deliberately restricts to Zod-native toolboxes. JSON-Schema→Zod runtime conversion is lossy (allOf/oneOf/conditionals, string formats, no refinements) and would silently diverge validation between hosts — the same posture core itself takes in ToolSchema.toVercelAI(), which throws when _zodSchema is absent (tool-schema.ts:136-146). toolSchemaToFunctionTool(schema, execute) piggybacks on exactly that guard and rethrows with an adapter-specific actionable message; a v2 escape hatch would be a caller-supplied jsonSchemaToZod converter option, keeping the risk decision with the consumer.

### Risks / open questions

- Zod version skew is the top structural risk: core pins zod ^3.23.0 (packages/agent-core/package.json) while @google/adk pins its own zod range — if the consumer's node_modules resolves two copies/majors, core's .parse still works (it uses its own instance) but ADK deriving a Gemini function declaration from a foreign-instance/foreign-major schema may misbehave. The @agentic-patterns/adk package must declare a zod peerDependency intersecting both and document single-instance dedupe.
- Double-parse re-runs transforms: ADK parses params against the schema, then Toolbox.execute parses AGAIN with the same schema. Idempotent for plain object schemas, but .transform()/.preprocess() run twice — and a type-changing transform (z.string().transform(s => s.length)) makes the second parse FAIL outright. Mitigated by options.revalidate=false (dispatches def.execute directly, losing core's guard); needs a loud docs callout.
- Playbook error envelopes bypass ADK's error plumbing: { error } results are ordinary successful tool results to ADK, so onToolErrorCallback and error-keyed guardrail/observability plugins never fire for play failures, while toolbox-tool throws DO enter that path. Deliberate (preserves core semantics) but asymmetric — a plugin-lane teammate building error-driven gates must key on the envelope shape too.
- Correlation field names (invocationId, functionCallId) on the JS ToolContext were not verified against installed @google/adk types (package absent from this repo) — defaultCorrelate reads them structurally and degrades to undefined; verify exact names at implementation time and fix the default (options.correlate is the escape hatch meanwhile). Same caveat applies to the FunctionTool constructor's exact execute/context typings.
- Result-shape coercion diverges from other hosts: ADK's Record<string,any> return contract forces wrapping non-object results as { result: value } (and null/undefined as { result: null }), so a model on ADK sees a different tool-result shape than the same toolbox under AgentRunner/Vercel. Arrays are also wrapped. Predictable but must be documented for prompt-portability.
- assertObjectSchema is heuristic: it structurally probes for .shape through ._def.schema/._def.innerType wrappers (zod-3 internals, stable but not public API). Exotic top-level schemas (z.lazy, z.pipeline, branded types, future zod-4 internals) may false-negative and throw at bridge-build time even though ADK could handle them — the error message tells the author to wrap in z.object, but it's a potential friction point.
- V1 excludes JSON-Schema-only ToolSchemas (fromOpenAI ingest) by design — toolSchemaToFunctionTool throws an actionable error rather than doing lossy JSON-Schema→Zod conversion. Consumers ingesting OpenAI-format tool defs must redefine them via fromZod/Toolbox; the documented v2 path is an opt-in caller-supplied jsonSchemaToZod converter.
- Cross-capability name collisions are unguarded: capabilityToTools guards within one capability, but an LlmAgent composed from several capabilities (the agent-bridge lane) can still get duplicate tool names — the aggregation guard belongs in that lane and should reuse this bridge's collision-error convention.
- Tool progress events have no default sink: without options.onToolEvent, ctx.emit is undefined and events vanish (valid per core's optional contract, and matches runtime's fire-and-forget/no-ordering guarantees), but ADK-side observability of long-running tools silently loses signal unless the plugin lane wires onToolEvent to something (e.g. ADK state or an event stream).

### Draft code (src/tool-bridge.ts)

```typescript
/**
 * Tool bridge — @agentic-patterns/core Toolbox/Playbook/Capability → @google/adk FunctionTool.
 *
 * Design invariants:
 * - ZERO schema conversion: core's ToolDefinition.parameters is the original ZodTypeAny and
 *   ADK FunctionTool.parameters is also a Zod schema. The same object is handed across.
 * - Execution routes through Toolbox.execute(name, args, ctx) so core's Zod-parse validation
 *   and unknown-tool guard run exactly as they do under every other host. (Opt out per
 *   options.revalidate=false when a schema carries non-idempotent .transform()s.)
 * - The ADK ToolContext rides core's ToolExecutionContext.host — the slot core explicitly
 *   declares as host-owned opaque passthrough. ADK-aware tools narrow it themselves to reach
 *   context.state.get/set and context.actions (e.g. transferToAgent).
 * - `emit` is a best-effort, never-throwing sink (mirrors runtime's buildToolCtx contract):
 *   forwarded to options.onToolEvent when provided, otherwise dropped.
 */

import type {
  Capability,
  Playbook,
  ToolEvent,
  ToolExecutionContext,
  ToolSchema,
  Toolbox,
} from "@agentic-patterns/core";
import { FunctionTool } from "@google/adk";
import type { ZodObject, ZodRawShape } from "zod";

// ---------------------------------------------------------------------------
// Options & metadata
// ---------------------------------------------------------------------------

/** Correlation fields the bridge extracts from (or you derive from) the ADK tool context. */
export type ToolCorrelation = Pick<ToolExecutionContext, "runId" | "traceId" | "parentToolCallId">;

/** Metadata attached to every forwarded core ToolEvent. */
export interface ToolEventMeta extends ToolCorrelation {
  /** The tool (or play) name as exposed to the model. */
  readonly toolName: string;
  /** Which core molecule produced the event. */
  readonly source: "toolbox" | "playbook";
  /** Owning Toolbox/Playbook name. */
  readonly containerName: string;
}

export interface AdkToolBridgeOptions {
  /**
   * Receives core ToolEvents emitted via ctx.emit during tool execution.
   * Fire-and-forget: exceptions thrown here are swallowed (core's non-throw emit
   * contract) and events carry NO ordering guarantee relative to the tool result.
   * Omit it and progress events are silently dropped (emit is optional in core).
   */
  readonly onToolEvent?: (event: ToolEvent, meta: ToolEventMeta) => void;
  /**
   * Override how correlation ids are derived from the ADK tool context.
   * Default: defensively reads `invocationId` → runId/traceId and
   * `functionCallId` → parentToolCallId when present as strings.
   */
  readonly correlate?: (adkContext: unknown) => ToolCorrelation;
  /**
   * When false, dispatch def.execute directly instead of Toolbox.execute, skipping
   * core's second Zod parse. Use ONLY for schemas with non-idempotent .transform()/
   * .preprocess() where ADK's own parse already ran and a re-parse would double-apply
   * (or reject transformed output). Default true: core validation semantics preserved.
   */
  readonly revalidate?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Default correlation extraction. Field names follow ADK's CallbackContext/ToolContext
 * (invocationId, functionCallId) but are read structurally so an ADK version drift
 * degrades to `undefined` (every ToolExecutionContext field is optional) rather than
 * a crash. Override via options.correlate for exact wiring.
 */
function defaultCorrelate(adkContext: unknown): ToolCorrelation {
  const ctx = (adkContext ?? {}) as Record<string, unknown>;
  const invocationId = typeof ctx.invocationId === "string" ? ctx.invocationId : undefined;
  const functionCallId = typeof ctx.functionCallId === "string" ? ctx.functionCallId : undefined;
  return { runId: invocationId, traceId: invocationId, parentToolCallId: functionCallId };
}

/**
 * ADK function declarations require an object-shaped top-level parameters schema.
 * Core only guarantees ZodTypeAny, so probe structurally: a ZodObject exposes `.shape`;
 * unwrap effect/optional/default wrappers (._def.schema / ._def.innerType) a few levels.
 * Structural (not instanceof) so it survives duplicate zod copies in node_modules.
 */
function isObjectLikeSchema(schema: unknown): boolean {
  type Probe = { shape?: unknown; _def?: { schema?: unknown; innerType?: unknown } };
  let current = schema as Probe | undefined;
  for (let depth = 0; current !== undefined && current !== null && depth < 10; depth++) {
    if (typeof current.shape === "object" && current.shape !== null) return true;
    current = (current._def?.schema ?? current._def?.innerType) as Probe | undefined;
  }
  return false;
}

function assertObjectSchema(toolName: string, containerName: string, schema: unknown): void {
  if (!isObjectLikeSchema(schema)) {
    throw new Error(
      `Tool '${toolName}' in '${containerName}' has a non-object parameters schema. ` +
        `ADK function declarations require a top-level z.object({...}); ` +
        `wrap scalar/array inputs in an object schema.`,
    );
  }
}

/**
 * Core tools resolve to `unknown`; ADK FunctionTool.execute must return Record<string, any>.
 * Plain objects pass through untouched (including Playbook's { error } envelopes);
 * scalars/arrays/null wrap as { result } so the model always sees a JSON object.
 */
function toAdkResult(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value === undefined ? null : value };
}

/** Build the core ToolExecutionContext handed into Toolbox.execute for one ADK invocation. */
function buildExecutionContext(
  adkContext: unknown,
  meta: Omit<ToolEventMeta, keyof ToolCorrelation>,
  options: AdkToolBridgeOptions,
): ToolExecutionContext {
  const correlate = options.correlate ?? defaultCorrelate;
  let correlation: ToolCorrelation = {};
  try {
    correlation = correlate(adkContext);
  } catch {
    // Correlation is best-effort decoration — never let it break tool execution.
  }
  const onToolEvent = options.onToolEvent;
  return {
    ...correlation,
    // Core's declared opaque passthrough: the ADK ToolContext, verbatim. An ADK-aware
    // tool narrows `ctx.host` itself to reach state.get/set and actions.transferToAgent.
    host: adkContext,
    // Non-throw contract (mirrors runtime's buildToolCtx): a listener failure must
    // never surface into the tool's own execution.
    emit: onToolEvent
      ? (event: ToolEvent) => {
          try {
            onToolEvent(event, { ...meta, ...correlation });
          } catch {
            // Swallow — emit is a best-effort sink.
          }
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// 1. Toolbox → FunctionTool
// ---------------------------------------------------------------------------

/**
 * Bridge one core tool to an ADK FunctionTool.
 *
 * - `parameters` is the ORIGINAL Zod schema from ToolDefinition — zero conversion loss.
 * - `execute` routes through Toolbox.execute so core's Zod-parse still runs (unless
 *   options.revalidate === false), and errors THROW: they enter ADK's tool-error path
 *   (onToolErrorCallback / plugins), matching core Toolbox semantics.
 *
 * @throws Error immediately (at build time) if `name` is not in the toolbox.
 */
export function toFunctionTool(
  toolbox: Toolbox,
  name: string,
  options: AdkToolBridgeOptions = {},
): FunctionTool {
  const def = toolbox.tools[name];
  if (!def) {
    throw new Error(
      `Unknown tool '${name}' in toolbox '${toolbox.name}'. ` +
        `Known tools: ${toolbox.getToolNames().join(", ") || "(none)"}`,
    );
  }
  assertObjectSchema(name, toolbox.name, def.parameters);
  const revalidate = options.revalidate !== false;
  const meta = { toolName: name, source: "toolbox" as const, containerName: toolbox.name };

  return new FunctionTool({
    name,
    description: def.description,
    // Same zod ecosystem end-to-end; the cast narrows core's ZodTypeAny to the
    // object schema ADK expects (guarded by assertObjectSchema above).
    parameters: def.parameters as ZodObject<ZodRawShape>,
    execute: async (params: Record<string, unknown>, adkContext?: unknown) => {
      const ctx = buildExecutionContext(adkContext, meta, options);
      const result = revalidate
        ? await toolbox.execute(name, params, ctx) // core Zod-parse + dispatch
        : await def.execute(params, ctx); // trust ADK's parse; skip re-parse
      return toAdkResult(result);
    },
  });
}

/** Bridge every tool in a toolbox. */
export function toolboxToTools(toolbox: Toolbox, options: AdkToolBridgeOptions = {}): FunctionTool[] {
  return toolbox.getToolNames().map((name) => toFunctionTool(toolbox, name, options));
}

// ---------------------------------------------------------------------------
// 2. Playbook plays & Capability → FunctionTool[]
// ---------------------------------------------------------------------------

/**
 * Bridge one playbook play to an ADK FunctionTool.
 *
 * Error-envelope semantics (deliberately preserved from core): Playbook.execute
 * NEVER throws — unknown play, Zod validation failure, and execution errors all
 * come back as `{ error: message }`. To ADK that is an ordinary successful tool
 * result: the model sees the envelope and can self-correct, but ADK's
 * onToolErrorCallback / plugin error path will NOT fire for play failures.
 * Success results are JSON-round-tripped by core (JSON-safe by construction).
 *
 * Note: PlayDefinition.execute takes no ctx, so the ADK context is not forwarded
 * into the play body — plays are pure by core's design. Correlation/events for
 * plays therefore only exist at the bridge boundary, not inside the play.
 */
export function playToFunctionTool(playbook: Playbook, name: string): FunctionTool {
  const play = playbook.plays[name];
  if (!play) {
    throw new Error(
      `Unknown play '${name}' in playbook '${playbook.name}'. ` +
        `Known plays: ${playbook.getPlayNames().join(", ") || "(none)"}`,
    );
  }
  assertObjectSchema(name, playbook.name, play.parameters);

  return new FunctionTool({
    name,
    description: play.description,
    parameters: play.parameters as ZodObject<ZodRawShape>,
    execute: async (params: Record<string, unknown>) => {
      // Routed through Playbook.execute so the { error } envelope + JSON
      // round-trip semantics match every other core host exactly.
      const result = await playbook.execute(name, params);
      return toAdkResult(result);
    },
  });
}

/** Bridge every play in a playbook. */
export function playbookToTools(playbook: Playbook): FunctionTool[] {
  return playbook.getPlayNames().map((name) => playToFunctionTool(playbook, name));
}

/**
 * Bridge a Capability (Toolbox + optional Playbook) to a flat FunctionTool[] —
 * the ADK-side equivalent of Capability.getTools().
 *
 * Unlike core (which silently concatenates schemas), the bridge THROWS on a
 * toolbox-tool/play name collision: two same-named entries in an LlmAgent's
 * `tools` array would shadow nondeterministically at the model boundary.
 */
export function capabilityToTools(
  capability: Capability,
  options: AdkToolBridgeOptions = {},
): FunctionTool[] {
  const tools = toolboxToTools(capability.toolbox, options);
  if (capability.playbook) {
    const taken = new Set(capability.toolbox.getToolNames());
    for (const playName of capability.playbook.getPlayNames()) {
      if (taken.has(playName)) {
        throw new Error(
          `Capability '${capability.name}': play '${playName}' collides with a toolbox tool ` +
            `of the same name. Rename one — ADK tool names must be unique per agent.`,
        );
      }
      tools.push(playToFunctionTool(capability.playbook, playName));
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// 3. ToolSchema-only path (v1: Zod-native required)
// ---------------------------------------------------------------------------

/**
 * Bridge a bare ToolSchema (schema only — no attached implementation) plus a
 * caller-supplied executor to an ADK FunctionTool.
 *
 * V1 DECISION: this works ONLY for Zod-native ToolSchemas (ToolSchema.fromZod),
 * detected via core's own toVercelAI() guard which returns the retained original
 * Zod schema. JSON-Schema-only ToolSchemas (e.g. ToolSchema.fromOpenAI ingest)
 * are rejected rather than run through a lossy JSON-Schema→Zod conversion:
 * allOf/oneOf/conditionals, string formats, and refinements do not survive such
 * conversions, and the resulting silent validation drift between hosts is worse
 * than an explicit error. A future version may accept a caller-supplied
 * `jsonSchemaToZod` converter to opt into that risk deliberately.
 */
export function toolSchemaToFunctionTool(
  schema: ToolSchema,
  execute: (args: Record<string, unknown>) => Promise<unknown>,
): FunctionTool {
  let zodParameters: ZodObject<ZodRawShape>;
  try {
    // toVercelAI() is core's canonical "give me the original Zod schema" accessor;
    // it throws iff the ToolSchema was not built via fromZod.
    zodParameters = schema.toVercelAI().parameters as ZodObject<ZodRawShape>;
  } catch {
    throw new Error(
      `ToolSchema '${schema.name}' has no retained Zod schema (built from JSON Schema, ` +
        `e.g. ToolSchema.fromOpenAI). The ADK bridge v1 requires Zod-native schemas — ` +
        `rebuild it with ToolSchema.fromZod(), or define it in a Toolbox and use toFunctionTool().`,
    );
  }
  assertObjectSchema(schema.name, "ToolSchema", zodParameters);

  return new FunctionTool({
    name: schema.name,
    description: schema.description,
    parameters: zodParameters,
    execute: async (params: Record<string, unknown>) => toAdkResult(await execute(params)),
  });
}

```

---

## Agent bridge — Agent → LlmAgent

### Design

AGENT BRIDGE: projects the core algebra (Agent = Role x Background x Awareness x Mission) onto ADK's LlmAgent. Core stays the prompt/schema compiler; ADK supplies the execution loop.

MAPPINGS (verified against real source):
1. instruction <- agent.renderInitialPrompt(), NOT getSystemPrompt(). Justification: renderInitialPrompt() is the canonical PromptRenderer path (agent.ts:145-172) — the six-section pipeline (Identity/Boundaries/Capabilities/Context/Mission/Methodology) with empty-section filtering, the same path the runtime runner and Playground attribution (renderSections) use. getSystemPrompt() is the older inline path that lumps judgments into one Role block and doesn't split boundaries (constraints/escalation) from methodology. ADK's instruction is a persistent system-prompt slot re-sent on every LlmRequest, so the full initial rendering is always correct and renderContinuationPrompt's delta optimization has no ADK slot (ADK owns history). CRITICAL SUBTLETY: ADK applies {key} state-templating to *string* instructions, and core prompts legitimately contain literal braces (renderSchemaForPrompt embeds JSON schema + example blocks). Default is therefore an InstructionProvider closure (`async () => text`), which bypasses templating; `instructionMode: "template"` opts back into raw string.
2. name <- slugify(role.name) ("Project Manager" -> "project_manager"): ADK names must be identifier-safe ([a-zA-Z_][a-zA-Z0-9_]*) and "user" is reserved; slugifier handles leading digits, empty results, and the reserved name.
3. description <- persona.identity + mission.objective. In ADK, description is the routing signal the parent LLM reads when deciding transferToAgent, so it leads with what the agent IS (identity) and what it HANDLES (objective), single-line, truncated at 400 chars.
4. model <- agent.getModel() pass-through (role default "claude-sonnet-4-20250514", agent override wins), with opts.model (string | BaseLlm) override and an opts.mapModel hook for id rewriting. No default rewrite of "anthropic/..."-prefixed ids — deliberately flagged instead of guessed, since ADK resolution depends on what's registered in the host's LLMRegistry.
5. tools <- the tool-bridge lane via a documented seam: agentToFunctionTools(agent) must walk role.capabilities[].toolbox.tools (executable ToolDefinitions: Zod parameters + execute — the same zod ecosystem ADK FunctionTool wants), NOT agent.getTools(), because ToolSchema (tool-schema.ts) is a pure schema artifact with no execute fn.
6. Mission output contract: strict_output=false -> already prompt-embedded by Mission.toPrompt(), nothing to do. strict_output=true -> core omits the schema from the prompt and expects the HOST to enforce; ADK's enforcement slot is LlmAgent.outputSchema (zod) but it is mutually exclusive with tools. So: zod schema + zero tools -> outputSchema; otherwise degrade faithfully by appending renderSchemaForPrompt(...) to the instruction rather than silently dropping the contract.
7. Multi-agent: agencyToLlmAgent(agency) maps coordinator spec -> root LlmAgent and internalAgents -> subAgents[] (Agency validates exactly-one-coordinator). Spec->Agent construction mirrors AgencyRuntime._buildNode (persona fallback, judgment, defaultModel, synthesized "Fulfill the <role> role" mission) minus the MessagingToolbox — ADK's handoff substrate is the LLM emitting transferToAgent via tool-context actions on the agent tree, not core's peer bus. spec.capabilities are string names with no core-level registry, so an opts.resolveCapability callback maps them to real Capability instances (throws loudly on unresolved rather than AgencyRuntime's silent ignore).

roleToLlmAgent(role, mission, opts) is a thin AgentBuilder composition (optional background/awareness) delegating to toLlmAgent.

### Risks / open questions

- Tool seam is the load-bearing assumption: agent.getTools() returns ToolSchema[] which has NO execute function (packages/agent-core/src/molecules/tool-schema.ts) — executable tools live only on role.capabilities[].toolbox.tools as ToolDefinition {parameters: ZodTypeAny, execute}. The tool-bridge lane must export agentToFunctionTools(agent: Agent): BaseTool[] with exactly that sourcing; if it bridges from ToolSchema instead, every tool will be declaration-only and silently no-op. Import name './tool-bridge.js#agentToFunctionTools' must be reconciled with that lane.
- ADK string-instruction templating: core-rendered prompts contain literal '{'/'}' (renderSchemaForPrompt JSON schema + example blocks, code fences in manuals). If instruction is passed as a plain string, ADK's session-state injection may throw on unknown keys or mangle the prompt. Default is an InstructionProvider closure to bypass templating — verify adk-js LlmAgent.instruction actually accepts `string | InstructionProvider` (it does per adk.dev docs, but confirm against the installed package's types).
- Model resolution is pass-through, not solved: core defaults are Claude ids ('claude-sonnet-4-20250514' from RoleSchema; 'anthropic/claude-sonnet-4-20250514' from AgentSpecSchema). ADK's LLMRegistry resolves Gemini strings natively; Claude ids require a registered Anthropic BaseLlm or an explicit opts.model instance, and provider-prefixed 'anthropic/...' strings may match nothing in the registry. mapModel hook exists but no default rewrite is applied — hosts must wire this.
- outputSchema mutual exclusion: ADK disables tool use when LlmAgent.outputSchema is set, so strict_output missions on tool-bearing agents degrade to a prompt-embedded schema block — materially weaker than core runtime's host-enforced structured output (generateObject). Consumers relying on strict JSON with tools need an ADK plugin/afterModelCallback validator (plugin lane).
- Semantic mismatch on multi-agent: core Agency is a concurrent peer bus (MessagingToolbox send_message/broadcast/list_team, all nodes running) while ADK is a single-active-agent tree with LLM-driven transferToAgent handoff. The bridge drops bus messaging entirely; broadcast patterns and simultaneous agent activity have no faithful ADK equivalent.
- spec.max_turns has no LlmAgent slot — needs RunConfig or the plugin lane's beforeModelCallback to enforce; currently documented but unenforced.
- Unresolved spec.capabilities now THROW (AgencyRuntime silently ignores those strings — packages/agent-runtime/src/runtime/agency-runtime.ts never resolves them). Chose loud-failure over runtime parity to avoid shipping silently tool-less agents; flag if parity is preferred.
- Zod version coupling: core pins zod ^3.23 + zod-to-json-schema; adk-js FunctionTool.parameters takes a Zod schema from ITS zod dependency. A zod v3/v4 or dual-package (ESM+CJS both loaded) mismatch breaks the shared-schema pass-through at runtime even if types compile. The @agentic-patterns/adk package.json must declare zod and @google/adk as peerDependencies with aligned ranges.
- Exact adk-js constructor prop names (`subAgents`, `outputSchema`) match the docs but were not compile-checked — @google/adk is not yet installed in this repo; first `bun run typecheck` after adding the dep will confirm.
- ADK re-sends the full six-section instruction every model call (no continuation-delta slot like renderContinuationPrompt), so long Role prompts cost tokens per turn; acceptable but worth noting for large manuals/playbooks.

### Draft code (src/agent-bridge.ts)

```typescript
/**
 * Agent bridge — @agentic-patterns/core -> @google/adk.
 *
 * Maps the core algebra (Agent = Role x Background x Awareness x Mission) onto
 * ADK's LlmAgent. Core stays a pure prompt-and-schema compiler; ADK supplies
 * the execution loop (Runner, sessions, flows). One-way projection:
 *
 *   Agent.renderInitialPrompt()   -> LlmAgent.instruction   (system-prompt slot)
 *   Role.name (slugified)         -> LlmAgent.name          (identifier-safe, "user" reserved)
 *   Persona.identity + Mission    -> LlmAgent.description   (transferToAgent routing signal)
 *   Agent.getModel()              -> LlmAgent.model         (pass-through + override/mapper)
 *   Toolbox ToolDefinitions       -> FunctionTool[]         (via ./tool-bridge — executable seam)
 *   Mission.output_schema         -> LlmAgent.outputSchema  (strict, tool-free) or prompt-embedded
 *   Agency coordinator/internals  -> root LlmAgent + subAgents[]
 *
 * Instruction is passed as an InstructionProvider closure by default: ADK
 * applies `{key}` session-state templating to *string* instructions, and core
 * prompts legitimately contain literal braces (JSON schema + example blocks
 * from renderSchemaForPrompt). The closure bypasses templating.
 */

import {
  AgentBuilder,
  Judgment,
  Mission,
  Persona,
  RoleBuilder,
  renderSchemaForPrompt,
} from "@agentic-patterns/core";
import type {
  Agency,
  Agent,
  AgentSpecData,
  Awareness,
  Background,
  Capability,
  Role,
} from "@agentic-patterns/core";
import { LlmAgent } from "@google/adk";
import type { BaseLlm, BaseTool } from "@google/adk";
import type { ZodTypeAny } from "zod";

// Seam contract with ./tool-bridge.ts (parallel lane):
//   agentToFunctionTools(agent: Agent): BaseTool[]
// It MUST source executable ToolDefinitions from agent.role.capabilities[].toolbox.tools
// (Zod `parameters` + `execute`), not from agent.getTools() — ToolSchema is a pure
// schema artifact (molecules/tool-schema.ts) and carries no execute function.
import { agentToFunctionTools } from "./tool-bridge.js";

const MAX_DESCRIPTION_LENGTH = 400;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ToLlmAgentOptions {
  /**
   * Override the ADK model slot. A string is resolved by ADK's LLMRegistry;
   * a BaseLlm instance is used directly (required for non-registered
   * providers, e.g. Claude via an Anthropic BaseLlm).
   * Default: agent.getModel() passed through unchanged.
   */
  model?: string | BaseLlm;
  /**
   * Rewrite a core model id (e.g. "anthropic/claude-sonnet-4-20250514") into
   * an ADK-resolvable value. Applied only when `model` is not set.
   */
  mapModel?: (coreModel: string) => string | BaseLlm;
  /**
   * "auto" (default): bridge every executable ToolDefinition on the agent's
   * toolboxes into FunctionTools. "none": declare no tools.
   */
  tools?: "auto" | "none";
  /** Extra ADK tools appended after the bridged ones. */
  extraTools?: BaseTool[];
  /** Override the slugified role name. Must be ADK identifier-safe. */
  name?: string;
  /** Override the derived description (the transferToAgent routing signal). */
  description?: string;
  /**
   * ADK sub-agents to attach. With sub-agents present, ADK's AutoFlow lets the
   * LLM hand off control via the tool-context action `transferToAgent`.
   */
  subAgents?: LlmAgent[];
  /**
   * "provider" (default): wrap the rendered prompt in an InstructionProvider
   * closure so ADK does NOT apply `{key}` state templating to it.
   * "template": pass the raw string and opt into ADK's state templating —
   * only safe if your personas/manuals/schemas contain no literal braces.
   */
  instructionMode?: "provider" | "template";
}

export interface RoleToLlmAgentOptions extends ToLlmAgentOptions {
  /** Optional situated context, mirroring AgentBuilder.withBackground(). */
  background?: Background;
  /** Optional situated context, mirroring AgentBuilder.withAwareness(). */
  awareness?: Awareness;
}

export interface AgencyToLlmAgentOptions {
  /**
   * Resolve an AgentSpec `capabilities` entry (a string name — core has no
   * capability registry) to a real Capability instance. Required if any spec
   * declares capabilities; unresolved names throw rather than silently
   * producing a tool-less agent.
   */
  resolveCapability?: (name: string, spec: AgentSpecData) => Capability | undefined;
  /** Per-spec LlmAgent overrides (model mapping, extra tools, ...). */
  agentOptions?: (spec: AgentSpecData) => ToLlmAgentOptions | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make a core role name ADK-safe. ADK agent names must be valid identifiers
 * ([a-zA-Z_][a-zA-Z0-9_]*) and "user" is reserved for the session author.
 *
 *   "Project Manager"  -> "project_manager"
 *   "3rd-Line Support" -> "_3rd_line_support"
 */
export function slugifyAgentName(raw: string): string {
  let slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (slug.length === 0) {
    slug = "agent";
  }
  if (/^[0-9]/.test(slug)) {
    slug = `_${slug}`;
  }
  if (slug === "user") {
    slug = "user_agent";
  }
  return slug;
}

/**
 * Derive the LlmAgent description. In ADK this is the routing signal a parent
 * LLM reads when deciding `transferToAgent`, so it leads with who the agent is
 * (persona identity) and what it handles (mission objective).
 */
export function describeAgent(agent: Agent): string {
  const identity = agent.role.persona.data.identity.trim().replace(/\s+/g, " ");
  const objective = agent.mission.data.objective.trim().replace(/\s+/g, " ");
  const lead = identity.charAt(0).toUpperCase() + identity.slice(1);
  const text = `${lead}${lead.endsWith(".") ? "" : "."} Handles: ${objective}`;
  return text.length > MAX_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...`
    : text;
}

function isZodSchema(value: unknown): value is ZodTypeAny {
  return (
    typeof value === "object" &&
    value !== null &&
    "_def" in value &&
    typeof (value as { parse?: unknown }).parse === "function"
  );
}

function resolveModel(agent: Agent, opts: ToLlmAgentOptions): string | BaseLlm {
  if (opts.model !== undefined) {
    return opts.model;
  }
  const coreModel = agent.getModel();
  return opts.mapModel ? opts.mapModel(coreModel) : coreModel;
}

/**
 * Compute instruction text + optional enforced output schema.
 *
 * Mission's contract (atoms/mission.ts): with strict_output=false the schema
 * is already embedded in the prompt by Mission.toPrompt(); with
 * strict_output=true core omits it and expects the HOST to enforce. ADK's
 * enforcement slot is LlmAgent.outputSchema, but ADK disables tool use when it
 * is set — so it is only used for tool-less agents with a Zod schema. In every
 * other strict case the contract degrades faithfully to a prompt-embedded
 * block instead of silently disappearing.
 */
function buildOutputContract(
  agent: Agent,
  toolCount: number,
): { instructionText: string; outputSchema?: ZodTypeAny } {
  const instructionText = agent.renderInitialPrompt();
  const mission = agent.mission.data;

  if (!mission.strict_output || mission.output_schema == null) {
    return { instructionText };
  }
  if (toolCount === 0 && isZodSchema(mission.output_schema)) {
    return { instructionText, outputSchema: mission.output_schema };
  }
  const schemaPrompt = renderSchemaForPrompt(
    mission.output_schema as ZodTypeAny | Record<string, unknown>,
  );
  return { instructionText: `${instructionText}\n\n${schemaPrompt}` };
}

// ---------------------------------------------------------------------------
// 1. Agent -> LlmAgent
// ---------------------------------------------------------------------------

/**
 * Project a core Agent onto an ADK LlmAgent.
 *
 * instruction = agent.renderInitialPrompt() — the canonical PromptRenderer
 * six-section pipeline (identity/boundaries/capabilities/context/mission/
 * methodology). ADK re-sends instruction on every model call, so the full
 * initial rendering is always used; core's continuation-delta optimization
 * (renderContinuationPrompt) has no ADK slot because ADK owns history.
 */
export function toLlmAgent(agent: Agent, opts: ToLlmAgentOptions = {}): LlmAgent {
  const name = opts.name ?? slugifyAgentName(agent.role.name);
  const description = opts.description ?? describeAgent(agent);
  const model = resolveModel(agent, opts);

  const tools: BaseTool[] = opts.tools === "none" ? [] : agentToFunctionTools(agent);
  if (opts.extraTools && opts.extraTools.length > 0) {
    tools.push(...opts.extraTools);
  }

  const { instructionText, outputSchema } = buildOutputContract(agent, tools.length);

  // Default: InstructionProvider closure — bypasses ADK's `{key}` state
  // templating, which would otherwise mangle/throw on the literal braces in
  // core-rendered prompts (JSON schema blocks, examples, code fences).
  const instruction =
    opts.instructionMode === "template" ? instructionText : async () => instructionText;

  return new LlmAgent({
    name,
    model,
    description,
    instruction,
    tools,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(opts.subAgents !== undefined ? { subAgents: opts.subAgents } : {}),
  });
}

// ---------------------------------------------------------------------------
// 2. Role + Mission -> LlmAgent
// ---------------------------------------------------------------------------

/**
 * Convenience: instantiate a Role with a Mission (and optional background /
 * awareness) and project the resulting Agent. Mirrors AgentBuilder.
 */
export function roleToLlmAgent(
  role: Role,
  mission: Mission,
  opts: RoleToLlmAgentOptions = {},
): LlmAgent {
  const builder = new AgentBuilder(role).withMission(mission);
  if (opts.background) {
    builder.withBackground(opts.background);
  }
  if (opts.awareness) {
    builder.withAwareness(opts.awareness);
  }
  return toLlmAgent(builder.build(), opts);
}

// ---------------------------------------------------------------------------
// 3. Agency -> LlmAgent tree (coordinator + subAgents)
// ---------------------------------------------------------------------------

/**
 * Project a core Agency onto an ADK agent tree: the coordinator spec becomes
 * the root LlmAgent, internal agents become its `subAgents`.
 *
 * Handoff semantics: with subAgents attached, ADK's AutoFlow exposes transfer —
 * the root LLM (guided by each sub-agent's `description`) emits the
 * `transferToAgent` tool-context action to hand control to a sub-agent, which
 * can transfer back. This replaces core's peer message bus (MessagingToolbox
 * send_message/broadcast), which has no ADK equivalent and is intentionally
 * NOT synthesized here.
 *
 * Note: spec.max_turns has no LlmAgent slot — enforce turn budgets via the
 * runner's RunConfig or the plugin lane's beforeModelCallback.
 */
export function agencyToLlmAgent(agency: Agency, opts: AgencyToLlmAgentOptions = {}): LlmAgent {
  const coordinator = agency.coordinator;
  if (!coordinator) {
    // Agency's constructor enforces exactly one coordinator; this guard is for narrowing.
    throw new Error(`Agency '${agency.data.name}' has no coordinator`);
  }
  const subAgents = agency.internalAgents.map((spec) => agentSpecToLlmAgent(agency, spec, opts));
  return agentSpecToLlmAgent(agency, coordinator, opts, subAgents);
}

/**
 * Project a single AgentSpec onto an LlmAgent. Mirrors the runtime's
 * AgencyRuntime._buildNode construction (persona fallback, judgment,
 * defaultModel, synthesized role-fulfillment mission), minus the
 * MessagingToolbox — ADK coordination is tree handoff, not the peer bus.
 */
export function agentSpecToLlmAgent(
  agency: Agency,
  spec: AgentSpecData,
  opts: AgencyToLlmAgentOptions = {},
  subAgents?: LlmAgent[],
): LlmAgent {
  const agent = buildAgentFromSpec(agency, spec, opts);
  const perAgent = opts.agentOptions?.(spec) ?? {};
  return toLlmAgent(agent, {
    ...perAgent,
    subAgents: subAgents ?? perAgent.subAgents,
  });
}

function buildAgentFromSpec(
  agency: Agency,
  spec: AgentSpecData,
  opts: AgencyToLlmAgentOptions,
): Agent {
  const persona = spec.persona
    ? new Persona(spec.persona)
    : new Persona({ identity: `a ${spec.role} agent`, tone: "professional and concise" });

  const roleBuilder = new RoleBuilder(spec.role).withPersona(persona).withDefaultModel(spec.model);
  if (spec.judgment) {
    roleBuilder.withJudgment(new Judgment(spec.judgment));
  }

  for (const capabilityName of spec.capabilities) {
    const capability = opts.resolveCapability?.(capabilityName, spec);
    if (!capability) {
      throw new Error(
        `Agency '${agency.data.name}': agent '${spec.role}' declares capability ` +
          `'${capabilityName}' but it was not resolved. Pass ` +
          `AgencyToLlmAgentOptions.resolveCapability to map capability names to instances.`,
      );
    }
    roleBuilder.withCapability(capability);
  }

  const mission = new Mission({
    objective: `Fulfill the ${spec.role} role within the ${agency.data.name} agency.`,
  });

  return new AgentBuilder(roleBuilder.build()).withMission(mission).build();
}

```

---

## Plugin bridge — AgenticPatternsPlugin extends BasePlugin

### Design

LANE: lifecycle bridge — src/plugin.ts of @agentic-patterns/adk (deps: @agentic-patterns/core, @google/adk, zod as peer; deliberately NO dependency on @agentic-patterns/runtime).

1) TURN DISCIPLINE (beforeModelCallback). Core's premise — "identity/boundaries/capabilities live in conversation history after turn 1, so turn N sends only State+Mission+Methodology" — does NOT hold in ADK: ADK re-derives the system instruction from the static `agent.instruction` on every model call and never persists it into session contents. Replacing the instruction with `renderContinuationPrompt()` would therefore decapitate the agent (drop Persona/Judgments entirely). So the plugin APPENDS the continuation delta to the request's system instruction on turn N and leaves turn 0 to the construction lane (`instruction = renderInitialPrompt()`). The Mission/Methodology repetition is accepted as end-of-context recency reinforcement — the same reason core re-sends them. Turn/state tracking: session state keys `apts:turn` (model-call counter — matches core's runner-iteration semantics, including intra-invocation tool loops) and `apts:state` (JSON-serializable core StateData). A real core `State` atom is reconstructed each call: iteration = turn, phase machine PLANNING(turn 0) → EXECUTING(turn N) → BLOCKED (sticky, set when an escalation guardrail fires — deliberately never auto-clears; escalation demands a human), last_action fed by afterToolCallback.

2) JUDGMENT GUARDRAILS (beforeToolCallback, intervene mode). Honest v1: NL constraints cannot be regex-enforced, so `compileJudgmentGuardrails()` hard-enforces ONLY the mechanically extractable subset — backtick-quoted tool identifiers in `constraints`/`escalation_triggers` ("never call `deploy_production`") become exact-name block rules; everything else remains prompt-enforced via the Boundaries section core already renders. Production users supply explicit `GuardrailRule[]` (toolName / toolPattern / argPattern over stringified args) which merge after derived rules. On hit the callback returns a refusal record (ADK short-circuit: it becomes the tool result the model sees) with `blocked_by: judgment:<domain>`, the original judgment text as reason, and kind-differentiated guidance (constraint → "choose a compliant approach"; escalation → "hand off to a human, do not retry" + phase=BLOCKED). Emits `agent.tool.rejected` with gateName "JudgmentGuardrail" / gateCategory "SAFETY" — field-for-field parity with runtime's GateChain rejection event.

3) STRICT OUTPUT (afterModelCallback). Fires only when `mission.strict_output && output_schema != null` (core deliberately does NOT embed the schema in the prompt when strict — enforcement is the host's job, and nothing in agent-runtime does it today, so this is net-new value). Skips tool-calling turns (functionCall parts present) and empty text. Zod schemas → `safeParse` with path-qualified issues; raw JSON-schema dicts → JSON extraction (fence-stripping) + top-level `required`-keys check only (flagged shim; ajv is the upgrade). DECISION on failure: surface the error by REPLACING the response with a machine-detectable `apts_error: OUTPUT_VALIDATION_FAILED` envelope (errors + core's `renderSchemaForPrompt` text), NOT an in-plugin repair loop — justification: ADK's afterModelCallback is replace-only; a plugin cannot schedule another model call, and faking a retry would be dishonest. The design still self-heals where it can: the failure is persisted to `apts:repair`, and the NEXT beforeModelCallback injects an "Output Repair Required" instruction with the concrete validation errors, then clears the flag. A recoverable `agent.error` event is emitted either way.

4) OBSERVABILITY (onEventCallback + lifecycle hooks). `options.emit` takes a `BridgedAgentEvent` sink — a local structural mirror of runtime's AgentEvent base (type/traceId/runId/spanId/timestamp), assignment-compatible so `emit: (e) => agentEventBus.emit(e as AgentEvent)` wires full parity in one line without the dependency. traceId = session id, runId = invocationId. Emission map: beforeRunCallback → `agent.message.start` carrying `systemPrompt: renderInitialPrompt()` (runtime #117 convention: no other event carries it); beforeModelCallback → `agent.iteration.start`; tool callbacks → `agent.tool.start`/`agent.tool.end` with real durations from a functionCallId-keyed clock; guardrail hits → `agent.tool.rejected`; onEventCallback → `agent.tool.intent` from functionCall parts and `agent.message.complete` from the final text event (functionResponse parts are skipped there to avoid duplicating tool.end). onEventCallback is strictly observe-only (always returns undefined).

All uncertain ADK member access (systemInstruction spelling, appendInstructions, state get/set in plugin contexts, invocationId/session id, functionCallId, tool-args location, LlmResponse construction) is funneled through one "compat" section of the file so aligning with adk-js source is a single-section change.

### Risks / open questions

- Callback parameter shape (HIGH, verify-against-adk-js-source): Python ADK plugin callbacks are keyword-only and pass tool_args separately (tool, tool_args, tool_context); the brief's verified JS signatures show (tool, context). If adk-js actually uses a single params object or a separate toolArgs parameter, every method signature plus getToolArgs() needs mechanical realignment — the compat section is the single seam, but until confirmed the class may not structurally satisfy BasePlugin's method types (I omitted `override` modifiers for this reason).
- LlmRequest mutation surface unverified: appendInstructions([...]) vs config.systemInstruction spelling is inferred from the Python API (append_instructions / config.system_instruction). Also assumed (documented in Python, unverified in JS): returning undefined from beforeModelCallback proceeds WITH in-place request mutations applied.
- Session-state semantics in plugin callbacks: CallbackContext.state.get/set is confirmed for tool contexts by the brief, assumed for model/run callbacks. ADK commits state deltas via event actions — a write from beforeModelCallback may only persist after the event is appended, so a mid-turn crash could lose the turn increment (worst case: one extra initial-style turn, benign). ToolContext.functionCallId presence in JS is unverified; fallback degrades durationMs and event correlation, not correctness.
- afterModelCallback cannot re-invoke the model, so strict_output failure REPLACES the final response with the error envelope — the end user sees the failure unless the host loops on apts_error. This is deliberate (honest surface > fake retry) but hosts wanting invisible repair need their own retry loop; a future version could run a bounded re-ask if adk-js exposes a model handle in the callback context. Also the structural LlmResponse literal may need `new LlmResponse(...)`.
- Turn counter counts every model call in the session and is shared across agents: in multi-agent sessions (actions.transferToAgent) all agents increment the same apts:turn and the continuation prompt of agent A could be computed while agent B runs. Fix before multi-agent use: namespace keys by agent name (key = `apts:${agentName}:turn`) and gate beforeModelCallback on context.agentName matching the bridged agent.
- Judgment guardrail coverage is intentionally thin: only backtick-quoted tool identifiers are hard-enforced; plain NL constraints stay prompt-side (as core designed — Boundaries section), but teams may over-trust the plugin as a policy engine. Runtime gate parity is SAFETY-category only: no approval, rate-limit, or audit gates in this lane, and a stubborn model can loop on refusal results with no rate limiting.
- Raw JSON-schema validation is a shim (top-level required keys only). Zod schemas get full safeParse; dict schemas need ajv (new dependency) or a decision that @agentic-patterns/adk supports zod output_schema only. Note ToolSchema.fromZod keeps the original Zod schema privately, so the construction lane can usually guarantee the Zod path.
- Event parity gaps: inputTokens/outputTokens are 0 (ADK usage-metadata location on LlmResponse/Event unverified — likely llmResponse.usageMetadata; wire it once confirmed); no agent.llm.start/agent.llm.end pair yet (trivially addable from before/afterModelCallback once token fields are known); spanIds are flat (no parentSpanId nesting).
- Stronger escalation is available but unverified: ADK exposes actions.escalate on event actions — setting toolContext.actions.escalate = true from beforeToolCallback might terminate the loop outright, which is closer to core's escalation semantics than a refusal result; needs a source check on whether plugins may mutate actions there.
- BasePlugin import path assumed to be the package root of @google/adk; confirm export location and whether the constructor takes a bare name string or an options object.

### Draft code (src/plugin.ts)

```typescript
/**
 * @agentic-patterns/adk — AgenticPatternsPlugin (lifecycle bridge).
 *
 * The construction lane maps a core Agent onto a static LlmAgent
 * (instruction = renderInitialPrompt(), Toolbox -> FunctionTool[]). This
 * plugin carries the parts of the algebra that only exist AT RUNTIME:
 *
 *   1. Turn discipline — core distinguishes turn 1 (full identity prompt)
 *      from turn N (State + Mission + Methodology delta). ADK re-sends the
 *      static instruction on every model call, so the delta is APPENDED.
 *   2. Judgment guardrails — hard-enforce the mechanically-extractable subset
 *      of Judgment constraints / escalation_triggers at the tool boundary.
 *   3. Mission strict output — when strict_output is set, core deliberately
 *      does NOT embed output_schema in the prompt; enforcement is the host's
 *      job. This plugin is that host.
 *   4. Observability parity — bridge ADK lifecycle to runtime-shaped events
 *      without depending on @agentic-patterns/runtime.
 */

import {
  type Agent,
  type JudgmentData,
  Phase,
  renderSchemaForPrompt,
  State,
  type StateData,
} from "@agentic-patterns/core";
import { BasePlugin } from "@google/adk";
import type { ZodTypeAny } from "zod";

// ---------------------------------------------------------------------------
// ADK structural types (draft seam).
//
// adk-js type exports are not fully verified from docs alone. Every uncertain
// member access is funneled through the compat helpers further down so that
// aligning with the real source is a one-section change.
// VERIFY-AGAINST-ADK-JS-SOURCE: replace these with `import type` from
// "@google/adk" once the exact exports are confirmed.
// ---------------------------------------------------------------------------

interface AdkSessionState {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

interface AdkCallbackContext {
  readonly invocationId?: string;
  readonly agentName?: string;
  readonly state: AdkSessionState;
  readonly session?: { readonly id?: string };
}

interface AdkPart {
  text?: string;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name?: string; response?: unknown };
}

interface AdkContent {
  role?: string;
  parts?: AdkPart[];
}

interface AdkLlmRequest {
  config?: { systemInstruction?: unknown };
  appendInstructions?(instructions: string[]): void;
  model?: string;
  contents?: AdkContent[];
}

interface AdkLlmResponse {
  content?: AdkContent;
}

interface AdkTool {
  readonly name: string;
  readonly description?: string;
}

interface AdkToolContext extends AdkCallbackContext {
  readonly functionCallId?: string;
}

interface AdkEvent {
  readonly author?: string;
  readonly content?: AdkContent;
  isFinalResponse?(): boolean;
}

interface AdkInvocationContext {
  readonly invocationId?: string;
  readonly session?: { readonly id?: string };
  readonly agent?: { readonly name?: string };
}

// ---------------------------------------------------------------------------
// Bridged events — structural mirror of @agentic-patterns/runtime AgentEvent.
//
// Deliberately NOT an import: this package depends only on core + adk. The
// shapes are assignment-compatible with runtime's bus, so
//   new AgenticPatternsPlugin({ agent, emit: (e) => bus.emit(e as AgentEvent) })
// wires observability parity in one line.
// ---------------------------------------------------------------------------

export interface BridgedEventBase {
  readonly type: string;
  readonly traceId: string;
  readonly runId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly timestamp: Date;
}

export type BridgedAgentEvent = BridgedEventBase & Record<string, unknown>;

export type EventSink = (event: BridgedAgentEvent) => void;

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

export interface GuardrailRule {
  /** Exact tool name to block. */
  toolName?: string;
  /** Regex tested against the tool name. */
  toolPattern?: RegExp;
  /** Regex tested against JSON.stringify(args). */
  argPattern?: RegExp;
  /** constraint -> refuse and redirect; escalation -> refuse and demand human. */
  kind: "constraint" | "escalation";
  /** Judgment domain (or "explicit" for user-supplied rules). */
  sourceDomain: string;
  /** Original judgment text — shown to the model in the refusal result. */
  sourceText: string;
}

/**
 * V1 heuristic compiler — honest about its limits.
 *
 * Natural-language judgment text cannot be regex-enforced. This compiles ONLY
 * the mechanically extractable subset: backtick-quoted identifiers inside
 * constraints / escalation triggers that look like tool names, e.g.
 * "never call `deploy_production` without approval". Everything else remains
 * prompt-enforced through the Boundaries section core already renders into the
 * system prompt. Deterministic rules for production belong in
 * AgenticPatternsPluginOptions.guardrails.
 */
export function compileJudgmentGuardrails(judgments: readonly JudgmentData[]): GuardrailRule[] {
  const rules: GuardrailRule[] = [];
  const IDENT = /`([a-z][a-z0-9_.-]*)`/gi;
  for (const judgment of judgments) {
    const groups = [
      { kind: "constraint" as const, texts: judgment.constraints },
      { kind: "escalation" as const, texts: judgment.escalation_triggers },
    ];
    for (const { kind, texts } of groups) {
      for (const text of texts) {
        for (const match of text.matchAll(IDENT)) {
          const ident = match[1];
          if (ident) {
            rules.push({ toolName: ident, kind, sourceDomain: judgment.domain, sourceText: text });
          }
        }
      }
    }
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AgenticPatternsPluginOptions {
  /** The core Agent this ADK agent was constructed from (same instance). */
  agent: Agent;
  /** Runtime-shaped event sink, e.g. `(e) => bus.emit(e as AgentEvent)`. */
  emit?: EventSink;
  /** Explicit deterministic guardrails, merged after judgment-derived rules. */
  guardrails?: GuardrailRule[];
  /** Extract heuristic rules from Judgment atoms (default true). */
  deriveGuardrailsFromJudgments?: boolean;
  /** Session-state key prefix (default "apts:"). */
  stateKeyPrefix?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

interface ValidationVerdict {
  ok: boolean;
  errors: string[];
}

function isZodSchema(schema: unknown): schema is ZodTypeAny {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "_def" in schema &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

/** Strip markdown fences and pull the outermost JSON object out of a reply. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  try {
    return JSON.parse(slice);
  } catch {
    return undefined;
  }
}

function validateOutput(text: string, schema: unknown): ValidationVerdict {
  const parsed = extractJson(text);
  if (parsed === undefined) {
    return { ok: false, errors: ["response is not parseable JSON"] };
  }
  if (isZodSchema(schema)) {
    const result = schema.safeParse(parsed);
    if (result.success) {
      return { ok: true, errors: [] };
    }
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`),
    };
  }
  // Raw JSON-schema dict: v1 checks top-level required keys only. Honest shim —
  // full JSON-schema validation needs ajv (deliberately not a dependency yet).
  const required = (schema as { required?: unknown }).required;
  if (Array.isArray(required) && typeof parsed === "object" && parsed !== null) {
    const missing = required.filter(
      (key) => typeof key === "string" && !(key in (parsed as Record<string, unknown>)),
    );
    if (missing.length > 0) {
      return { ok: false, errors: missing.map((key) => `missing required key: ${String(key)}`) };
    }
  }
  return { ok: true, errors: [] };
}

// ---------------------------------------------------------------------------
// Compat helpers — the ONLY places uncertain ADK members are touched.
// VERIFY-AGAINST-ADK-JS-SOURCE for each.
// ---------------------------------------------------------------------------

function readState(ctx: AdkCallbackContext, key: string): unknown {
  try {
    return ctx.state.get(key);
  } catch {
    return undefined;
  }
}

function writeState(ctx: AdkCallbackContext, key: string, value: unknown): void {
  try {
    ctx.state.set(key, value);
  } catch {
    // State unavailable in this context — turn discipline degrades to
    // initial-prompt-only rather than crashing the run.
  }
}

/**
 * Mutate the outgoing request's system instruction in place. Python ADK
 * documents both llm_request.append_instructions([...]) and direct
 * llm_request.config.system_instruction mutation; try the method first.
 */
function appendSystemInstruction(request: AdkLlmRequest, text: string): void {
  if (typeof request.appendInstructions === "function") {
    request.appendInstructions([text]);
    return;
  }
  const config = (request.config ??= {});
  const existing = config.systemInstruction;
  config.systemInstruction =
    typeof existing === "string" && existing.length > 0 ? `${existing}\n\n${text}` : text;
}

function trace(ctx: AdkCallbackContext | AdkInvocationContext): { traceId: string; runId: string } {
  return {
    traceId: ctx.session?.id ?? "adk-session",
    runId: ctx.invocationId ?? "adk-invocation",
  };
}

function responseText(response: AdkLlmResponse): string {
  return (response.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

function responseHasFunctionCalls(response: AdkLlmResponse): boolean {
  return (response.content?.parts ?? []).some((p) => p.functionCall != null);
}

/**
 * Locate tool arguments. Python ADK passes tool_args as a separate callback
 * parameter; the adk-js docs show (tool, context). If adk-js turns out to pass
 * args as their own parameter, thread them through here — single seam.
 */
function getToolArgs(context: AdkToolContext): Record<string, unknown> {
  const candidate =
    (context as { args?: unknown }).args ?? (context as { toolArgs?: unknown }).toolArgs;
  return (candidate as Record<string, unknown> | undefined) ?? {};
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class AgenticPatternsPlugin extends BasePlugin {
  private readonly agent: Agent;
  private readonly emitSink: EventSink | undefined;
  private readonly rules: GuardrailRule[];
  private readonly prefix: string;
  /** functionCallId -> Date.now() at tool start, for real durations. */
  private readonly toolStartTimes = new Map<string, number>();

  constructor(options: AgenticPatternsPluginOptions) {
    super("agentic-patterns");
    this.agent = options.agent;
    this.emitSink = options.emit;
    this.prefix = options.stateKeyPrefix ?? "apts:";
    const derived =
      options.deriveGuardrailsFromJudgments === false
        ? []
        : compileJudgmentGuardrails(this.agent.role.judgments.map((j) => j.data));
    this.rules = [...derived, ...(options.guardrails ?? [])];
  }

  // -- 4. observability: run start carries the rendered system prompt --------
  // (parity with runtime's MessageStartEvent — no other event carries it)

  async beforeRunCallback(invocationContext: AdkInvocationContext): Promise<undefined> {
    this.emitBridged("agent.message.start", trace(invocationContext), {
      agentName: invocationContext.agent?.name ?? "agent",
      systemPrompt: this.agent.renderInitialPrompt(),
    });
    return undefined;
  }

  // -- 1. turn discipline -----------------------------------------------------

  async beforeModelCallback(
    context: AdkCallbackContext,
    llmRequest: AdkLlmRequest,
  ): Promise<AdkLlmResponse | undefined> {
    const ids = trace(context);
    const turn = Number(readState(context, this.key("turn")) ?? 0);

    if (turn > 0) {
      // Core's turn-N discipline: State + Mission + Methodology delta.
      // APPEND rather than replace: ADK re-derives the system instruction from
      // the static agent.instruction on every call and never stores it in
      // session history, so core's "identity lives in history" premise does
      // not hold here — replacing would drop Persona/Judgments entirely. The
      // Mission/Methodology repetition doubles as recency reinforcement.
      const state = this.loadCoreState(context, turn);
      let delta = this.agent.renderContinuationPrompt(state);

      const repair = readState(context, this.key("repair"));
      const repairErrors =
        repair != null && Array.isArray((repair as { errors?: unknown }).errors)
          ? ((repair as { errors: unknown[] }).errors as string[])
          : undefined;
      if (repairErrors) {
        delta += [
          "",
          "",
          "## Output Repair Required",
          "Your previous response failed output-schema validation:",
          ...repairErrors.map((e) => `- ${e}`),
          "Respond again with ONLY valid JSON matching the required schema.",
        ].join("\n");
        writeState(context, this.key("repair"), null);
      }

      appendSystemInstruction(llmRequest, delta);
      this.saveCoreState(context, state);
    }

    writeState(context, this.key("turn"), turn + 1);
    this.emitBridged("agent.iteration.start", ids, { iteration: turn, maxIterations: -1 });
    return undefined; // observe: in-place llmRequest mutations persist
  }

  // -- 2. judgment guardrails (intervene) --------------------------------------

  async beforeToolCallback(
    tool: AdkTool,
    context: AdkToolContext,
  ): Promise<Record<string, unknown> | undefined> {
    const ids = trace(context);
    const args = getToolArgs(context);
    const callId = context.functionCallId ?? `${tool.name}:${newId()}`;

    const hit = this.matchGuardrail(tool.name, args);
    if (hit) {
      if (hit.kind === "escalation") {
        // Sticky by design: escalation demands a human; the next continuation
        // prompt renders "Phase: blocked" so the model sees it too.
        const prev =
          (readState(context, this.key("state")) as Partial<StateData> | undefined) ?? {};
        writeState(context, this.key("state"), { ...prev, phase: Phase.BLOCKED });
      }
      // Parity with runtime's GateChain rejection event.
      this.emitBridged("agent.tool.rejected", ids, {
        toolName: tool.name,
        reason: hit.sourceText,
        gateName: "JudgmentGuardrail",
        gateCategory: "SAFETY",
        originalIntent: { toolCallId: callId, toolName: tool.name, arguments: args },
      });
      // Intervene: this record becomes the tool result the model sees.
      return {
        status: "blocked",
        blocked_by: `judgment:${hit.sourceDomain}`,
        rule_kind: hit.kind,
        reason: hit.sourceText,
        guidance:
          hit.kind === "escalation"
            ? "This action matches an escalation trigger. Stop and hand off to a human. Do not retry."
            : "This action violates a standing constraint. Do not retry it; choose a compliant approach.",
      };
    }

    this.toolStartTimes.set(callId, Date.now());
    this.emitBridged("agent.tool.start", ids, {
      toolCallId: callId,
      toolName: tool.name,
      arguments: args,
    });
    return undefined;
  }

  async afterToolCallback(
    tool: AdkTool,
    context: AdkToolContext,
    result: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    const ids = trace(context);
    const callId = context.functionCallId ?? tool.name;
    const startedAt = this.toolStartTimes.get(callId);
    this.toolStartTimes.delete(callId);

    // Feed core State.last_action for the next continuation prompt.
    const prev = (readState(context, this.key("state")) as Partial<StateData> | undefined) ?? {};
    writeState(context, this.key("state"), { ...prev, last_action: tool.name });

    this.emitBridged("agent.tool.end", ids, {
      toolCallId: callId,
      toolName: tool.name,
      arguments: getToolArgs(context),
      result,
      durationMs: startedAt != null ? Date.now() - startedAt : 0,
      resultTokens: 0,
    });
    return undefined;
  }

  // -- 3. mission strict output (intervene) -------------------------------------

  async afterModelCallback(
    context: AdkCallbackContext,
    llmResponse: AdkLlmResponse,
  ): Promise<AdkLlmResponse | undefined> {
    const mission = this.agent.mission.data;
    if (!mission.strict_output || mission.output_schema == null) {
      return undefined;
    }
    if (responseHasFunctionCalls(llmResponse)) {
      return undefined; // tool-calling turn, not final output
    }
    const text = responseText(llmResponse);
    if (text.trim() === "") {
      return undefined;
    }

    const verdict = validateOutput(text, mission.output_schema);
    if (verdict.ok) {
      return undefined;
    }

    const ids = trace(context);
    // Lazy self-heal: the next beforeModelCallback injects a repair
    // instruction carrying these errors, then clears the flag.
    writeState(context, this.key("repair"), { errors: verdict.errors });
    this.emitBridged("agent.error", ids, {
      errorType: "OutputValidationError",
      message: `strict_output validation failed: ${verdict.errors.join("; ")}`,
      recoverable: true,
      context: { errors: verdict.errors },
    });

    // Intervene by REPLACING the response with a machine-detectable failure
    // envelope. Chosen over an in-plugin repair loop because afterModelCallback
    // is replace-only — a plugin cannot schedule another model call. Hosts that
    // loop can detect `apts_error` and re-prompt; interactive sessions get the
    // automatic repair instruction on the next turn.
    // VERIFY-AGAINST-ADK-JS-SOURCE: the real LlmResponse may need to be
    // constructed via `new LlmResponse({...})` rather than a structural literal.
    return {
      content: {
        role: "model",
        parts: [
          {
            text: JSON.stringify(
              {
                apts_error: "OUTPUT_VALIDATION_FAILED",
                errors: verdict.errors,
                expected: renderSchemaForPrompt(
                  mission.output_schema as ZodTypeAny | Record<string, unknown>,
                ),
              },
              null,
              2,
            ),
          },
        ],
      },
    };
  }

  // -- 4. observability: event-stream bridge (observe-only) ---------------------

  async onEventCallback(
    invocationContext: AdkInvocationContext,
    event: AdkEvent,
  ): Promise<AdkEvent | undefined> {
    if (!this.emitSink) {
      return undefined;
    }
    const ids = trace(invocationContext);
    const parts = event.content?.parts ?? [];

    for (const part of parts) {
      if (part.functionCall != null) {
        this.emitBridged("agent.tool.intent", ids, {
          toolCallId: part.functionCall.id ?? newId(),
          toolName: part.functionCall.name ?? "unknown",
          arguments: part.functionCall.args ?? {},
        });
      }
      // functionResponse parts are deliberately NOT mapped here — tool.start /
      // tool.end are emitted from the tool callbacks with real durations.
    }

    const text = parts.map((p) => p.text ?? "").join("");
    const isFinal = typeof event.isFinalResponse === "function" ? event.isFinalResponse() : false;
    if (isFinal && text !== "") {
      this.emitBridged("agent.message.complete", ids, {
        content: text,
        inputTokens: 0, // ADK usage-metadata location unverified; see risks
        outputTokens: 0,
        model: this.agent.getModel(),
      });
    }
    return undefined; // never rewrite ADK's event stream
  }

  // -- internals ---------------------------------------------------------------

  private key(suffix: string): string {
    return `${this.prefix}${suffix}`;
  }

  private loadCoreState(ctx: AdkCallbackContext, turn: number): State {
    const raw = (readState(ctx, this.key("state")) as Partial<StateData> | undefined) ?? {};
    return new State({
      iteration: turn,
      phase: raw.phase ?? (turn === 0 ? Phase.PLANNING : Phase.EXECUTING),
      accumulated_context: raw.accumulated_context ?? {},
      last_action: raw.last_action ?? null,
    });
  }

  private saveCoreState(ctx: AdkCallbackContext, state: State): void {
    // StateData is plain + JSON-serializable — safe for ADK session state.
    writeState(ctx, this.key("state"), state.data);
  }

  private matchGuardrail(
    toolName: string,
    args: Record<string, unknown>,
  ): GuardrailRule | undefined {
    const argText = safeStringify(args);
    return this.rules.find((rule) => {
      const hasMatcher =
        rule.toolName != null || rule.toolPattern != null || rule.argPattern != null;
      if (!hasMatcher) {
        return false; // a matcher-less rule must never block everything
      }
      if (rule.toolName != null && rule.toolName !== toolName) {
        return false;
      }
      if (rule.toolPattern != null && !rule.toolPattern.test(toolName)) {
        return false;
      }
      if (rule.argPattern != null && !rule.argPattern.test(argText)) {
        return false;
      }
      return true;
    });
  }

  private emitBridged(
    type: string,
    ids: { traceId: string; runId: string },
    payload: Record<string, unknown>,
  ): void {
    if (!this.emitSink) {
      return;
    }
    this.emitSink({
      type,
      traceId: ids.traceId,
      runId: ids.runId,
      spanId: newId(),
      timestamp: new Date(),
      ...payload,
    });
  }
}

```

