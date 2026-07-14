export {
  type PatternContext,
  type PatternStartEvent,
  type PatternStepStartEvent,
  type PatternStepCompleteEvent,
  type PatternStepErrorEvent,
  type PatternIterationStartEvent,
  type PatternIterationCompleteEvent,
  type PatternCompleteEvent,
  type PatternEvent,
  type PatternHooks,
  type PatternRunOptions,
  type PatternProtocol,
  type AgentLike,
  makeStepName,
  applyStepModel,
} from "./base.js";

export type {
  Node,
  NodeResult,
  NodeOutcome,
  NodeRunContext,
} from "./node.js";

export {
  type Slot,
  type ScratchpadReader,
  type ScratchpadAccess,
  type Scratchpad,
  slot,
  DefaultScratchpad,
  createScratchpad,
} from "./slot.js";

export {
  type DepKey,
  type DepReader,
  type DepsBuilder,
  DepRegistry,
  MissingDependencyError,
  depKey,
  provideDeps,
} from "./deps.js";

export type { Consolidate } from "./consolidate.js";

export {
  type AgentStepSpec,
  AgentStep,
  StructuredOutputUnsupported,
} from "./agent-step.js";

export {
  type RoleInput,
  type PromoteOptions,
  type PromotedAgent,
  asAgent,
  isPromotedAgent,
  NodeBackedRunner,
} from "./as-agent.js";

export {
  type FunctionStepSpec,
  FunctionStep,
} from "./function-step.js";

export {
  type SeqOpts,
  SequentialBuilder,
  Sequential,
} from "./sequential.js";

export {
  type ParallelOpts,
  type ParallelBranch,
  type ParallelResult,
  Parallel,
  runWithConcurrency,
} from "./parallel.js";

export {
  type FanOutSpec,
  type FanOutResult,
  FanOut,
} from "./fan-out.js";

export {
  type NodeToolSpec,
  type SubagentSpec,
  nodeTool,
  NodeToolbox,
  delegateTo,
} from "./node-tool.js";

export {
  type CoordinatorStepSpec,
  CoordinatorStep,
  withTeamCapability,
} from "./coordinator-step.js";

export {
  type AccumulateSpec,
  type AccumulateStepInput,
  Accumulate,
} from "./accumulate.js";

export {
  type LoopSpec,
  type LoopExitReason,
  type LoopResult,
  Loop,
  type AccumulatingLoopSpec,
  type AccumulatingLoopStepInput,
  type AccumulatingLoopResult,
  AccumulatingLoop,
} from "./loop.js";

export {
  type AgentStage,
  type AgentStageSpec,
  type CompletedStage,
  type SequentialAgentOpts,
  type SequentialAgentResult,
  type TypedSequentialAgentOpts,
  renderPriorEmission,
  renderSharedState,
  sequentialAgent,
} from "./sequential-agents.js";

export {
  type RetryFailure,
  type RetryPredicate,
  type RetryBackoff,
  type RetrySpec,
  type RetryExitReason,
  type RetryResult,
  Retry,
  retry,
  computeDelay,
} from "./retry.js";

export {
  buildWorkflowFromConfig,
  compileMessageTemplate,
  type BuildWorkflowOptions,
} from "./build-workflow-from-config.js";

export { withRunner } from "./with-runner.js";

export {
  type BackpackSpec,
  type Backpack,
  type DropReceipt,
  type DropRecord,
  type WriteManifest,
  type IndexedView,
  createBackpack,
  backpackSlot,
  indexedView,
  createRunHost,
  hydrateThenDrop,
  BackpackUnavailableError,
} from "./backpack.js";

// The backpack accessors — tool-side (openBackpack/requireBackpack) AND
// pad-side (readBackpack) — are served by the OBSERVED module (#226):
// identical contracts to the raw trio in backpack.ts, plus `agent.backpack.*`
// state-event emission when the run's pad is an ObservedScratchpad.
// backpack.ts itself stays event-free by construction (structural no-emit test).
export { openBackpack, readBackpack, requireBackpack } from "./observed-backpack.js";

export { ObservedScratchpad } from "./observed-scratchpad.js";

export {
  type StateEmitter,
  createStateEmitter,
  previewValue,
  capPreview,
  ROW_PREVIEW_BYTES,
  FRAME_PREVIEW_BYTES,
  PREVIEW_MARKER,
  BACKPACK_SLOT_PREFIX,
} from "./state-events.js";
