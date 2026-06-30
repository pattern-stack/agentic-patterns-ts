/**
 * Workflow base — the infrastructure shared by the typed `Node` substrate
 * (`node.ts`) and the composites (`sequential.ts`, `parallel.ts`, …).
 *
 * The legacy string-threading core (`Step`, `StepResult`, `PatternResult`,
 * `MessageTemplate`, `executeStep`, `createStepResult`, `resolveMessage`,
 * `contextExtractor`) has been REMOVED — threading now flows through typed
 * `Node<TIn, TOut>` return values (DESIGN §2-§6). What remains here is the
 * lifecycle infrastructure the composites still emit/consume:
 *
 *  - {@link PatternContext} — the (now Slot-backed) string-config shared-state carrier
 *  - {@link PatternEvent} union + {@link PatternHooks} — pattern lifecycle observability
 *  - {@link PatternRunOptions} — a structural subset of {@link NodeRunContext}
 *  - {@link PatternProtocol} — the declarative-config entry point, `Node<PatternContext, string>`
 *  - {@link applyStepModel} / {@link makeStepName} — per-step helpers reused by composites
 */

import type { AgentLike } from "../runner/agent-runner.js";
import type { RunnerProtocol, ToolExecutor } from "../runner/types.js";
import type { Node, NodeOutcome, NodeResult } from "./node.js";

// Re-export AgentLike so workflow consumers don't need to import from runner.
export type { AgentLike } from "../runner/agent-runner.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Shared context bag for the declarative string-config path. No longer the
 * threading carrier (typed I/O does that now) — it is the `TIn`/shared-state
 * type used by {@link PatternProtocol} and `buildWorkflowFromConfig`.
 */
export type PatternContext = Record<string, unknown>;

// ---------------------------------------------------------------------------
// PatternEvent — discriminated union of 7 event types
// ---------------------------------------------------------------------------

export interface PatternStartEvent {
  readonly type: "pattern.start";
  readonly patternName: string;
  readonly timestamp: Date;
}

export interface PatternStepStartEvent {
  readonly type: "pattern.step.start";
  readonly stepName: string;
  readonly stepIndex: number;
  readonly timestamp: Date;
}

export interface PatternStepCompleteEvent {
  readonly type: "pattern.step.complete";
  readonly stepName: string;
  readonly stepIndex: number;
  /** Generalized from the legacy `StepResult` to the typed per-child record. */
  readonly result: NodeOutcome<unknown>;
  readonly timestamp: Date;
}

export interface PatternStepErrorEvent {
  readonly type: "pattern.step.error";
  readonly stepName: string;
  readonly stepIndex: number;
  readonly error: Error;
  readonly timestamp: Date;
}

export interface PatternIterationStartEvent {
  readonly type: "pattern.iteration.start";
  readonly iteration: number;
  readonly timestamp: Date;
}

export interface PatternIterationCompleteEvent {
  readonly type: "pattern.iteration.complete";
  readonly iteration: number;
  readonly timestamp: Date;
}

export interface PatternCompleteEvent {
  readonly type: "pattern.complete";
  readonly patternName: string;
  /** Generalized from the legacy `PatternResult` to the typed aggregate result. */
  readonly result: NodeResult<unknown>;
  readonly timestamp: Date;
}

export type PatternEvent =
  | PatternStartEvent
  | PatternStepStartEvent
  | PatternStepCompleteEvent
  | PatternStepErrorEvent
  | PatternIterationStartEvent
  | PatternIterationCompleteEvent
  | PatternCompleteEvent;

// ---------------------------------------------------------------------------
// PatternHooks
// ---------------------------------------------------------------------------

/**
 * Callbacks for pattern lifecycle events. Workflow-level orchestration hooks
 * (NOT the runner-level hooks). Every composite emits these where the legacy
 * classes did.
 */
export interface PatternHooks {
  onPatternStart?: (event: PatternStartEvent) => void | Promise<void>;
  onStepStart?: (event: PatternStepStartEvent) => void | Promise<void>;
  onStepComplete?: (event: PatternStepCompleteEvent) => void | Promise<void>;
  onStepError?: (event: PatternStepErrorEvent) => void | Promise<void>;
  onIterationStart?: (event: PatternIterationStartEvent) => void | Promise<void>;
  onIterationComplete?: (event: PatternIterationCompleteEvent) => void | Promise<void>;
  onPatternComplete?: (event: PatternCompleteEvent) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// PatternRunOptions
// ---------------------------------------------------------------------------

/**
 * Options for the declarative-config `run()`. A structural subset of
 * {@link NodeRunContext} (its `scratchpad` field is optional/engine-defaulted), so
 * any `PatternRunOptions` value is a valid `NodeRunContext`.
 */
export interface PatternRunOptions {
  readonly runner: RunnerProtocol;
  readonly hooks?: PatternHooks;
  readonly toolExecutor?: ToolExecutor;
  readonly traceId?: string;
}

// ---------------------------------------------------------------------------
// PatternProtocol
// ---------------------------------------------------------------------------

/**
 * The declarative-config entry point's contract — a string-pinned `Node`
 * (DESIGN §4). `PatternContext` stays as the shared-state carrier; `TOut` is
 * pinned to `string` because the serialized config schema cannot carry type
 * parameters.
 */
export type PatternProtocol = Node<PatternContext, string>;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Generate a step name, falling back to `step_<index>` if none provided.
 */
export function makeStepName(name: string | undefined, index: number): string {
  if (name !== undefined && name !== "") {
    return name;
  }
  return `step_${index}`;
}

/**
 * Apply a per-step model override. Returns an `AgentLike` whose `getModel()`
 * yields `model`, delegating every other member to `agent`; without an override
 * returns `agent` unchanged.
 *
 * The model still belongs to the agent — this is a per-step agent *view* with a
 * different declared model, NOT a per-step runner. It only takes effect with a
 * resolver-backed runner; a constant/pinned runner ignores `getModel()`.
 */
export function applyStepModel(agent: AgentLike, model: string | undefined): AgentLike {
  if (!model) return agent;
  return {
    role: agent.role,
    getModel: () => model,
    getTools: () => agent.getTools(),
    getSystemPrompt: () => agent.getSystemPrompt(),
    renderInitialPrompt: () => agent.renderInitialPrompt(),
  };
}
