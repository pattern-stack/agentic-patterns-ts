/**
 * `sequentialAgent()` — ONE agent composed of AGENTS in sequence over an implicitly shared Scratchpad
 * (DESIGN §6.2 companion; the ADK `SequentialAgent` parity primitive).
 *
 * `Sequential` chains NODES with typed output→input seams — which means every
 * agent must be hand-seated in an `AgentStep` (prompt builder in, wiring out).
 * That seat ceremony is exactly what consumers kept re-writing per phase. This
 * primitive is the marriage of the two existing halves:
 *
 *   agents (AgentLike)  ×  Scratchpad (the shared state)  →  a pipeline Node
 *
 * SEMANTICS
 *  - The Scratchpad IS the implicitly passed context layer: each stage's
 *    emission lands in a slot (auto-created per stage, or a caller-provided
 *    one), and every LATER stage's prompt is rendered from the pipeline input
 *    plus the immediately-PRIOR emission (visibility follows the chain — a
 *    curation stage's cuts stay cut; `opts.render = renderSharedState` opts a
 *    sequence into ADK-session-style all-prior visibility). A stage may override `prompt` to render a WINDOWED
 *    view instead (large payloads should live in slots its `onEmit` writes).
 *  - Because slots are run-scoped, the same sharing holds across `Loop`
 *    iterations for free: `Loop({ body: sequentialAgent([...]) })` re-enters
 *    with the pad intact. (Subagent teams — `delegateTo` — do NOT see the pad
 *    yet; opt-in sharing there is a declared follow-up.)
 *  - `output` (zod) per stage is OPTIONAL: structured stages emit through
 *    `runStructured`, bare stages take the raw-text path. Per-agent
 *    InputShape/OutputShape mapping across the sequence is a declared
 *    fast-follow (open: a shape may not exist on every INSTANCE of an agent).
 *  - `stop` turns an emission into a short-circuit: later stages are skipped
 *    and the result carries `{ stage, reason }` — the control plane. `onEmit`
 *    (the fused deterministic follow-through of a stage's decision) may also
 *    stop by RETURNING a reason string.
 *  - Tool-using stages just work: the executor is created per stage from the
 *    agent's own capabilities (`createToolboxExecutor`) — the classic
 *    forgotten-executor failure cannot happen inside a sequence.
 *  - Declared `reads`/`writes` get a build-time write-before-read assert, so
 *    re-ordering stages is a construction error, not a silent empty run.
 *  - A stage may be a NODE instead of an agent (`{ node }`, or a bare `Node` in
 *    the stages array): a `CoordinatorStep` spine, a deterministic
 *    `FunctionStep` tail, a nested `sequentialAgent`. It is seated as the
 *    stage's leaf directly (no `AgentStep` wrap) and is a first-class stage —
 *    its emission lands in a slot, `onEmit`/`stop`/`reads`/`writes`/`retry` all
 *    apply, and the NEXT stage's implicit render carries it. What does NOT
 *    apply are the two AgentStep-only knobs — `prompt` and `maxIterations` —
 *    which are REJECTED at build time rather than silently ignored (a node
 *    renders no prompt and runs no tool loop of its own). A node stage receives
 *    the pipeline INPUT (same as every other stage); it sees what the chain
 *    established through the PAD, so give the producing stage an explicit
 *    `slot` and read it inside the node (`FunctionStep`'s fn takes a
 *    `ScratchpadAccess`). `output` (zod) on a node stage is an ASSERT over the
 *    node's own output, not a `runStructured` driver — see the field doc.
 *  - TYPED OUTPUT (#255): `sequentialAgent<TOut>(stages, { emit: '<stage>' })`
 *    designates ONE stage's emission as the composite's own output — the node
 *    types as `Node<TIn, TOut>` instead of the untyped `SequentialAgentResult`
 *    envelope. Designation is COMPOSITE-level (an opts key naming the stage —
 *    not a per-stage marker, not last-stage-wins) so the convention
 *    generalizes to a parallel sibling, whose natural emission is the joined
 *    record. Stop interplay: a `stop` AT or AFTER the designated stage still
 *    resolves to the emission (the stop only prunes later stages); a stop
 *    BEFORE it fails the node — the contract was never produced. See
 *    {@link TypedSequentialAgentOpts.emit}.
 *  - `input: 'prior'` (#255, node stages only) hands the stage's leaf the
 *    immediately-prior stage's emission instead of the pipeline input — the
 *    typed spine → tail seam (`CoordinatorStep<string, TEmission>` feeding a
 *    `FunctionStep<TEmission, TContract>`) with no nullable slot read. The
 *    default stays 'pipeline' (#245's behavior, unchanged).
 *
 * The built object implements {@link Node}, so it nests anywhere a node is
 * accepted (a Sequential stage, a Loop body, a FanOut branch, a sub-tool).
 */

