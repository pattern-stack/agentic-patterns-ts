/**
 * MessagingToolbox - inter-agent communication tools over shared transport.
 *
 * Provides send_message, broadcast, and list_team tools that publish
 * SandboxEvents to the bus, enabling fully event-driven agent conversations.
 */

import { type ToolDefinition, Toolbox } from "@agentic-patterns/core";
import { z } from "zod";
import type { SandboxEventBus } from "../events/sandbox-event-bus.js";
import type {
  AgentAddress,
  AgentBroadcastEvent,
  AgentMessageEvent,
} from "../events/sandbox-types.js";

/**
 * Tools for inter-agent communication within an agency.
 *
 * Each tool publishes a SandboxEvent to the bus, which then dispatches
 * both locally and over transport.
 */
export class MessagingToolbox extends Toolbox {
  readonly name = "Messaging";
  readonly description = "Tools for sending messages to other agents on the team.";

  private readonly _bus: SandboxEventBus;
  private readonly _address: AgentAddress;
  private readonly _agencyId: string;
  private readonly _runId: string;
  private readonly _roster: Record<string, AgentAddress>;
  readonly tools: Record<string, ToolDefinition>;

  constructor(
    bus: SandboxEventBus,
    address: AgentAddress,
    agencyId: string,
    runId: string,
    roster: Record<string, AgentAddress>,
  ) {
    super();
    this._bus = bus;
    this._address = address;
    this._agencyId = agencyId;
    this._runId = runId;
    this._roster = roster;

    this.tools = {
      send_message: {
        description: "Send a direct message to another agent by role name.",
        parameters: z.object({
          to: z.string().describe("Target agent role name"),
          content: z.string().describe("Message content"),
        }),
        execute: async (args: Record<string, unknown>): Promise<unknown> => {
          const { to, content } = args as { to: string; content: string };
          return this._sendMessage(to, content);
        },
      },

      broadcast: {
        description: "Broadcast a message to all agents in the agency.",
        parameters: z.object({
          content: z.string().describe("Message content to broadcast"),
        }),
        execute: async (args: Record<string, unknown>): Promise<unknown> => {
          const { content } = args as { content: string };
          return this._broadcast(content);
        },
      },

      list_team: {
        description: "List all agents in the agency with their roles.",
        parameters: z.object({}),
        execute: async (): Promise<unknown> => {
          return this._listTeam();
        },
      },
    };
  }

  private async _sendMessage(to: string, content: string): Promise<string> {
    const target = this._roster[to];
    if (!target) {
      const available = Object.keys(this._roster).sort().join(", ");
      return `Unknown agent '${to}'. Available agents: ${available}`;
    }

    const event: AgentMessageEvent = {
      type: "sandbox.agent.message",
      traceId: "",
      runId: "",
      spanId: `${Date.now().toString(36)}-msg`,
      timestamp: new Date(),
      origin: this._address,
      target,
      agencyId: this._agencyId,
      lineupRunId: this._runId,
      content,
      metadata: {},
    };

    await this._bus.publish(event);
    return `Message sent to ${to}.`;
  }

  private async _broadcast(content: string): Promise<string> {
    const event: AgentBroadcastEvent = {
      type: "sandbox.agent.broadcast",
      traceId: "",
      runId: "",
      spanId: `${Date.now().toString(36)}-bcast`,
      timestamp: new Date(),
      origin: this._address,
      agencyId: this._agencyId,
      lineupRunId: this._runId,
      content,
      channel: "",
    };

    await this._bus.publish(event);
    return "Message broadcast to all agents.";
  }

  private _listTeam(): Array<{ role: string; agentId: string }> {
    return Object.entries(this._roster)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([role, addr]) => ({
        role,
        agentId: addr.agentId,
      }));
  }
}
