/**
 * runFromTrigger — the framework-tier trigger contract's execution seam
 * (#437 M2): named agent + input + trigger source → run.
 *
 * This is the function M3's AgencyHost formalizes into a method (a host holds
 * the registry/runner/bus and exposes `runFromTrigger(request)`); until then
 * it is the contract itself, callable from any daemon/jobs tier.
 *
 * Guarantees (each one a bug class this seam exists to prevent):
 *  - the trigger is schema-validated at entry (`TriggerSourceSchema.parse`) —
 *    daemon callers hand over wire-shaped data; garbage fails loud here, not
 *    three layers down;
 *  - resolution goes through `AgentRegistry.resolve` — the ADR-0004
 *    instantiate + scope.parse path, never a pinned declared instance
 *    (#268's bug class);
 *  - the run is pre-correlatable: the returned `runId` is chosen BEFORE
 *    execution (caller-supplied or minted here) and passed down via
 *    `RunOptions.runId` (AP-29 F1);
 *  - provenance rides `RunOptions.trigger` → `MessageStartEvent.trigger` →
 *    `RunMeta.metadata.trigger`, so the run row alone answers "why did this
 *    run happen";
 *  - scope reaches tools and renders the same way the server/CLI paths do
 *    (`buildScopeHost` → `RunOptions.host.scope`).
 *
 * Deliberately NOT here (M3): conversation continuity across triggers
 * (needs scope persistence + rehydration), queue/reject policy for busy
 * conversations, and any transport — a trigger fires with no HTTP request.
 */

import { TriggerSourceSchema } from "@pattern-stack/agentic-core";
import type { TriggerSourceData } from "@pattern-stack/agentic-core";

import type { AgentEventBus } from "../events/agent-event-bus.js";
import { deriveToolboxExecutor } from "../runner/toolbox-executor.js";
import type { RunResult, RunnerProtocol, ToolExecutor } from "../runner/types.js";
import { buildScopeHost } from "../workflows/scope-host.js";
import type { AgentRegistry } from "./registry.js";

/** One trigger firing: which agent, with what input, caused by what. */
export interface TriggerRunRequest {
  /** The registration id (`AgentRef.id`) of the agent to run. */
  agentId: string;
  /** The run's user message. */
  input: string;
  /** What fired — validated against `TriggerSourceSchema` at entry. */
  trigger: TriggerSourceData;
  /** Raw per-run scope; `registry.resolve` parses it against the declared schema. */
  scope?: Record<string, unknown>;
  /** Pre-correlation id (a job run id…). Minted here when absent — never by the runner. */
  runId?: string;
  maxIterations?: number;
  signal?: AbortSignal;
}

/** The capabilities a host wires once and reuses across firings. */
export interface TriggerRunDeps {
  registry: AgentRegistry;
  runner: RunnerProtocol;
  eventBus?: AgentEventBus;
  /**
   * Override the tool executor. Absent → derived from the resolved agent's
   * own capabilities (`deriveToolboxExecutor`; a capability-less agent runs
   * tool-less, byte-identical to the server path).
   */
  toolExecutor?: ToolExecutor;
}

export interface TriggerRunHandle {
  /** Known before execution — correlate it with the caller's own audit rows. */
  runId: string;
  agentId: string;
  result: RunResult;
}

export async function runFromTrigger(
  deps: TriggerRunDeps,
  request: TriggerRunRequest,
): Promise<TriggerRunHandle> {
  // Fail loud at the seam: daemon callers hand over wire-shaped data.
  const trigger = TriggerSourceSchema.parse(request.trigger);

  const agent = await deps.registry.resolve(request.agentId, request.scope);

  const runId = request.runId ?? globalThis.crypto.randomUUID();
  const toolExecutor = deps.toolExecutor ?? deriveToolboxExecutor(agent);
  const host = request.scope !== undefined ? buildScopeHost(request.scope) : undefined;

  const result = await deps.runner.run(agent, request.input, {
    runId,
    trigger,
    toolExecutor,
    eventBus: deps.eventBus,
    host,
    maxIterations: request.maxIterations,
    abortSignal: request.signal,
  });

  return { runId, agentId: request.agentId, result };
}
