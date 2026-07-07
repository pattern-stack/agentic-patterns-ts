/**
 * Public surface of the storage layer.
 */

export { derivePass, EvalStore } from "./eval-store.js";
export type {
  EvalCaseHistoryRow,
  EvalCaseRow,
  EvalComparison,
  EvalComparisonRow,
  EvalResultRecord,
  EvalRunAggregate,
  EvalRunMeta,
  EvalRunRow,
  EvalScoreLike,
  EvalSetMeta,
  EvalSetSummary,
  EvalSplit,
  JoinedEvalResultRow,
  SplitAggregate,
  StoredEvalCase,
} from "./eval-store.js";
export { createEvalResultRecorder } from "./eval-recorder.js";
export type { EvalRecorderMeta, EvalResultLike } from "./eval-recorder.js";
export { EventStore } from "./event-store.js";
export type { EventStoreOptions, PersistedEvent, SessionSummary } from "./event-store.js";
export { SQLiteConversationStore } from "./conversation-store.js";
export {
  loadConversationStore,
  loadEvalStore,
  loadEventStore,
  loadRunStore,
} from "./load.js";
export type {
  LoadConversationStoreResult,
  LoadEvalStoreResult,
  LoadEventStoreOptions,
  LoadEventStoreResult,
  LoadRunStoreResult,
} from "./load.js";
export { RunStore } from "./run-store.js";
export type { RunMeta, RunOutcome, RunRow, RunStats, RunSummary } from "./run-store.js";
