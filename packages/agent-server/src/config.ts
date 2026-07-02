/**
 * Server configuration types.
 */

import type {
  AdminServiceProtocol,
  AgentEventBus,
  AgentLike,
  EventStore,
  RunResult,
  RunnerProtocol,
} from "@agentic-patterns/runtime";

/**
 * Agent registration — what the server knows about each agent.
 *
 * `agent` and `runner.run/stream` use the canonical protocol shapes
 * (`AgentLike`, `RunnerProtocol`, `RunResult`) from the runtime so the
 * server and runtime share a single contract end-to-end.
 */
export interface AgentRegistration {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Source file the agent was discovered from (threaded by the CLI). */
  readonly file?: string;
  /**
   * Per-slot provenance blob, computed CLI-side at discovery time where
   * module identity is available (see docs/playground-redesign.md §5).
   * Joined onto composition payloads by `slotType` + `index` (array position;
   * names may collide across preset/fork variants). Blobs from older CLIs
   * lack `index` and fall back to a `name` join.
   */
  readonly provenance?: {
    file: string;
    slots: ReadonlyArray<{
      slotType: string;
      name: string;
      /** Position in the role's slot array for this slotType (persona: 0). */
      index?: number;
      tier: string;
      sourcePath?: string;
    }>;
  };
  readonly agent: AgentLike;
  readonly runner: Pick<RunnerProtocol, "run" | "stream"> & {
    run(agent: AgentLike, message: string, options?: Record<string, unknown>): Promise<RunResult>;
  };
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
  /** Optional durable event log; enables historical query routes when present. */
  readonly eventStore?: EventStore;
  readonly staticDir?: string;
  /** CORS options forwarded to Hono's cors middleware. Defaults to `origin: "*"`. */
  readonly cors?: CORSConfig;
}
