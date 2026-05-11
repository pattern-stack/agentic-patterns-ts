/**
 * Public surface of the storage layer.
 */

export { EventStore } from "./event-store.js";
export type { EventStoreOptions, PersistedEvent, SessionSummary } from "./event-store.js";
export { loadEventStore } from "./load.js";
export type { LoadEventStoreOptions, LoadEventStoreResult } from "./load.js";