import { generateId } from "ai";
import type { ZodType } from "zod";
import type { AgentEvent } from "../events/types.js";
import { createEvent } from "../events/types.js";
import type { AgentLike } from "../runner/agent-runner.js";
import { createToolboxExecutor } from "../runner/toolbox-executor.js";
import { AgentStep } from "./agent-step.js";
import type { Node, NodeResult, NodeRunContext } from "./node.js";
import { ObservedScratchpad } from "./observed-scratchpad.js";
import { retry } from "./retry.js";
import { isAgentLikeShape, isNodeShape } from "./shapes.js";
import {
  type ScratchpadAccess,
  type ScratchpadReader,
  type Slot,
  createScratchpad,
  slot,
} from "./slot.js";
import { capPreview } from "./state-events.js";

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

/**
 * One seated stage — an AGENT (`agent`) or a NODE (`node`). EXACTLY ONE of the
 * two is required; both, or neither, is a build-time error.
 *
 * A bare `AgentLike` or a bare `Node` is accepted wherever a spec is (all
 * defaults).
 */
export interface AgentStageSpec<TOut = unknown> {
  /** The agent seated in this stage (wrapped in an `AgentStep`). Mutually exclusive with `node`. */
  readonly agent?: AgentLike;
  /**
   * A NODE seated as this stage's leaf directly — a `CoordinatorStep` spine, a
   * deterministic `FunctionStep` tail, a nested `sequentialAgent`. Mutually
   * exclusive with `agent`.
   *
   * It runs with the pipeline `input` and the sequence's shared pad on its ctx,
   * and its result IS the stage's emission — so `slot`, `onEmit`, `stop`,
   * `reads`/`writes` and `retry` all apply exactly as they do to an agent
   * stage, and the next stage's implicit render carries it. The two
   * AgentStep-only knobs (`prompt`, `maxIterations`) are REJECTED at build time
   * when combined with `node`.
   *
   * A node has no prompt render, so it reads what the chain established through
   * the PAD (`ctx.scratchpad` / `FunctionStep`'s `ScratchpadAccess`): give the
   * producing stage an explicit `slot` and read that slot inside the node.
   */
  // biome-ignore lint/suspicious/noExplicitAny: a stage node's TIn is the pipeline input (unknown at the seam) and Node is contravariant in it — `any` is the deliberate variance escape so typed nodes (FunctionStep<Q,R>, CoordinatorStep<Q,R>) seat WITHOUT casts, same escape as AgentStage below.
  readonly node?: Node<any, unknown>;
  /**
   * What this stage's NODE receives as its run input (#255):
   *  - `'pipeline'` (default) — the sequence's own input; #245's behavior,
   *    unchanged.
   *  - `'prior'` — the immediately-prior stage's emission, VERBATIM. Seats the
   *    deterministic tail without degrading its seam to a nullable slot read:
   *    the spine emits `TEmission`, the tail is a
   *    `FunctionStep<TEmission, TContract>`, and the tail's `fn` input is
   *    compiler-checked at its own boundary. A `retry` re-runs the leaf with
   *    the SAME resolved input.
   *
   * NODE stages only — rejected at build time on an `agent` stage (an agent
   * stage already receives the prior emission through its implicit render;
   * override `prompt` or `opts.render` to reshape what it sees). Rejected on
   * the FIRST stage (there is no prior emission to receive).
   */
  readonly input?: "pipeline" | "prior";
  /**
   * Stage name = the emission's slot key + the progress label. Default: the
   * agent's role name (agent stages) / the node's `name` (node stages).
   */
  readonly name?: string;
  /**
   * AGENT stage: the structured emission schema → `runStructured` (omit for the
   * raw-text path).
   *
   * NODE stage: an ASSERT, not a driver — the node is already typed at its own
   * boundary, so there is nothing to steer. The node's output is validated
   * against the schema (a mismatch fails the stage BEFORE it emits, so an
   * opted-in `retry` re-runs it), and the EMISSION is the node's own output
   * VERBATIM — never the zod-parsed value. So a schema with transforms/strips
   * validates but does not rewrite what the stage emits.
   */
  readonly output?: ZodType<TOut>;
  /**
   * Override the implicit state render for THIS stage's user message. Default:
   * the pipeline input + every prior stage's emission (see `renderSharedState`).
   *
   * AGENT stages only — rejected at build time on a `node` stage (a node has no
   * user message; it reads the pad).
   */
  readonly prompt?: (state: ScratchpadReader, input: unknown) => string;
  /** Where the emission lands. Default: an auto slot keyed `agents.<name>`. */
  // biome-ignore lint/suspicious/noExplicitAny: Slot<T> is invariant (its `merge` param); the emission write is dynamically typed by design — the SequentialBuilder precedent.
  readonly slot?: Slot<any>;
  /**
   * The stage's fused deterministic follow-through — code that REALIZES the
   * agent's decision (writes derived slots, executes the read, enforces
   * floors). Contract: RETURN A STRING to stop the sequence with that reason;
   * any other return value is ignored.
   */
  readonly onEmit?: (output: TOut, pad: ScratchpadAccess, ctx: NodeRunContext) => unknown;
  /** Emission-level stop rule (clarify/refuse lanes): a string stops the sequence. */
  readonly stop?: (output: TOut, state: ScratchpadReader) => string | null;
  /**
   * Tool/2-tier loop cap for this stage (AgentStep semantics).
   *
   * AGENT stages only — rejected at build time on a `node` stage (a node runs
   * no agent loop of its own; cap it inside the node — e.g. the coordinator
   * agent's own `maxIterations`).
   */
  readonly maxIterations?: number;
  /**
   * Re-run this stage's leaf — the agent, or the `node` — as a FRESH attempt
   * (the poisoned transcript is discarded, the prompt render is unchanged) up
   * to N times when the run fails BEFORE an emission materializes (agent-run
   * error / no structured output — e.g. a tool loop that burns `maxIterations`
   * and never emits; for a node stage: a failed `NodeResult`, or an `output`
   * schema the node's result did not satisfy). Default `0` (today's behavior:
   * one attempt, and a pre-emission failure aborts the sequence).
   *
   * SCOPE: pre-emission failures only. `runStructured`'s own shape re-prompting
   * lives inside a single attempt and is NOT multiplied by this. `stop`/`onEmit`
   * run only after a successful emission, so they never fire on a failed attempt;
   * an `onEmit`-thrown error is the consumer's tail and is never retried here.
   * Exhausted retries surface the leaf's ORIGINAL failure shape unchanged.
   * Reuses the runtime's {@link Retry} node, so opted-in stages emit its
   * `pattern.*` lifecycle events on the bus (one iteration per attempt).
   *
   * COST: `maxIterations` is PER ATTEMPT, so a stage's worst-case cost is
   * `(retry + 1) × budget` — intended (a fresh do-over gets a fresh budget).
   * A thrown pre-emission failure carries 0 tokens through `AgentStep`'s catch,
   * so failed attempts add nothing to the token rollup; the succeeding attempt's
   * tokens surface as usual.
   *
   * Follow-ups (out of scope v1): a `retryOn` predicate; backoff.
   */
  readonly retry?: number;
  /** Optional slot-dependency declarations → build-time write-before-read assert. */
  readonly reads?: ReadonlyArray<{ readonly key: string }>;
  /** Extra slots this stage's tail writes (the emission slot is declared automatically). */
  readonly writes?: ReadonlyArray<{ readonly key: string }>;
}

