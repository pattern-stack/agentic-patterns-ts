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

/** One seated stage. A bare `AgentLike` is accepted wherever a spec is (all defaults). */
export interface AgentStageSpec<TOut = unknown> {
  readonly agent: AgentLike;
  /** Stage name = the emission's slot key + the progress label. Default: the agent's role name. */
  readonly name?: string;
  /** Structured emission schema → `runStructured`. Omit for the raw-text path. */
  readonly output?: ZodType<TOut>;
  /**
   * Override the implicit state render for THIS stage's user message. Default:
   * the pipeline input + every prior stage's emission (see `renderSharedState`).
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
  /** Tool/2-tier loop cap for this stage (AgentStep semantics). */
  readonly maxIterations?: number;
  /**
   * Re-run this stage's agent (a FRESH attempt — the poisoned transcript is
   * discarded, the prompt render is unchanged) up to N times when the run fails
   * BEFORE an emission materializes (agent-run error / no structured output —
   * e.g. a tool loop that burns `maxIterations` and never emits). Default `0`
   * (today's behavior: one attempt, and a pre-emission failure aborts the
   * sequence).
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

// biome-ignore lint/suspicious/noExplicitAny: TOut appears contravariantly in the stage callbacks (onEmit/stop), so AgentStageSpec<T> would never assign to AgentStageSpec<unknown> — `any` is the deliberate variance escape so typed specs seat WITHOUT casts (the SequentialBuilder precedent).
export type AgentStage = AgentLike | AgentStageSpec<any>;

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

function isSpec(stage: AgentStage): stage is AgentStageSpec {
  return (stage as AgentStageSpec).agent !== undefined;
}

function stageName(stage: AgentStageSpec, index: number): string {
  return (
    stage.name ?? (stage.agent as { role?: { name?: string } }).role?.name ?? `stage-${index + 1}`
  );
}

// ---------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------

/**
 * Seat `stages` in order over one shared Scratchpad and return the pipeline as
 * a {@link Node}. See the module doc for semantics.
 */
export function sequentialAgent(
  stages: ReadonlyArray<AgentStage>,
  opts: SequentialAgentOpts = {},
): Node<unknown, SequentialAgentResult> {
  if (stages.length === 0) throw new Error("sequentialAgent: at least one stage is required");
  const specs = stages.map((s) => (isSpec(s) ? s : { agent: s }));
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
    async run(input: unknown, ctx: NodeRunContext): Promise<NodeResult<SequentialAgentResult>> {
      const scratchpad = ctx.scratchpad ?? createScratchpad();
      const render = opts.render ?? renderPriorEmission;
      const completed: CompletedStage[] = [];
      const outputs: Record<string, unknown> = {};
      let tokensIn = 0;
      let tokensOut = 0;

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

        // Declared BEFORE the step so the prompt closure below (which runs
        // inside node.run, after step.start assigns it) sees the stage's span.
        let stepSpanId: string | undefined;

        const step = new AgentStep<unknown, unknown>({
          name,
          agent: spec.agent,
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
        const hasCapabilities =
          ((spec.agent as { role?: { capabilities?: ReadonlyArray<unknown> } }).role?.capabilities
            ?.length ?? 0) > 0;

        // One `agent.step.start`/`.end` pair per STAGE. The start's spanId is
        // the stage's span: the stage ctx nests under it (parentSpanId), so the
        // delegated agent's tool events attribute to their stage in every view.
        const agentName = (spec.agent as { role?: { name?: string } }).role?.name;
        const stepStartedAt = Date.now();
        if (publish) {
          const startEvent = createEvent("agent.step.start", {
            traceId,
            runId,
            ...(ctx.parentSpanId ? { parentSpanId: ctx.parentSpanId } : {}),
            stepName: name,
            ...(agentName ? { agentName } : {}),
            arguments: { input },
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
          const res = await node.run(input, stageCtx);
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

          const done = (
            stopped: SequentialAgentResult["stopped"],
          ): NodeResult<SequentialAgentResult> => ({
            output: { outputs, stopped },
            succeeded: true,
            totalInputTokens: tokensIn,
            totalOutputTokens: tokensOut,
          });

          const stopReason = spec.stop?.(res.output, scratchpad.reader()) ?? null;
          if (stopReason != null) return done({ stage: name, reason: stopReason });

          if (spec.onEmit != null) {
            try {
              const emitStop = await spec.onEmit(res.output, scratchpad, { ...ctx, scratchpad });
              if (typeof emitStop === "string") return done({ stage: name, reason: emitStop });
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
                arguments: { input },
                result: stepResult,
                ...(stepError !== undefined ? { error: stepError } : {}),
                durationMs: Date.now() - stepStartedAt,
              }),
            );
          }
        }
      }

      return {
        output: { outputs, stopped: null },
        succeeded: true,
        totalInputTokens: tokensIn,
        totalOutputTokens: tokensOut,
      };
    },
  };
}
