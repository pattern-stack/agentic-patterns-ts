// Harness runner barrel (B-2 / #326) — CodingAgentRunner base + adapter contract.

export { CodingAgentRunner, newCorrelationId } from "./coding-agent-runner.js";
export {
  HarnessEventTranslator,
  type HarnessTranslatorContext,
  type HarnessRunAccounting,
} from "./harness-event-translator.js";
export { validateDecision, type DecisionValidation } from "./decision-validation.js";
export { assertGateRequirements, GateRequirementError } from "./gate-requirements.js";
export type {
  HarnessAdapter,
  HarnessSession,
  HarnessRunRequest,
  HarnessEvent,
  HarnessEventKind,
  HarnessEventMeta,
  HarnessProbeResult,
  ProbeContext,
  ProbeIssue,
  Enforcement,
  ParentRef,
  NativeIds,
  OperationClass,
  TokenUsage,
  FinishReason,
  NormalizedDiff,
  AskRequestType,
  DecisionVocabulary,
  IntentEvaluator,
} from "./types.js";
export { HarnessStartError } from "./types.js";
export {
  ClaudeCodeAdapter,
  ClaudeCodeSession,
  type ClaudeCodeAdapterOptions,
  type BuildSDKOptions,
} from "./claude-code/claude-code-adapter.js";
export {
  CCHarnessTranslator,
  type CCHarnessTranslatorContext,
  mapFinishReason,
} from "./claude-code/cc-harness-translator.js";
