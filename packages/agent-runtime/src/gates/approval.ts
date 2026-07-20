/**
 * Human approval gate for tool calls.
 *
 * Category: APPROVAL (runs third)
 */

import type { BaseEvent, ToolCallIntent } from "../events/types.js";
import { BaseGate, GateAllow, GateCategory, GateModify, type GateResult } from "./base.js";
import type { AskContext, HarnessDecision } from "./decisions.js";

/**
 * Callback that decides a tool call (F-2). Widened from the original
 * `(event) => boolean` to `(event, ctx?) => boolean | HarnessDecision`:
 * - `true`  → coerced to `{ kind: "allowOnce" }`
 * - `false` → coerced to `{ kind: "deny" }`
 * - a {@link HarnessDecision} → honored directly (deny/cancel block; rewriteInput
 *   modifies the intent; every other kind allows).
 *
 * `ctx` is the native ask context (proposals, availableDecisions, …), present
 * only when a harness adapter drives the ask. All existing boolean callbacks
 * keep working unchanged.
 */
export type ApprovalCallback = (
  event: ToolCallIntent,
  ctx?: AskContext,
) => boolean | HarnessDecision | Promise<boolean | HarnessDecision>;

export class HumanApprovalGate extends BaseGate {
  readonly category = GateCategory.APPROVAL;

  private _approvalFn: ApprovalCallback;
  private _tools: Set<string> | undefined;
  private _autoApprove: boolean;

  constructor(options?: {
    approvalFn?: ApprovalCallback;
    tools?: Set<string>;
    autoApprove?: boolean;
  }) {
    super();
    this._approvalFn = options?.approvalFn ?? (() => true);
    this._tools = options?.tools;
    this._autoApprove = options?.autoApprove ?? false;
  }

  async check(event: BaseEvent, ctx?: AskContext): Promise<GateResult> {
    if (event.type !== "agent.tool.intent") {
      return GateAllow;
    }

    const intent = event as ToolCallIntent;
    const toolName = intent.toolName ?? "";

    // Check if this tool needs approval
    if (this._tools && !this._tools.has(toolName)) {
      return GateAllow;
    }

    if (this._autoApprove) {
      return GateAllow;
    }

    const outcome = await this._approvalFn(intent, ctx);
    return this._resolve(outcome, event);
  }

  /** Coerce a callback outcome (boolean or HarnessDecision) into a GateResult. */
  private _resolve(outcome: boolean | HarnessDecision, event: BaseEvent): GateResult {
    // Boolean back-compat: true → allowOnce, false → deny.
    if (typeof outcome === "boolean") {
      return outcome
        ? { action: "allow", decision: { kind: "allowOnce" } }
        : { action: "block", reason: this.getBlockReason(event), decision: { kind: "deny" } };
    }

    switch (outcome.kind) {
      case "deny":
        return {
          action: "block",
          reason: outcome.reason ?? this.getBlockReason(event),
          decision: outcome,
        };
      case "cancel":
        return { action: "block", reason: "Cancelled", decision: outcome };
      case "rewriteInput": {
        const rewritten = {
          ...(event as ToolCallIntent),
          arguments: (outcome.updatedInput ?? {}) as Record<string, unknown>,
        };
        return { ...GateModify(rewritten), decision: outcome };
      }
      // allowOnce | allowSession | allowWithRules | grantPermissions
      default:
        return { action: "allow", decision: outcome };
    }
  }

  override getBlockReason(event: BaseEvent): string {
    const toolName = (event as { toolName?: string }).toolName ?? "unknown";
    return `Human declined approval for '${toolName}'`;
  }
}
