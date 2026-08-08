/**
 * Server configuration types.
 */

import type {
  AdminServiceProtocol,
  AgentEventBus,
  AgentLike,
  ConversationStore,
  EvalStore,
  EventStore,
  MemoryStore,
  PendingInputRegistry,
  RunResult,
  RunStore,
  RunnerProtocol,
} from "@agentic-patterns/runtime";

/**
 * One declared grading link: an eval set that grades this agent. The mapping
 * is CODE-DECLARED on the registration (never on the eval_set row — sets get
 * reseeded by harnesses and one set can grade several arms); the store's only
 * agent linkage stays the per-run `eval_run.target_id`.
 */
export interface AgentEvalRef {
  /** The eval set's id in the eval store (e.g. "xd-interpret"). */
  readonly setId: string;
  /** What the set measures on this agent (human framing, shown in the lens). */
  readonly grades?: string;
  /** For composite/pipeline agents: which step this set grades (e.g. "interpret"). */
  readonly step?: string;
  /** Default scorer id when launching from the agent page (falls back to the form default). */
  readonly scorer?: string;
}

/**
 * Structural (duck-typed) view of a `SessionScope` (`@agentic-patterns/core`,
 * #308) — read without importing the class, so a registration built against
 * a DIFFERENT `@agentic-patterns/core` module instance (a CLI-discovered
 * agent, notably) still satisfies this. NEVER `instanceof SessionScope`
 * across that boundary (decisions.md D4) — follows the `AgentIntrospect`/
 * `CapabilityLike` structural-typing precedent (`routes/agents.ts:14-45`).
 *
 * Mirrors `SessionScope`'s own FLAT public surface — `.defaults`/`.presets`/
 * `.redactKeys` are top-level readonly getters, not nested under an
 * `.options` bag — so this structural type stays simple.
 */