/**
 * What the stages array accepts: a bare `AgentLike`, a bare `Node`, or a
 * {@link AgentStageSpec} (`{ agent }` or `{ node }` + the stage knobs).
 *
 * Bare-value discrimination is by DUCK TYPE ({@link isAgentLikeShape} then
 * {@link isNodeShape}) — agent-shape is checked FIRST, so an `AgentLike` that
 * also happens to carry a `run` method (and an `asAgent`-promoted pipeline,
 * which is deliberately AgentLike-shaped) still seats as an AGENT, exactly as
 * it does today. There is no ambiguity in the other direction: a bare `Node`
 * has no `role`/`getModel`/`renderInitialPrompt`.
 */
// biome-ignore lint/suspicious/noExplicitAny: TOut appears contravariantly in the stage callbacks (onEmit/stop) and TIn contravariantly in a stage Node, so AgentStageSpec<T>/Node<T,…> would never assign to their `unknown` forms — `any` is the deliberate variance escape so typed specs and typed nodes seat WITHOUT casts (the SequentialBuilder precedent).
export type AgentStage = AgentLike | Node<any, unknown> | AgentStageSpec<any>;

export interface SequentialAgentOpts {
  readonly name?: string;
  /**
   * The implicit state render used for stages without a custom `prompt`.
   * Default: {@link renderPriorEmission} — visibility follows the CHAIN (a
   * curation stage's cuts stay cut). Pass {@link renderSharedState} for
   * ADK-session-style all-prior visibility.
   *
   * OBSERVABILITY: on an observed pad the two BUILT-IN renders publish one
   * innate `agent.scratchpad.read` per prior emission they inject (#226 — the
   * design's prompt-read frame). A CUSTOM render function's injections are
   * opaque to the framework, so it mints no innate read frames; reads a custom
   * stage `prompt` makes through its `state` reader still report as explicit.
   */
  readonly render?: (input: unknown, completed: ReadonlyArray<CompletedStage>) => string;
}

/**
 * The TYPED form's options (#255): {@link SequentialAgentOpts} + a designated
 * emitting stage. `sequentialAgent<TOut>(stages, { emit: '<stage name>' })`
 * types the composite `Node<TIn, TOut>` and resolves its output to that
 * stage's emission verbatim.
 */
