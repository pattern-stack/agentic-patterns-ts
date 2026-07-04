/**
 * Public surface of the storage layer.
 */

export { derivePass, EvalStore } from "./eval-store.js";
export type {
  EvalCaseRow,
  EvalComparison,
  EvalComparisonRow,
  EvalResultRecord,
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
export { EventStore } from "./event-store.js";
export type { EventStoreOptions, PersistedEvent, SessionSummary } from "./event-store.js";
export { loadEvalStore, loadEventStore, loadRunStore } from "./load.js";
export type {
  LoadEvalStoreResult,
  LoadEventStoreOptions,
  LoadEventStoreResult,
  LoadRunStoreResult,
} from "./load.js";
export { RunStore } from "./run-store.js";
export type { RunMeta, RunOutcome, RunRow, RunStats, RunSummary } from "./run-store.js";
