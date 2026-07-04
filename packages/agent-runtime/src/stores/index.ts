/**
 * Store family — curated barrel for durable persistence.
 *
 * Naming convention: `<Noun>Store` names the protocol/concept;
 * `InMemory<Noun>Store` / `Sqlite<Noun>Store` name impls. The bare noun
 * never names an impl.
 */

export type {
  ConversationStore,
  StoredConversation,
  StoredMessage,
  StoredMessagePart,
} from "../conversation/store.js";
export { InMemoryConversationStore } from "../conversation/store.js";

export { EventStore } from "../storage/event-store.js";
export type { EventStoreOptions, PersistedEvent, SessionSummary } from "../storage/event-store.js";

/**
 * Naming alias ONLY — Scratchpad is run-scoped execution substrate (fork/join is
 * coupled to Parallel/FanOut); it is not a durable injected store and does not move.
 */
export type { Scratchpad as ScratchpadStore } from "../workflows/slot.js";

export { RunStore } from "../storage/run-store.js";
export type { RunMeta, RunOutcome, RunRow, RunStats, RunSummary } from "../storage/run-store.js";

export { derivePass, EvalStore } from "../storage/eval-store.js";
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
} from "../storage/eval-store.js";

export { createEvalResultRecorder } from "../storage/eval-recorder.js";
export type { EvalRecorderMeta, EvalResultLike } from "../storage/eval-recorder.js";
