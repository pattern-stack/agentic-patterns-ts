/**
 * `parallelAgent()` — ONE node composed of FIXED agent/node branches fanned out
 * over a shared input (#255 follow-up; the fixed-branch sibling of
 * `sequentialAgent`, built over the existing {@link Parallel} node).
 *
 * WHICH FAN-OUT
 *  - `parallelAgent` — a FIXED, NAMED set of branches declared at build time
 *    (parallel lookups, section drafts, judge panels). `sequentialAgent`'s
 *    stage vocabulary applies per branch.
 *  - `FanOut` — DYNAMIC N over a runtime list (a cohort of deals, one reader
 *    per search hit): the branch count is data, not declaration. Stays the
 *    tool for cohort fan-out.
 *
 * SEMANTICS
 *  - Every branch receives the COMPOSITE's input. There is no 'prior' in a
 *    fan-out, so `input` is rejected at build time; an agent branch's default
 *    prompt is the task itself (override per branch with `prompt`).
 *  - JOIN — deterministic INDEX ORDER (matching `Parallel`/`FanOut`): the
 *    emission is `{ branches, failed, stopped }` where `branches` is keyed by
 *    branch name in DECLARATION order, `failed` lists failed branch names in
 *    the same order, and each branch's forked pad merges back in index order.
 *  - LEAF-NEVER-THROWS, lifted into the join: a failed branch (agent error,
 *    node failure, `output` assert miss, an `onEmit` throw) becomes
 *    `{ succeeded: false, error }` IN ITS OUTCOME — the composite still
 *    succeeds and siblings are untouched. A caller that needs hard failure
 *    checks `failed.length`, or seats this node in a `sequentialAgent` stage
 *    whose `stop`/`output` enforces it.
 *  - STOP POLICY — COMPLETE-ALL (the explicit #255 design decision): a
 *    branch's `stop` (or `onEmit` returning a reason) does NOT cancel
 *    siblings. Cancel-remaining would be dishonest today: an in-flight LLM
 *    call cannot be aborted through `NodeRunContext` (no abort plumbing), so
 *    "cancel" could only skip branches that happened not to have started — a
 *    join whose SHAPE depends on scheduling luck. Instead ALL branches settle,
 *    every emission lands, and `stopped` carries the FIRST stop signal in
 *    INDEX order (not completion order — deterministic). In a fan-out a stop
 *    is a SIGNAL, not a short-circuit — there is no "later stage" inside the
 *    composite to prune; the ENCLOSING composite decides (a `sequentialAgent`
 *    stage seating this node can translate it:
 *    `stop: (out) => out.stopped?.reason ?? null`). Cancel-remaining is a
 *    declared follow-up gated on runner abort support.
 *  - Scratchpad: each branch runs on a FORK (`Parallel`'s contract).
 *    Branch-scoped slots merge back through their `merge` reducer in index
 *    order; run-scoped writes hit the shared store directly — give concurrent
 *    branches DISTINCT keys. The build-time guards enforce this where it is
 *    declarable: duplicate emission-slot keys throw, and a branch that
 *    `reads` a key a SIBLING writes throws (a cross-branch read is a race —
 *    there is no write-before-read order to assert).
 *
 * The built object implements {@link Node}, so it nests anywhere a node is
 * accepted — most usefully as a `sequentialAgent` stage between a spine and a
 * deterministic tail.
 */

import type { ZodType } from "zod";
import type { AgentLike } from "../runner/agent-runner.js";
import { createToolboxExecutor } from "../runner/toolbox-executor.js";
import { AgentStep } from "./agent-step.js";
import type { Node, NodeResult, NodeRunContext } from "./node.js";
import { Parallel, type ParallelBranch } from "./parallel.js";
import { retry } from "./retry.js";
import { assertingNode } from "./sequential-agents.js";
import { isAgentLikeShape, isNodeShape } from "./shapes.js";
import type { ScratchpadAccess, ScratchpadReader, Slot } from "./slot.js";
import { createScratchpad, slot } from "./slot.js";

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

/**
 * One fanned-out branch — an AGENT (`agent`) or a NODE (`node`). EXACTLY ONE
 * of the two is required; both, or neither, is a build-time error. A bare
 * `AgentLike` or bare `Node` is accepted wherever a spec is (all defaults).
 *
 * The knobs are `sequentialAgent`'s stage vocabulary, minus the ones with no
 * parallel analogue: `input` ('prior' needs a prior — rejected) and `emit`
 * (the composite's emission is the joined record — rejected).
 */
