/**
 * Human approval gate for tool calls.
 *
 * Category: APPROVAL (runs third)
 */

import type { BaseEvent, ToolCallIntent } from "../events/types.js";
import { BaseGate, GateAllow, GateBlock, GateCategory, type GateResult } from "./base.js";

/** Callback that decides whether to approve a tool call. */
export type ApprovalCallback = (event: ToolCallIntent) => boolean | Promise<boolean>;

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

  async check(event: BaseEvent): Promise<GateResult> {
    if (event.type !== "agent.tool.intent") {
      return GateAllow;
    }

    const toolName = (event as ToolCallIntent).toolName ?? "";

    // Check if this tool needs approval
    if (this._tools && !this._tools.has(toolName)) {
      return GateAllow;
    }

    if (this._autoApprove) {
      return GateAllow;
    }

    const approved = await this._approvalFn(event as ToolCallIntent);
    return approved ? GateAllow : GateBlock(this.getBlockReason(event));
  }

  override getBlockReason(event: BaseEvent): string {
    const toolName = (event as { toolName?: string }).toolName ?? "unknown";
    return `Human declined approval for '${toolName}'`;
  }
}
