/**
 * Server configuration types.
 */

import type {
  AdminServiceProtocol,
  AgentEventBus,
  AgentLike,
  RunResult,
  RunnerProtocol,
} from "@agentic-patterns/runtime";

/**
 * A runner instance — same shape the server has always required (structural
 * subset of `RunnerProtocol`). Renamed from the inline `AgentRegistration.runner`
 * type with no behavior change; existing registrations still satisfy it.
 */
export type RunnerLike = Pick<RunnerProtocol, "run" | "stream"> & {
  run(agent: AgentLike, message: string, options?: Record<string, unknown>): Promise<RunResult>;
};

/**
 * A runner factory — produces a fresh `RunnerLike` per conversation.
 *
 * Used when a registration wants per-conversation runner state (e.g. the
 * Claude Code API runner holding its own `session_id` for resumption).
 * The server calls `forConversation(id)` once per `POST /conversations`
 * and the returned runner is then reused for every turn in that conversation.
 */
export interface RunnerFactory {
  forConversation(conversationId: string): RunnerLike;
}

/**
 * Narrow-type guard distinguishing a concrete runner from a factory.
 */
export function isRunnerFactory(x: RunnerLike | RunnerFactory): x is RunnerFactory {
  return typeof (x as RunnerFactory).forConversation === "function";
}

/**
 * Agent registration — what the server knows about each agent.
 *
 * `agent` and `runner.run/stream` use the canonical protocol shapes
 * (`AgentLike`, `RunnerProtocol`, `RunResult`) from the runtime so the
 * server and runtime share a single contract end-to-end.
 *
 * `runner` may be either a concrete `RunnerLike` instance (shared across
 * every conversation using this agent) or a `RunnerFactory` that mints a
 * fresh runner per conversation — see `conversations.ts` for resolution.
 */
export interface AgentRegistration {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly agent: AgentLike;
  readonly runner: RunnerLike | RunnerFactory;
}

// AdminServiceProtocol is imported from @agentic-patterns/runtime
export type { AdminServiceProtocol };

/**
 * SSE exporter interface — structural typing for SSEExporter from runtime.
 */
export interface SSEExporterLike {
  connect(): ReadableStream<Uint8Array>;
  disconnect(stream: ReadableStream<Uint8Array>): void;
}

/**
 * Conversation store interface — structural typing for ConversationStoreProtocol.
 */
export interface ConversationStoreLike {
  get(id: string): Promise<unknown>;
  list(): Promise<unknown[]>;
}

/**
 * CORS configuration passed to the Hono cors middleware.
 *
 * Default is `origin: "*"` for local development. Production deployments
 * should pin to known origins.
 */
export interface CORSConfig {
  readonly origin?: string | string[];
  readonly allowMethods?: string[];
  readonly allowHeaders?: string[];
  readonly maxAge?: number;
  readonly credentials?: boolean;
  readonly exposeHeaders?: string[];
}

/**
 * Server configuration.
 */
export interface ServerConfig {
  readonly agents: AgentRegistration[];
  readonly adminService: AdminServiceProtocol;
  readonly eventBus: AgentEventBus;
  readonly sseExporter: SSEExporterLike;
  readonly store?: ConversationStoreLike;
  readonly staticDir?: string;
  /** CORS options forwarded to Hono's cors middleware. Defaults to `origin: "*"`. */
  readonly cors?: CORSConfig;
}