export interface ParallelAgentBranchSpec<TOut = unknown> {
  /** The agent seated in this branch (wrapped in an `AgentStep`). Mutually exclusive with `node`. */
  readonly agent?: AgentLike;
  /**
   * A NODE seated as this branch's leaf directly — same seating rules as a
   * `sequentialAgent` node stage: no `AgentStep` wrap, `prompt`/`maxIterations`
   * rejected, `output` is an ASSERT (below). Mutually exclusive with `agent`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: a branch node's TIn is the composite input (unknown at the seam) and Node is contravariant in it — the same deliberate variance escape as sequentialAgent's AgentStageSpec.node.
  readonly node?: Node<any, unknown>;
  /**
   * Branch name = the join's record key + the emission's default slot key +
   * the progress label. Default: the agent's role name (agent branches) / the
   * node's `name` (node branches). Duplicates are a build-time error.
   */
  readonly name?: string;
  /**
   * AGENT branch: the structured emission schema → `runStructured` (omit for
   * the raw-text path).
   *
   * NODE branch: an ASSERT, not a driver — identical semantics to a
   * `sequentialAgent` node stage: the node's output is validated, the OUTCOME
   * carries the node's own output VERBATIM (never the zod-parsed value), and
   * a mismatch fails THE BRANCH before it emits (inside `retry`'s scope); the
   * composite still succeeds (leaf-never-throws — see the module doc).
   */
  readonly output?: ZodType<TOut>;
  /**
   * Override this branch's user message. Default: the composite's input
   * rendered as the task (a string verbatim; anything else JSON). `state` is
   * a read-only view of the branch's FORKED pad.
   *
   * AGENT branches only — rejected at build time on a `node` branch (a node
   * renders no user message; it reads the pad).
   */
  readonly prompt?: (state: ScratchpadReader, input: unknown) => string;
  /** Where the emission lands, on the branch's fork. Default: an auto slot keyed `agents.<name>`. Duplicate KEYS across branches are a build-time error (concurrent same-key writes race). */
  // biome-ignore lint/suspicious/noExplicitAny: Slot<T> is invariant (its `merge` param); the emission write is dynamically typed by design — the sequentialAgent precedent.
  readonly slot?: Slot<any>;
  /**
   * The branch's fused deterministic follow-through, on the branch's FORKED
   * pad (branch-scoped writes merge back in index order). Contract: RETURN A
   * STRING to raise the composite's stop SIGNAL with that reason (complete-all
   * policy — see the module doc; siblings still settle); any other return
   * value is ignored. A THROW fails the branch (its outcome carries the
   * error), not the composite.
   *
   * NOTE: the emission slot is written BEFORE `onEmit` runs, and the branch's
   * fork merges back regardless of outcome — so a failed-via-`onEmit` branch
   * still populates its slot on the merged pad. The JOIN outcome, not the
   * slot, is the source of truth for a branch's success.
   */
  readonly onEmit?: (output: TOut, pad: ScratchpadAccess, ctx: NodeRunContext) => unknown;
  /**
   * Emission-level stop SIGNAL: a string is recorded as the composite's
   * `stopped` (first signal in INDEX order wins). Complete-all policy —
   * siblings are NOT cancelled; see the module doc for why.
   */
  readonly stop?: (output: TOut, state: ScratchpadReader) => string | null;
  /**
   * Tool/2-tier loop cap for this branch (AgentStep semantics).
   *
   * AGENT branches only — rejected at build time on a `node` branch (a node
   * runs no agent loop of its own; cap it inside the node).
   */
  readonly maxIterations?: number;
  /**
   * Re-run this branch's leaf as a FRESH attempt up to N times when it fails
   * BEFORE an emission materializes — identical scope and cost semantics to
   * `sequentialAgent`'s stage `retry` (reuses the {@link retry} node).
   * Default `0`. Exhausted retries fail THE BRANCH (its outcome carries the
   * leaf's original failure), never the composite.
   */
  readonly retry?: number;
  /**
   * Optional slot-dependency declarations. In a fan-out the assert is the
   * RACE guard: a branch that reads a key any SIBLING writes (its emission
   * slot or declared `writes`) is a build-time error — branches run
   * concurrently, so there is no write-before-read order to rely on. Reads of
   * keys established BEFORE the fan-out are fine.
   */
  readonly reads?: ReadonlyArray<{ readonly key: string }>;
  /** Extra slots this branch's tail writes (the emission slot is declared automatically). */
  readonly writes?: ReadonlyArray<{ readonly key: string }>;
}

/**
 * What the branches array accepts: a bare `AgentLike`, a bare `Node`, or a
 * {@link ParallelAgentBranchSpec}. Bare-value discrimination is by DUCK TYPE,
 * agent-shape FIRST — identical to `sequentialAgent`'s stages array.
 */