export interface TypedSequentialAgentOpts extends SequentialAgentOpts {
  /**
   * The DESIGNATED EMITTING STAGE, by stage name: the composite's output is
   * this stage's emission (VERBATIM — the same value its slot receives), and
   * the composite types as `Node<TIn, TOut>` instead of the untyped
   * `SequentialAgentResult` envelope. A name no stage carries is a build-time
   * error.
   *
   * COMPOSITE-level by design (#255): an opts key naming the stage — NOT a
   * per-stage marker and NOT last-stage-wins — so the convention generalizes
   * to a parallel sibling (a fan-out's natural emission is the joined record;
   * it has no "last stage"). A stage-spec `emit` key is rejected at build time
   * with a pointer here.
   *
   * The designated stage need not be terminal: later stages still run (their
   * emissions land on the pad as usual); the composite's OUTPUT is pinned to
   * the designated emission. STOP interplay: `stop`/`onEmit` fire only after
   * an emission materializes, so a stop AT or AFTER the designated stage still
   * resolves the output; a stop BEFORE it returns `{ succeeded: false }` — the
   * pipeline never produced its contract. Pipelines with clarify/refuse lanes
   * UPSTREAM of the emitting stage should stay on the untyped form and branch
   * on `stopped`, or fold those lanes into the contract type itself.
   */
  readonly emit: string;
}

/** One completed stage's contribution to the shared context render. */
export interface CompletedStage {
  readonly name: string;
  readonly output: unknown;
}

export interface SequentialAgentResult {
  /** Every completed stage's emission, by stage name. */
  readonly outputs: Record<string, unknown>;
  /** Set when a stage's `stop`/`onEmit` short-circuited the sequence. */
  readonly stopped: { readonly stage: string; readonly reason: string } | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** The EXACT text one emission contributes to an implicit render. Shared by
 *  both built-in renders AND the innate prompt-read frame's preview, so the
 *  event's "exact injected text" claim holds by construction. */
function renderEmissionBody(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output, null, 1);
}

/**
 * The all-prior render (OPT-IN via `opts.render` — for reviewer-style stages that
 * should see everything established): the task + EVERY prior emission.
 */
export function renderSharedState(
  input: unknown,
  completed: ReadonlyArray<CompletedStage>,
): string {
  const task = typeof input === "string" ? input : JSON.stringify(input, null, 1);
  if (completed.length === 0) return task;
  const sections = completed.map((c) => `## ${c.name}\n${renderEmissionBody(c.output)}`);
  return `${task}\n\nWHAT PRIOR STAGES ESTABLISHED:\n\n${sections.join("\n\n")}`;
}

/** The DEFAULT implicit render: the task + the immediately-prior emission only —
 *  what a stage acts on is what the chain just established (post-curation stages
 *  don't implicitly resurrect pre-curation detail). Artifacts/big payloads ride
 *  SLOTS, never emissions. */
export function renderPriorEmission(
  input: unknown,
  completed: ReadonlyArray<CompletedStage>,
): string {
  const task = typeof input === "string" ? input : JSON.stringify(input, null, 1);
  const prior = completed[completed.length - 1];
  if (prior == null) return task;
  return `${task}\n\nWHAT THE PRIOR STAGE ESTABLISHED (${prior.name}):\n${renderEmissionBody(prior.output)}`;
}

/**
 * Normalize a stages entry to a spec: a bare `AgentLike` / bare `Node` is
 * duck-typed into one (agent-shape FIRST — see {@link AgentStage}); anything
 * else object-shaped is taken AS a spec and left to the exactly-one-leaf guard,
 * which owns the message (a `{ name }`-only object and a stray non-stage object
 * are the same authoring mistake — an entry that seats no leaf).
 */
function toSpec(stage: AgentStage, index: number): AgentStageSpec {
  if (isAgentLikeShape(stage)) return { agent: stage };
  if (isNodeShape(stage)) return { node: stage };
  if (stage && typeof stage === "object") return stage as AgentStageSpec;
  throw new Error(
    `sequentialAgent: stage ${index + 1} is not a stage — pass an AgentLike, a Node, or { agent } / { node }`,
  );
}

function stageName(stage: AgentStageSpec, index: number): string {
  return (
    stage.name ??
    (stage.agent as { role?: { name?: string } } | undefined)?.role?.name ??
    stage.node?.name ??
    `stage-${index + 1}`
  );
}

/**
 * The node stage's `output` ASSERT (see {@link AgentStageSpec.output}): validate
 * the node's result, emit the node's OWN output verbatim (never the parsed
 * value — a node is typed at its own boundary; a zod transform/strip must not
 * silently rewrite what the stage emits). A mismatch fails the leaf BEFORE the
 * emission materializes, so it sits inside `retry`'s scope like any other
 * pre-emission failure.
 */
