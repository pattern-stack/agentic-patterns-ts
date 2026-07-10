// Human-in-the-loop interaction barrel — the pending-input round-trip that
// lets a running agent block on a human decision (approval / select / text).
export { PendingInputRegistry } from "./pending-input-registry.js";
export type { HumanInputResponse, CreatePendingOptions } from "./pending-input-registry.js";
export { createHumanInputApprovalGate } from "./approval-gate.js";
export type { HumanInputApprovalGateOptions } from "./approval-gate.js";
