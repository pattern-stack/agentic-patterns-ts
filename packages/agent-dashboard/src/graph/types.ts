/**
 * Shared contracts for the cockpit constellation (ported from swe-brain's Agent
 * Plane, localized to the retrieval-agent domain). The trace contract
 * (`TraceStep` / `RunTrace`) is what `trace-from-events.ts` folds our cockpit
 * event stream into; the capability contracts describe the agent's static
 * composition that `composition.ts` builds the graph from.
 */

/** side-effect class: read = neutral · write = mutates our store · external = leaves our walls. */
export type BlastRadius = "read" | "write" | "external";

export interface CapabilityMeta {
  name: string;
  title: string;
  /** UI grouping surface (Query / Evidence / …) */
  surface: string;
  blastRadius: BlastRadius;
  /** tool names this capability arms (display) */
  tools: string[];
}

export interface CapabilityTool {
  name: string;
  description?: string;
}

/** A resolved capability (name · title · tools) — our analogue of swe-brain's registry record. */
export interface CapabilityRecord {
  name: string;
  title: string;
  description?: string;
  tools: CapabilityTool[];
}

/* ── run trace ──────────────────────────────────────────────────────────── */

export type TraceStepKind = "context" | "model" | "tool_call" | "tool_result" | "finish";

export interface TraceStep {
  seq: number;
  /** loop iteration — 0 = setup; 1, 2, … = model/tool turns. */
  iter: number;
  kind: TraceStepKind;
  label?: string;
  detail?: string;
  ms: number;
  /** model steps */
  ctxTokens?: number;
  outTokens?: number;
  emits?: string[];
  /** tool steps */
  tool?: string;
  capability?: string;
  blast?: BlastRadius;
  args?: unknown;
  output?: unknown;
  note?: string;
  status?: string;
  /** multi-agent: the sub-agent / pipeline phase this step belongs to (ARM B/C). */
  agent?: string;
}

export interface RunTrace {
  runId: string;
  agentName: string;
  model: string;
  request: string;
  result: {
    inputTokens: number;
    outputTokens: number;
    toolCallsCount: number;
    iterations: number;
    finishReason: string;
    totalMs: number;
  };
  steps: TraceStep[];
}
