// Gates barrel export
export type { Gate, GateResult } from "./base.js";
export {
  GateCategory,
  GATE_CATEGORY_NAMES,
  GateAllow,
  GateBlock,
  GateModify,
  BaseGate,
} from "./base.js";

export { SafetyGate } from "./safety.js";
export { RateLimitGate } from "./rate-limit.js";
export { HumanApprovalGate } from "./approval.js";
export type { ApprovalCallback } from "./approval.js";
export { AuditGate } from "./audit.js";
export type { AuditLogger } from "./audit.js";
