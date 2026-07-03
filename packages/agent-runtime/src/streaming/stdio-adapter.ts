/**
 * StdioAdapter — JSON-RPC 2.0 over stdin/stdout for subprocess mode.
 *
 * Handles methods: listAgents, createConversation, sendMessage,
 * listConversations, getConversation. Uses SSEFormatter.extractPayload()
 * for event data in stream.event notifications.
 */

import * as readline from "node:readline";
import {
  type ConversationStore,
  InMemoryConversationStore,
  type StoredConversation,
} from "../conversation/store.js";
import type { AgentEvent } from "../events/types.js";
import type { AgentLike, RunnerProtocol } from "../runner/types.js";
import { SSEFormatter } from "../transport/sse-formatter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JSONRPCRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JSONRPCNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}

type NotificationCallback = (notification: JSONRPCNotification) => void;

// ---------------------------------------------------------------------------
// StdioAdapter
// ---------------------------------------------------------------------------

export class StdioAdapter {
  private _agents: AgentLike[];
  private _agentMap: Map<string, AgentLike>;
  private _runner: RunnerProtocol;
  private _store: ConversationStore;
  private _conversations = new Map<string, StoredConversation>();

  constructor(opts: {
    agents: AgentLike[];
    runner: RunnerProtocol;
    store?: ConversationStore;
  }) {
    this._agents = opts.agents;
    this._agentMap = new Map(opts.agents.map((a) => [a.role.name, a]));
    this._runner = opts.runner;
    this._store = opts.store ?? new InMemoryConversationStore();
  }

  /** Start reading JSON-RPC from stdin, writing to stdout. */
  async start(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const request = JSON.parse(trimmed) as JSONRPCRequest;
        const response = await this.handleRequest(request, (notification) => {
          process.stdout.write(`${JSON.stringify(notification)}\n`);
        });
        if (request.id !== undefined) {
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      } catch {
        const errorResponse: JSONRPCResponse = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        };
        process.stdout.write(`${JSON.stringify(errorResponse)}\n`);
      }
    }
  }

  /** Handle a single JSON-RPC request. Testable without stdin/stdout. */
  async handleRequest(
    request: JSONRPCRequest,
    onNotification?: NotificationCallback,
  ): Promise<JSONRPCResponse> {
    const id = request.id ?? null;

    try {
      switch (request.method) {
        case "listAgents":
          return this._listAgents(id);
        case "createConversation":
          return await this._createConversation(id, request.params);
        case "sendMessage":
          return await this._sendMessage(id, request.params, onNotification);
        case "listConversations":
          return await this._listConversations(id);
        case "getConversation":
          return await this._getConversation(id, request.params);
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${request.method}` },
          };
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err.message },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Method handlers
  // ---------------------------------------------------------------------------

  private _listAgents(id: number | string | null): JSONRPCResponse {
    const agents = this._agents.map((a) => ({
      name: a.role.name,
      model: a.getModel(),
    }));
    return { jsonrpc: "2.0", id, result: agents };
  }

  private async _createConversation(
    id: number | string | null,
    params?: Record<string, unknown>,
  ): Promise<JSONRPCResponse> {
    const agentName = params?.agentName as string | undefined;
    if (!agentName || !this._agentMap.has(agentName)) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown agent: ${agentName}` },
      };
    }

    const agent = this._agentMap.get(agentName)!;
    const conv = await this._store.createConversation(agentName, agent.getModel());
    this._conversations.set(conv.id, conv);

    return {
      jsonrpc: "2.0",
      id,
      result: {
        conversationId: conv.id,
        agentName: conv.agentName,
        model: conv.model,
      },
    };
  }

  private async _sendMessage(
    id: number | string | null,
    params?: Record<string, unknown>,
    onNotification?: NotificationCallback,
  ): Promise<JSONRPCResponse> {
    const conversationId = params?.conversationId as string | undefined;
    const message = params?.message as string | undefined;

    if (!conversationId || !message) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: "Missing conversationId or message",
        },
      };
    }

    const conv = this._conversations.get(conversationId);
    if (!conv) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Conversation not found: ${conversationId}` },
      };
    }

    const agent = this._agentMap.get(conv.agentName);
    if (!agent) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Agent not found: ${conv.agentName}` },
      };
    }

    // Use stream if available, otherwise fall back to run
    if (this._runner.stream) {
      const gen = this._runner.stream(agent, message);
      for await (const event of gen) {
        if (onNotification) {
          const payload = SSEFormatter.extractPayload(event as AgentEvent);
          if (payload) {
            onNotification({
              jsonrpc: "2.0",
              method: "stream.event",
              params: {
                type: event.type,
                data: payload,
              },
            });
          }
        }
      }
    } else {
      await this._runner.run(agent, message);
    }

    return {
      jsonrpc: "2.0",
      id,
      result: { status: "completed", conversationId },
    };
  }

  private async _listConversations(id: number | string | null): Promise<JSONRPCResponse> {
    const conversations: StoredConversation[] = [];
    // Get from store — iterate known conversation IDs
    for (const convId of this._conversations.keys()) {
      const conv = await this._store.getConversation(convId);
      if (conv) conversations.push(conv);
    }
    return { jsonrpc: "2.0", id, result: conversations };
  }

  private async _getConversation(
    id: number | string | null,
    params?: Record<string, unknown>,
  ): Promise<JSONRPCResponse> {
    const conversationId = params?.conversationId as string | undefined;
    if (!conversationId) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Missing conversationId" },
      };
    }

    const conv = await this._store.getConversation(conversationId);
    if (!conv) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Conversation not found: ${conversationId}` },
      };
    }

    return { jsonrpc: "2.0", id, result: conv };
  }
}