// biome-ignore lint/suspicious/noExplicitAny: TOut appears contravariantly in the branch callbacks and TIn contravariantly in a branch Node — the same deliberate variance escape as sequentialAgent's AgentStage.
export type ParallelAgentBranch = AgentLike | Node<any, unknown> | ParallelAgentBranchSpec<any>;

export interface ParallelAgentOpts {
  readonly name?: string;
  /** Bound branch concurrency (passed through to {@link Parallel}). Unbounded when unset. */
  readonly maxConcurrency?: number;
}

/**
 * One branch's outcome in the join — the leaf-never-throws channel:
 * `succeeded: false` carries the branch's error INSTEAD of failing the
 * composite.
 */
export type ParallelAgentBranchOutcome<T = unknown> =
  | { readonly succeeded: true; readonly output: T }
  | { readonly succeeded: false; readonly output: undefined; readonly error: Error };

/**
 * The joined emission — `outputs`-shaped by construction (the design note on
 * #255): every branch keyed by name in DECLARATION order.
 *
 * `TBranches` is the caller-declared per-branch output record
 * (`parallelAgent<{ overview: string; pricing: Pricing }>([...])`) — explicit
 * composite-level typing, the same convention as `sequentialAgent<TOut>`. Its
 * keys should match the branch names; the names are the runtime truth.
 */
export interface ParallelAgentResult<
  TBranches extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Every branch's outcome, keyed by branch name in declaration order. */
  readonly branches: { readonly [K in keyof TBranches]: ParallelAgentBranchOutcome<TBranches[K]> };
  /** Names of FAILED branches, in declaration order. Empty when all succeeded. */
  readonly failed: ReadonlyArray<string>;
  /**
   * The FIRST stop signal in INDEX order, when any branch's `stop`/`onEmit`
   * raised one (complete-all policy: siblings settled anyway; later-index
   * signals are superseded, deterministically).
   */
  readonly stopped: { readonly branch: string; readonly reason: string } | null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** What each adapter branch resolves to — ALWAYS a success from `Parallel`'s
 *  perspective, so one bad branch can never fail the pool (the outcome carries
 *  the failure instead). */
interface BranchSettle {
  readonly outcome: ParallelAgentBranchOutcome;
  readonly stopReason: string | null;
}

/** The default agent-branch prompt: the composite's input as the task — the
 *  same text `sequentialAgent`'s implicit render yields with nothing prior. */
function renderTask(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input, null, 1);
}

/** Normalize a branches entry to a spec — duck-typed like `sequentialAgent`'s
 *  stages (agent-shape FIRST), with branch-flavored messages. */
function toBranchSpec(branch: ParallelAgentBranch, index: number): ParallelAgentBranchSpec {
  if (isAgentLikeShape(branch)) return { agent: branch };
  if (isNodeShape(branch)) return { node: branch };
  if (branch && typeof branch === "object") return branch as ParallelAgentBranchSpec;
  throw new Error(
    `parallelAgent: branch ${index + 1} is not a branch — pass an AgentLike, a Node, or { agent } / { node }`,
  );
}

function branchName(spec: ParallelAgentBranchSpec, index: number): string {
  return (
    spec.name ??
    (spec.agent as { role?: { name?: string } } | undefined)?.role?.name ??
    spec.node?.name ??
    `branch-${index + 1}`
  );
}

// ---------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------

/**
 * Fan `branches` out over the composite's input and JOIN deterministically.
 * See the module doc for semantics (index-order join, leaf-never-throws
 * outcomes, the complete-all stop policy).
 */