function assertingNode(
  node: Node<unknown, unknown>,
  schema: ZodType<unknown>,
  name: string,
): Node<unknown, unknown> {
  return {
    name: node.name ?? name,
    async run(input: unknown, ctx: NodeRunContext): Promise<NodeResult<unknown>> {
      const res = await node.run(input, ctx);
      if (!res.succeeded) return res;
      const parsed = schema.safeParse(res.output);
      if (parsed.success) return res;
      return {
        output: undefined as never,
        succeeded: false,
        error: new Error(
          `sequentialAgent: stage '${name}' node output failed its \`output\` schema — ${parsed.error.message}`,
        ),
        totalInputTokens: res.totalInputTokens,
        totalOutputTokens: res.totalOutputTokens,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------

/**
 * Seat `stages` in order over one shared Scratchpad and return the pipeline as
 * a {@link Node}. See the module doc for semantics.
 *
 * Two forms (#255):
 *  - `sequentialAgent(stages, opts?)` — the untyped envelope,
 *    `Node<unknown, SequentialAgentResult>` (today's shape, unchanged).
 *  - `sequentialAgent<TOut[, TIn]>(stages, { emit: '<stage>' })` — a
 *    designated emitting stage types the composite `Node<TIn, TOut>` and
 *    resolves its output to that stage's emission. The overloads make the
 *    pairing STRUCTURAL: a type argument requires `emit` (no typed call whose
 *    runtime output is secretly the envelope), and `emit` diverts the return
 *    type even without a type argument (`TOut` defaults to `unknown` —
 *    honest, narrow at the consumer).
 */
export function sequentialAgent(
  stages: ReadonlyArray<AgentStage>,
  opts?: SequentialAgentOpts & { readonly emit?: undefined },
): Node<unknown, SequentialAgentResult>;
export function sequentialAgent<TOut = unknown, TIn = unknown>(
  stages: ReadonlyArray<AgentStage>,
  opts: TypedSequentialAgentOpts,
): Node<TIn, TOut>;
export function sequentialAgent(
  stages: ReadonlyArray<AgentStage>,
  opts: SequentialAgentOpts & { readonly emit?: string } = {},
): Node<unknown, unknown> {
  if (stages.length === 0) throw new Error("sequentialAgent: at least one stage is required");
  const specs = stages.map((s, i) => toSpec(s, i));

  // Build-time assert: EXACTLY ONE leaf per stage. Both is an authoring
  // ambiguity (which one runs?); neither is an empty stage — fail loud on the
  // spec form rather than silently seating one and dropping the other.
  specs.forEach((s, i) => {
    if (s.agent !== undefined && s.node !== undefined) {
      throw new Error(
        `sequentialAgent: stage ${i + 1} sets BOTH \`agent\` and \`node\` — exactly one is required`,
      );
    }
    if (s.agent === undefined && s.node === undefined) {
      throw new Error(
        `sequentialAgent: stage ${i + 1} sets NEITHER \`agent\` nor \`node\` — exactly one is required (pass an AgentLike, a Node, or { agent } / { node })`,
      );
    }
  });

  const names = specs.map((s, i) => stageName(s, i));
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe != null) {
    throw new Error(
      `sequentialAgent: duplicate stage name '${dupe}' — set an explicit \`name\` per stage`,
    );
  }

  // Build-time assert: `retry` is a non-negative integer (same ethos as the
  // dupe-name and write-before-read guards — a construction error, not a
  // silent runtime surprise).
  specs.forEach((s, i) => {
    if (s.retry !== undefined && (!Number.isInteger(s.retry) || s.retry < 0)) {
      throw new Error(
        `sequentialAgent: stage '${names[i]}' has invalid retry ${s.retry} — must be a non-negative integer`,
      );
    }
  });

  // Build-time assert: the AgentStep-only knobs are REJECTED on a node stage
  // rather than silently ignored — a node renders no user message (`prompt`)
  // and runs no agent loop of its own (`maxIterations`). The knobs that operate
  // on the stage's EMISSION (`slot`/`onEmit`/`stop`/`reads`/`writes`/`retry`,
  // and `output` as an assert) all apply to node stages, so they are not listed.
  specs.forEach((s, i) => {
    if (s.node === undefined) return;
    for (const knob of ["prompt", "maxIterations"] as const) {
      if (s[knob] !== undefined) {
        throw new Error(
          `sequentialAgent: stage '${names[i]}' sets \`${knob}\` on a \`node\` stage — \`${knob}\` is an AgentStep-only knob (a node renders no prompt and runs no agent loop). A node reads the pad; cap iterations inside the node.`,
        );
      }
    }
  });

  // Build-time assert (#255): `emit` is NOT a stage knob — designation is
  // COMPOSITE-level so the convention generalizes to parallel siblings (a
  // fan-out has no terminal stage). Rejected rather than silently ignored.
  specs.forEach((s, i) => {
    if ("emit" in s) {
      throw new Error(
        `sequentialAgent: stage '${names[i]}' sets \`emit\` on the stage spec — the emitting stage is designated at the COMPOSITE level: sequentialAgent<TOut>(stages, { emit: '${names[i]}' })`,
      );
    }
  });

  // Build-time assert (#255): `input` is a NODE-stage knob. On an agent stage
  // the prior emission already arrives through the implicit render; on the
  // first stage there is nothing prior to receive. Same reject-loudly ethos.
  specs.forEach((s, i) => {
    if (s.input === undefined) return;
    if (s.input !== "pipeline" && s.input !== "prior") {
      throw new Error(
        `sequentialAgent: stage '${names[i]}' has invalid input '${String(s.input)}' — expected 'pipeline' or 'prior'`,
      );
    }
    if (s.node === undefined) {
      throw new Error(
        `sequentialAgent: stage '${names[i]}' sets \`input\` on an \`agent\` stage — \`input\` is a node-stage knob (an agent stage already sees the prior emission through its implicit render; override \`prompt\` or \`opts.render\` to reshape it)`,
      );
    }
    if (s.input === "prior" && i === 0) {
      throw new Error(
        `sequentialAgent: stage '${names[i]}' sets input: 'prior' but is the FIRST stage — there is no prior emission (the first stage receives the pipeline input)`,
      );
    }
  });

  // COMPOSITE-level emit designation (#255): resolve + validate the name now —
  // a typo is a construction error, not a silently envelope-shaped output.
  if (opts.emit !== undefined && typeof opts.emit !== "string") {
    throw new Error(
      `sequentialAgent: \`emit\` must be a stage NAME (string) — got ${typeof opts.emit}. Designation is composite-level; there is no boolean stage marker (see #255).`,
    );
  }
  const emitIndex = opts.emit !== undefined ? names.indexOf(opts.emit) : -1;
  if (opts.emit !== undefined && emitIndex < 0) {
    throw new Error(
      `sequentialAgent: \`emit\` designates stage '${opts.emit}' but no stage has that name — stages: ${names.join(", ")}`,
    );
  }

  // Emission slots: auto per stage unless the caller provided one.
  const emissionSlots = specs.map(
    (s, i) =>
      s.slot ?? slot<unknown>({ key: `agents.${names[i]}`, scope: "run", init: () => null }),
  );

  // Build-time write-before-read assert over DECLARED dependencies (a stage with
  // no declarations opts out — the implicit render never reads a missing slot).
  const written = new Set<string>(emissionSlots.map((s) => s.key));
  const declaredSoFar = new Set<string>();
  for (let i = 0; i < specs.length; i += 1) {
    for (const r of specs[i]?.reads ?? []) {
      if (!declaredSoFar.has(r.key) && !written.has(r.key)) {
        throw new Error(
          `sequentialAgent: stage '${names[i]}' reads '${r.key}' but no earlier stage declares writing it`,
        );
      }
    }
    declaredSoFar.add(emissionSlots[i]?.key ?? "");
    for (const w of specs[i]?.writes ?? []) declaredSoFar.add(w.key);
  }

  return {
    name: opts.name ?? "sequential-agents",
    async run(input: unknown, ctx: NodeRunContext): Promise<NodeResult<unknown>> {
      const scratchpad = ctx.scratchpad ?? createScratchpad();
      const render = opts.render ?? renderPriorEmission;
      const completed: CompletedStage[] = [];
      const outputs: Record<string, unknown> = {};
      let tokensIn = 0;
      let tokensOut = 0;

      // The designated stage's emission (#255), captured the moment it lands.
      let emitted: { readonly value: unknown } | null = null;

      // Resolve the composite's result for BOTH successful exit lanes (a stop
      // short-circuit, or the sequence completing). Untyped → the envelope,
      // byte-identical to today. Emit-designated → the designated emission —
      // or an HONEST failure when the sequence stopped before that emission
      // ever materialized (the typed composite has no contract to return).
      const finish = (stopped: SequentialAgentResult["stopped"]): NodeResult<unknown> => {
        if (emitIndex < 0) {
          return {
            output: { outputs, stopped } satisfies SequentialAgentResult,
            succeeded: true,
            totalInputTokens: tokensIn,
            totalOutputTokens: tokensOut,
          };
        }
        if (emitted !== null) {
          return {
            output: emitted.value,
            succeeded: true,
            totalInputTokens: tokensIn,
            totalOutputTokens: tokensOut,
          };
        }
        return {
          output: undefined as never,
          succeeded: false,
          error: new Error(
            stopped != null
              ? `sequentialAgent: stopped at stage '${stopped.stage}' (${stopped.reason}) before the designated emit stage '${opts.emit}' emitted — the typed composite has no output. Keep stop lanes downstream of the emit stage, or use the untyped form and branch on \`stopped\`.`
              : `sequentialAgent: the sequence completed without the designated emit stage '${opts.emit}' emitting`,
          ),
          totalInputTokens: tokensIn,
          totalOutputTokens: tokensOut,
        };
      };

      // Step-event emission (#226): SKIPPED entirely when ctx.eventBus is
      // absent — today's silent behavior, byte-identical. Event identity
      // prefers the ctx's ids, then the observed pad's run-wide emitter ids
      // (so step events correlate with the pad's state-delta events), then a
      // one-per-run mint so the start/end pairs still cohere.
      const bus = ctx.eventBus;
      const observed = scratchpad instanceof ObservedScratchpad ? scratchpad : undefined;
      const traceId = ctx.traceId ?? observed?.emitter.traceId ?? generateId();
      const runId = ctx.runId ?? observed?.emitter.runId ?? generateId();
      const publish = bus
        ? (event: AgentEvent): void => {
            try {
              void bus.publish(event).catch(() => {
                // Swallow — step events are best-effort observability.
              });
            } catch {
              // Swallow a synchronous throw too (same non-throw contract).
            }
          }
        : undefined;

      // The known built-in renders and what they inject (#226): the innate
      // prompt-read frames below report EXACTLY the emissions the render puts
      // in the stage's user message. A custom `opts.render` is opaque — its
      // injections are unknowable here, so it mints no innate reads.
      const injectedByRender = (): ReadonlyArray<{ key: string; output: unknown }> => {
        if (completed.length === 0) return [];
        if (render === renderSharedState) {
          return completed.map((c, j) => ({ key: emissionSlots[j]!.key, output: c.output }));
        }
        if (render === renderPriorEmission) {
          const j = completed.length - 1;
          return [{ key: emissionSlots[j]!.key, output: completed[j]!.output }];
        }
        return [];
      };

      for (let i = 0; i < specs.length; i += 1) {
        const spec = specs[i]!;
        const name = names[i]!;
        const emissionSlot = emissionSlots[i]!;

        // What this stage's leaf RECEIVES (#255): the pipeline input, or — on
        // an `input: 'prior'` node stage — the immediately-prior emission (the
        // build guards guarantee a prior stage exists, and reaching stage i
        // means every prior stage emitted). Step events below record it, so
        // the trace shows what the leaf actually ran with.
        const leafInput = spec.input === "prior" ? completed[i - 1]!.output : input;

        // Declared BEFORE the step so the prompt closure below (which runs
        // inside node.run, after step.start assigns it) sees the stage's span.
        let stepSpanId: string | undefined;

        // The stage's LEAF. A NODE stage is its own leaf — seated directly, no
        // AgentStep wrap (it has no prompt to render and no agent to run), with
        // `output` (when given) as an assert over its result. Everything
        // downstream of `step` (retry, the emission write, stop/onEmit, the step
        // events) is shared: a node stage is a stage like any other.
        const step: Node<unknown, unknown> = spec.node
          ? spec.output != null
            ? assertingNode(spec.node, spec.output as ZodType<unknown>, name)
            : spec.node
          : new AgentStep<unknown, unknown>({
              name,
              agent: spec.agent as AgentLike,
              ...(spec.output != null ? { output: spec.output as ZodType<unknown> } : {}),
              ...(spec.maxIterations != null ? { maxIterations: spec.maxIterations } : {}),
              prompt: (_input, state) => {
                if (spec.prompt != null) return spec.prompt(state, input);
                // INNATE prompt-read frames (#226): the implicit render injects
                // prior emissions into this stage's prompt — the framework's own
                // read, reported per injected slot with the exact injected text
                // (byte-capped). Published at render time, so a retried attempt's
                // re-render honestly re-reports. Nested under the stage's step
                // span when step events are on (falls back to the run's parent).
                if (observed) {
                  for (const inj of injectedByRender()) {
                    observed.emitter.publish(
                      createEvent("agent.scratchpad.read", {
                        traceId,
                        runId,
                        ...(stepSpanId !== undefined
                          ? { parentSpanId: stepSpanId }
                          : observed.emitter.parentSpanId !== undefined
                            ? { parentSpanId: observed.emitter.parentSpanId }
                            : {}),
                        origin: "innate",
                        ordinal: observed.emitter.nextOrdinal(),
                        key: inj.key,
                        preview: capPreview(renderEmissionBody(inj.output)),
                      }),
                    );
                  }
                }
                return render(input, completed);
              },
            });

        // Per-stage executor from the agent's OWN capabilities — a tool-using stage
        // can never hit the forgotten-executor failure inside a sequence. Tool-less
        // stages keep whatever executor the caller threaded (usually none).
        // A NODE stage derives NOTHING here: a node owns its own tool wiring
        // (CoordinatorStep builds its team executor; a nested AgentStep derives
        // from the agent it is about to run), so it inherits the ctx's executor
        // untouched — overriding it would hand a coordinator its parent's tools.
        const hasCapabilities =
          ((spec.agent as { role?: { capabilities?: ReadonlyArray<unknown> } } | undefined)?.role
            ?.capabilities?.length ?? 0) > 0;

        // One `agent.step.start`/`.end` pair per STAGE. The start's spanId is
        // the stage's span: the stage ctx nests under it (parentSpanId), so the
        // delegated agent's tool events attribute to their stage in every view.
        // `agentName` is the AGENT's role name — omitted for a node stage (there
        // is no single agent behind it; the stage name identifies it).
        const agentName = (spec.agent as { role?: { name?: string } } | undefined)?.role?.name;
        const stepStartedAt = Date.now();
        if (publish) {
          const startEvent = createEvent("agent.step.start", {
            traceId,
            runId,
            ...(ctx.parentSpanId ? { parentSpanId: ctx.parentSpanId } : {}),
            stepName: name,
            ...(agentName ? { agentName } : {}),
            arguments: { input: leafInput },
          });
          stepSpanId = startEvent.spanId;
          publish(startEvent);
        }

        const stageCtx: NodeRunContext = {
          ...ctx,
          scratchpad,
          ...(stepSpanId ? { parentSpanId: stepSpanId } : {}),
          ...(hasCapabilities ? { toolExecutor: createToolboxExecutor(spec.agent as never) } : {}),
        };

        // Pre-emission retry: wrap the stage's leaf in the existing `Retry` node
        // when opted in. `Retry` returns the first success immediately, so `stop`/
        // `onEmit` below still see exactly one emission; only a run that fails
        // BEFORE emitting is re-attempted on a fresh transcript. `retry === 0`
        // runs the leaf directly — byte-identical to today, no extra bus events.
        const attempts = spec.retry ?? 0;
        const node =
          attempts > 0 ? retry(step, { maxAttempts: attempts + 1, name: `${name}:retry` }) : step;

        // `stepResult`/`stepError` feed the `finally`-emitted `agent.step.end`,
        // which therefore covers EVERY exit: success, failure return, stop
        // short-circuit, onEmit throw, and an unexpected throw.
        let stepResult: unknown;
        let stepError: string | undefined;
        try {
          const res = await node.run(leafInput, stageCtx);
          tokensIn += res.totalInputTokens;
          tokensOut += res.totalOutputTokens;
          if (!res.succeeded) {
            const error =
              res.error ?? new Error(`sequentialAgent: stage '${name}' failed without an error`);
            stepError = error.message;
            return {
              output: undefined as never,
              succeeded: false,
              error,
              totalInputTokens: tokensIn,
              totalOutputTokens: tokensOut,
            };
          }
          stepResult = res.output;

          // The per-stage emission is the FRAMEWORK's write, not the agent's —
          // tag it innate on an observed pad (#226). Plain pads write as before.
          if (observed) {
            observed.withOrigin("innate", () => scratchpad.set(emissionSlot, res.output));
          } else {
            scratchpad.set(emissionSlot, res.output);
          }
          outputs[name] = res.output;
          completed.push({ name, output: res.output });
          if (i === emitIndex) emitted = { value: res.output };

          const stopReason = spec.stop?.(res.output, scratchpad.reader()) ?? null;
          if (stopReason != null) return finish({ stage: name, reason: stopReason });

          if (spec.onEmit != null) {
            try {
              const emitStop = await spec.onEmit(res.output, scratchpad, { ...ctx, scratchpad });
              if (typeof emitStop === "string") return finish({ stage: name, reason: emitStop });
            } catch (error) {
              stepError = error instanceof Error ? error.message : String(error);
              return {
                output: undefined as never,
                succeeded: false,
                error: error as Error,
                totalInputTokens: tokensIn,
                totalOutputTokens: tokensOut,
              };
            }
          }
        } catch (error) {
          // A nested/third-party node that throws (well-behaved leaves don't)
          // still gets its step.end stamped before the throw propagates.
          stepError = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          if (publish) {
            publish(
              createEvent("agent.step.end", {
                traceId,
                runId,
                ...(stepSpanId ? { spanId: stepSpanId } : {}),
                ...(ctx.parentSpanId ? { parentSpanId: ctx.parentSpanId } : {}),
                stepName: name,
                ...(agentName ? { agentName } : {}),
                arguments: { input: leafInput },
                result: stepResult,
                ...(stepError !== undefined ? { error: stepError } : {}),
                durationMs: Date.now() - stepStartedAt,
              }),
            );
          }
        }
      }

      return finish(null);
    },
  };
}