export interface SessionScopeLike {
  readonly schema: unknown;
  readonly redactKeys: readonly string[];
  readonly defaults?: Readonly<Record<string, unknown>> | undefined;
  readonly presets?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
  parse(value: unknown): Record<string, unknown>;
  toJsonSchema(): Record<string, unknown>;
}

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
  /**
   * Delivered-instance factory (#268 — was "introspection-only"). `agent` is
   * the DECLARED instance — what the registration statically exports; many
   * projects compose the real one at an assembly site (per-tenant Background
   * fetched live, injected at run time), which the registry never sees.
   * `instantiate` is that assembly site surfaced: given a registration-defined
   * context (e.g. `{ organizationId }`), build the agent AS AN ENTRYPOINT
   * WOULD DELIVER IT.
   *
   * Called once per composition preview (`POST /agents/:id/composition/
   * delivered`) AND once per conversation creation (`POST /conversations`) —
   * the conversation binds the returned instance, so context-resolved
   * closures/deps ARE the run scope the chat executes under. The lens now
   * previews literally the object a conversation runs.
   *
   * Must return an agent runnable by this registration's `runner`: a promoted
   * registration (`agent` is a `PromotedAgent`) must return a `PromotedAgent`
   * from `asAgent(node, { deps })` — `NodeBackedRunner` already fails loud
   * otherwise. May hit live sources. May reject — conversation creation then
   * fails 502 (`instantiate failed: <message>`), it never falls back to
   * `agent`, whose scope would be silently wrong. See `docs/adr/
   * 0004-instantiate-as-execution-seam.md`.
   */
  readonly instantiate?: (context?: Record<string, unknown>) => Promise<AgentLike>;
  /**
   * Session-scoped configuration this agent declares (#308) — a validated
   * shape (`.schema`/`.parse`), redaction (`.redactKeys`), and optional
   * defaults/named presets, superseding ad hoc `context`. When present,
   * `POST /conversations` accepts a `scope` body key (or the deprecated
   * `context` alias — `scope` wins when both are sent) EVEN FOR A
   * REGISTRATION WITH NO `instantiate` HOOK: `instantiation.available`
   * widens to `hasHook || hasScope` (decisions.md D5). The value is parsed
   * against `scope.schema` before it reaches `instantiate`, redaction, the
   * run-metadata stamp, or `buildScopeHost` host injection (`@agentic-
   * patterns/runtime`) — a registration declaring required fields with no
   * defaults makes a bare `POST /conversations` a deliberate 400 (D11).
   */
  readonly scope?: SessionScopeLike;
  /**
   * Seed context for `instantiate` — prefills the lens's context editor and
   * is the effective context on `POST /conversations` when none is supplied.
   * @deprecated Subsumed by `scope.defaults` (#308) — falls back to this
   * field only when `scope` is not declared.
   */
  readonly instantiateDefaults?: Record<string, unknown>;
  /**
   * Top-level `context` keys whose values are replaced with `"[redacted]"`
   * before the context is echoed (create response), held (`ConversationEntry.
   * context`), or persisted (run metadata) — #268 Decision 3. Applied before
   * any write or non-input return; the raw context exists only in-flight,
   * inside the `instantiate` call. Default (omitted): verbatim.
   * @deprecated Subsumed by `scope.redactKeys` (#308) — merged with it
   * (union) rather than replaced, so a hook-only registration's redaction
   * still works unchanged.
   */
  readonly contextRedactKeys?: readonly string[];
  /**
   * Declared eval↔agent mapping: the eval sets that grade THIS agent (or one
   * of its steps). Surfaced on the composition payload so the Agent lens can
   * show grading history and launch runs with set + target pre-bound.
   */
  readonly evals?: ReadonlyArray<AgentEvalRef>;
  readonly runner: Pick<RunnerProtocol, "run" | "stream"> & {
    run(agent: AgentLike, message: string, options?: Record<string, unknown>): Promise<RunResult>;
  };
  /**
   * ADR-0006 §2 — the caller half of the two-layer opt-in for render
   * artifacts. The TOOL declares what it can publish (`ToolSchema.displayType`);
   * this registration decides whether the channel is wired for this agent.
   * Default off: publishing costs bytes and may carry data a given deployment
   * should not surface, so it is opt-in at the seam that knows the deployment.
   */
  readonly publishArtifacts?: boolean;
  /**
   * Cross-session memory binding (#444, ADR-0007 D8a) — declared by the
   * registration, honored by `POST /conversations/:id/messages`: at
   * FIRST-message time the route calls `assembleRecall(store, scope, {query})`
   * and sets the finished block on the conversation's host bag
   * (`host.recall`), which the runner narrows into `RenderContext.recall`.
   *
   * The registration OWNS the store (typically `loadMemoryStore()` in the
   * agent definition — the framework never boots one; a deliberate inversion
   * of #444's original strategy, recorded on that issue). It MUST be the same
   * instance the `instantiate` hook binds into `memoryCapability`, so toolbox
   * writes and turn-1 recall share one store — AND the scope this field
   * derives MUST equal the partition that hook binds into `memoryCapability`:
   * they are two independent author-supplied derivations, and nothing
   * compares them. Diverging silently splits the partitions — every write
   * succeeds, every recall comes back empty (Gate 2.5 M2).
   * `scope` is the author-declared partition (ADR-0007 D3 — the framework
   * does not invent identity): a static string map, or a function of the
   * conversation's PARSED effective context, resolved ONCE at creation and
   * immutable for the conversation's lifetime (same posture as scope itself).
   * A derivation that throws or returns an empty/non-string-map scope fails
   * conversation creation with a 502 — an empty scope would make recall an
   * unscoped search (ADR-0007).
   */
  readonly memory?: {
    readonly store: MemoryStore;
    readonly scope:
      | Record<string, string>
      | ((context?: Record<string, unknown>) => Record<string, string>);
    /** Recall budget override, chars (default: assembleRecall's 4000). */
    readonly budgetChars?: number;
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
 * Server-launched eval execution config (spec `.ai-docs/stacks/eval-surface/
 * specs/139.md` § Decision 3). Absent → `POST /eval/runs` returns 503.
 */
export interface EvalExecutionConfig {
  /**
   * RAW LLM runner (`createRunner()`'s) — NEVER a registration's possibly
   * `NodeBackedRunner`-wrapped one (`workflows/as-agent.ts` throws on a
   * nested `AgentStep` handed a non-promoted agent). `resolveEvalTarget`
   * handles promoted/agent/node targets itself.
   */
  readonly runner: RunnerProtocol;
  /** Provenance stamped onto eval_run rows (CLI formula: AGENT_MODEL ?? tier). */
  readonly model?: string;
  readonly gitSha?: string;
}

/**
 * Server configuration.
 */
export interface ServerConfig {
  readonly agents: AgentRegistration[];
  readonly adminService: AdminServiceProtocol;
  readonly eventBus: AgentEventBus;
  readonly sseExporter: SSEExporterLike;
  /**
   * Optional human-in-the-loop registry — the return leg for approval gates /
   * tool-driven input requests. When present, `POST /conversations/:id/input`
   * resolves a blocked run's `agent.input.request` by `correlation_id`; absent
   * → that route 501s (no gate is wired, so nothing ever blocks on it).
   */
  readonly inputRegistry?: PendingInputRegistry;
  /**
   * Optional structured conversation store — enables `Conversation` to
   * persist request/response messages (wired into `POST /conversations`,
   * `routes/conversations.ts`) AND enables the four `/admin/conversations`,
   * `/conversations/:id`, `/conversations/:id/messages`, `/messages/:id/parts`
   * read routes (503 persistence-not-configured grammar otherwise).
   */
  readonly store?: ConversationStore;
  /** Optional durable event log; enables historical query routes when present. */
  readonly eventStore?: EventStore;
  /** Optional eval store; enables /eval read routes when present (503 otherwise). */
  readonly evalStore?: EvalStore;
  /**
   * Optional run-history store; enables `/admin/runs` read routes when
   * present (503 otherwise). An `EvalStore` (and `EventStore`) already IS a
   * `RunStore` via extension — an embedder that only wires `evalStore` still
   * gets run history for free (`app.ts` falls back to it when this is unset).
   * Prefer setting this explicitly when the embedder's `evalStore` and "the
   * store chat/run executions should persist to" are conceptually different
   * instances.
   */
  readonly runStore?: RunStore;
  /** Optional eval execution seam; enables POST /eval/runs when present (503 otherwise). */
  readonly evalExecution?: EvalExecutionConfig;
  readonly staticDir?: string;
  /** CORS options forwarded to Hono's cors middleware. Defaults to `origin: "*"`. */
  readonly cors?: CORSConfig;
  /**
   * Optional metadata stamped onto the generated docs (`/openapi.json`, `/docs`,
   * `/llms.txt`, `/mcp/tools.json`). Embedders (e.g. the CLI) should pass their
   * package title + version; defaults are sensible for a bare server.
   */
  readonly docs?: {
    readonly title?: string;
    readonly version?: string;
    readonly description?: string;
    /**
     * URL the Scalar `/docs` page loads its bundle from. Default: the jsDelivr
     * CDN. Set to a locally-served path (e.g. `/docs/scalar.js`) for offline,
     * self-contained docs — the embedder must then serve that path itself.
     */
    readonly scalarJsUrl?: string;
  };
}