export function parallelAgent<TBranches extends Record<string, unknown> = Record<string, unknown>>(
  branches: ReadonlyArray<ParallelAgentBranch>,
  opts: ParallelAgentOpts = {},
): Node<unknown, ParallelAgentResult<TBranches>> {
  if (branches.length === 0) throw new Error("parallelAgent: at least one branch is required");
  const specs = branches.map((b, i) => toBranchSpec(b, i));

  // Build-time assert: EXACTLY ONE leaf per branch (sequentialAgent's rule).
  specs.forEach((s, i) => {
    if (s.agent !== undefined && s.node !== undefined) {
      throw new Error(
        `parallelAgent: branch ${i + 1} sets BOTH \`agent\` and \`node\` — exactly one is required`,
      );
    }
    if (s.agent === undefined && s.node === undefined) {
      throw new Error(
        `parallelAgent: branch ${i + 1} sets NEITHER \`agent\` nor \`node\` — exactly one is required (pass an AgentLike, a Node, or { agent } / { node })`,
      );
    }
  });

  const names = specs.map((s, i) => branchName(s, i));
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe != null) {
    throw new Error(
      `parallelAgent: duplicate branch name '${dupe}' — set an explicit \`name\` per branch (names key the join)`,
    );
  }

  // Build-time assert: `retry` is a non-negative integer.
  specs.forEach((s, i) => {
    if (s.retry !== undefined && (!Number.isInteger(s.retry) || s.retry < 0)) {
      throw new Error(
        `parallelAgent: branch '${names[i]}' has invalid retry ${s.retry} — must be a non-negative integer`,
      );
    }
  });

  // Build-time assert: the AgentStep-only knobs are rejected on a node branch
  // (sequentialAgent's rule, same reasoning).
  specs.forEach((s, i) => {
    if (s.node === undefined) return;
    for (const knob of ["prompt", "maxIterations"] as const) {
      if (s[knob] !== undefined) {
        throw new Error(
          `parallelAgent: branch '${names[i]}' sets \`${knob}\` on a \`node\` branch — \`${knob}\` is an AgentStep-only knob (a node renders no prompt and runs no agent loop). A node reads the pad; cap iterations inside the node.`,
        );
      }
    }
  });

  // Build-time assert: the sequentialAgent knobs with NO parallel analogue are
  // rejected rather than silently ignored (the #245 ethos).
  specs.forEach((s, i) => {
    if ("input" in s) {
      throw new Error(
        `parallelAgent: branch '${names[i]}' sets \`input\` — a fan-out has no 'prior': every branch receives the composite's input`,
      );
    }
    if ("emit" in s) {
      throw new Error(
        `parallelAgent: branch '${names[i]}' sets \`emit\` — the composite's emission is the joined record; there is no designated branch`,
      );
    }
  });
  if ("emit" in opts) {
    throw new Error(
      "parallelAgent: `emit` is not an option — the composite's emission is the joined record; there is no designated branch",
    );
  }

  // Emission slots: auto per branch unless the caller provided one. Duplicate
  // KEYS are a build-time error — branches write concurrently, and run-scoped
  // slots share one store, so a same-key pair is a race by construction.
  const emissionSlots = specs.map(
    (s, i) =>
      s.slot ?? slot<unknown>({ key: `agents.${names[i]}`, scope: "run", init: () => null }),
  );
  const slotDupe = emissionSlots.find(
    (s, i) => emissionSlots.findIndex((t) => t.key === s.key) !== i,
  );
  if (slotDupe != null) {
    throw new Error(
      `parallelAgent: duplicate emission slot key '${slotDupe.key}' — concurrent branches must write DISTINCT keys (a same-key pair is a race)`,
    );
  }

  // Build-time RACE guard over declared dependencies: a branch may not read a
  // key any SIBLING writes — there is no write-before-read order in a fan-out.
  specs.forEach((s, i) => {
    for (const r of s.reads ?? []) {
      for (let j = 0; j < specs.length; j += 1) {
        if (j === i) continue;
        const sibWrites = [emissionSlots[j]!.key, ...(specs[j]?.writes ?? []).map((w) => w.key)];
        if (sibWrites.includes(r.key)) {
          throw new Error(
            `parallelAgent: branch '${names[i]}' reads '${r.key}' which sibling branch '${names[j]}' writes — a cross-branch read is a RACE (branches run concurrently). Establish the slot BEFORE the fan-out, or join it AFTER.`,
          );
        }
      }
    }
  });

  // Seat each branch as an ADAPTER node over the leaf: the adapter ALWAYS
  // succeeds (Parallel's failure lane never fires), carrying the real outcome
  // — emission write, stop/onEmit follow-through, or the leaf's failure.
  const seated: Array<ParallelBranch<unknown, BranchSettle>> = specs.map((spec, i) => {
    const name = names[i]!;
    const emissionSlot = emissionSlots[i]!;

    const leaf: Node<unknown, unknown> = spec.node
      ? spec.output != null
        ? assertingNode(spec.node, spec.output as ZodType<unknown>, name, "parallelAgent: branch")
        : spec.node
      : new AgentStep<unknown, unknown>({
          name,
          agent: spec.agent as AgentLike,
          ...(spec.output != null ? { output: spec.output as ZodType<unknown> } : {}),
          ...(spec.maxIterations != null ? { maxIterations: spec.maxIterations } : {}),
          prompt: (input, state) =>
            spec.prompt != null ? spec.prompt(state, input) : renderTask(input),
        });

    const attempts = spec.retry ?? 0;
    const node =
      attempts > 0 ? retry(leaf, { maxAttempts: attempts + 1, name: `${name}:retry` }) : leaf;

    // Per-branch executor from the agent's OWN capabilities — same rule as a
    // sequentialAgent stage; node branches inherit the ctx's executor untouched.
    const hasCapabilities =
      ((spec.agent as { role?: { capabilities?: ReadonlyArray<unknown> } } | undefined)?.role
        ?.capabilities?.length ?? 0) > 0;

    return {
      name,
      node: {
        name,
        async run(input: unknown, ctx: NodeRunContext): Promise<NodeResult<BranchSettle>> {
          // ctx.scratchpad IS this branch's fork (Parallel's contract); the
          // ephemeral fallback only fires when the adapter is run bare.
          const pad = ctx.scratchpad ?? createScratchpad();
          const branchCtx: NodeRunContext = {
            ...ctx,
            scratchpad: pad,
            ...(hasCapabilities
              ? { toolExecutor: createToolboxExecutor(spec.agent as never) }
              : {}),
          };

          const fail = (
            error: Error,
            tokens: { in: number; out: number },
          ): NodeResult<BranchSettle> => ({
            output: {
              outcome: { succeeded: false, output: undefined, error },
              stopReason: null,
            },
            succeeded: true, // leaf-never-throws, lifted: the OUTCOME carries the failure
            totalInputTokens: tokens.in,
            totalOutputTokens: tokens.out,
          });

          try {
            const res = await node.run(input, branchCtx);
            if (!res.succeeded) {
              return fail(
                res.error ?? new Error(`parallelAgent: branch '${name}' failed without an error`),
                { in: res.totalInputTokens, out: res.totalOutputTokens },
              );
            }

            pad.set(emissionSlot, res.output);

            // Same per-stage order as sequentialAgent: a `stop` signal
            // short-circuits the branch's OWN follow-through (`onEmit` runs
            // only when not stopped) — the complete-all policy is about
            // SIBLINGS, not about this branch's tail.
            let stopReason: string | null = spec.stop?.(res.output, pad.reader()) ?? null;
            if (stopReason == null && spec.onEmit != null) {
              try {
                const emitStop = await spec.onEmit(res.output, pad, branchCtx);
                if (typeof emitStop === "string") stopReason = emitStop;
              } catch (error) {
                return fail(error as Error, {
                  in: res.totalInputTokens,
                  out: res.totalOutputTokens,
                });
              }
            }

            return {
              output: {
                outcome: { succeeded: true, output: res.output },
                stopReason,
              },
              succeeded: true,
              totalInputTokens: res.totalInputTokens,
              totalOutputTokens: res.totalOutputTokens,
            };
          } catch (error) {
            // A well-behaved leaf never throws; convert anyway (same shield
            // Parallel carries) so a third-party node can't break the join.
            return fail(error instanceof Error ? error : new Error(String(error)), {
              in: 0,
              out: 0,
            });
          }
        },
      },
    };
  });

  const fanOut = new Parallel<unknown, BranchSettle, ParallelAgentResult<TBranches>>(seated, {
    name: opts.name ?? "parallel-agents",
    ...(opts.maxConcurrency != null ? { maxConcurrency: opts.maxConcurrency } : {}),
    consolidate: (settles) => {
      const record: Record<string, ParallelAgentBranchOutcome> = {};
      const failed: string[] = [];
      let stopped: ParallelAgentResult["stopped"] = null;
      for (let i = 0; i < names.length; i += 1) {
        const name = names[i]!;
        // Defensive: an adapter never fails, but a hole in the settle array
        // (a framework bug) must not silently vanish from the join.
        const settle = settles[i] ?? {
          outcome: {
            succeeded: false,
            output: undefined,
            error: new Error(`parallelAgent: branch '${name}' never settled`),
          },
          stopReason: null,
        };
        record[name] = settle.outcome;
        if (!settle.outcome.succeeded) failed.push(name);
        if (stopped === null && settle.stopReason != null) {
          stopped = { branch: name, reason: settle.stopReason };
        }
      }
      return {
        branches: record as ParallelAgentResult<TBranches>["branches"],
        failed,
        stopped,
      };
    },
  });

  return {
    name: opts.name ?? "parallel-agents",
    async run(
      input: unknown,
      ctx: NodeRunContext,
    ): Promise<NodeResult<ParallelAgentResult<TBranches>>> {
      const res = await fanOut.run(input, ctx);
      // The adapters always succeed, so Parallel's own failure lane is
      // structurally unreachable — surface the join either way.
      return {
        output: res.output,
        succeeded: true,
        totalInputTokens: res.totalInputTokens,
        totalOutputTokens: res.totalOutputTokens,
      };
    },
  };
}
