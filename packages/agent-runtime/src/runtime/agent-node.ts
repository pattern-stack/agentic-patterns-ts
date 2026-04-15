/**
 * AgentNode - event-driven agent wrapper for multi-agent systems.
 *
 * Wraps an Agent with a message queue and worker loop that listens to
 * SandboxEventBus events, batches incoming messages, and runs them through
 * a runner (LLM or mock).
 *
 * Architecture: Bus -> Queue -> Worker -> Runner -> Tools -> Bus
 */

import type { Agent } from "@pattern-stack/agent-core";
import type { SandboxEventBus } from "../events/sandbox-event-bus.js";
import type {
  AgentAddress,
  AgentBroadcastEvent,
  AgentMessageEvent,
  NodeLifecycleEvent,
  SandboxEvent,
} from "../events/sandbox-types.js";
import type { CanonicalMessage, RunnerProtocol } from "../runner/types.js";
import type { MessagingToolbox } from "../transport/messaging-toolbox.js";

// Timers that work in both Node and browser environments
declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(id: number): void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_IDLE_TIMEOUT = 10_000; // 10s of queue-idle before stopping
export const DEFAULT_GLOBAL_TIMEOUT = 120_000; // 120s hard stop (first message wait)
export const DEFAULT_MAX_TURNS = 20;
export const BATCH_WINDOW = 100; // 100ms window for batch draining

// ---------------------------------------------------------------------------
// AgentNode options
// ---------------------------------------------------------------------------

export interface AgentNodeOptions {
  readonly name: string;
  readonly agent: Agent;
  readonly bus: SandboxEventBus;
  readonly address: AgentAddress;
  readonly toolbox: MessagingToolbox;
  readonly runner: RunnerProtocol;
  readonly traceId?: string;
  readonly maxTurns?: number;
  readonly idleTimeout?: number;
  readonly globalTimeout?: number;
}

// ---------------------------------------------------------------------------
// AgentNode
// ---------------------------------------------------------------------------

type QueuedEvent = AgentMessageEvent | AgentBroadcastEvent;

/**
 * Event-driven agent wrapper. Bus -> Queue -> Worker -> Runner -> Bus.
 *
 * Each node owns its own SandboxEventBus (wired to a shared transport)
 * and listens for messages addressed to its AgentAddress.
 *
 * Lifecycle events emitted on the bus:
 * - node.started: when the node begins listening
 * - node.stopped: when the worker exits
 * - node.message_received: when messages are dequeued for processing
 * - node.response_sent: after the runner produces a response
 */
export class AgentNode {
  readonly name: string;
  readonly agent: Agent;
  readonly address: AgentAddress;

  private readonly _bus: SandboxEventBus;
  private readonly _toolbox: MessagingToolbox;
  private readonly _runner: RunnerProtocol;
  private readonly _traceId: string;
  private readonly _maxTurns: number;
  private readonly _idleTimeout: number;
  private readonly _globalTimeout: number;

  private _queue: QueuedEvent[] = [];
  private _queueResolve?: () => void;
  private _conversation: CanonicalMessage[] = [];
  private _turnsTaken = 0;
  private _workerPromise: Promise<void> | null = null;
  private _stopped = false;
  readonly transcript: string[] = [];

  constructor(options: AgentNodeOptions) {
    this.name = options.name;
    this.agent = options.agent;
    this.address = options.address;
    this._bus = options.bus;
    this._toolbox = options.toolbox;
    this._runner = options.runner;
    this._traceId = options.traceId ?? "";
    this._maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this._idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    this._globalTimeout = options.globalTimeout ?? DEFAULT_GLOBAL_TIMEOUT;
  }

  // ── Lifecycle ──

  /**
   * Subscribe to bus events and start the worker loop.
   */
  async start(): Promise<void> {
    this._bus.subscribe("sandbox.agent.message", (event) => {
      this._onMessage(event as AgentMessageEvent);
    });
    this._bus.subscribe("sandbox.agent.broadcast", (event) => {
      this._onBroadcast(event as AgentBroadcastEvent);
    });
    this._workerPromise = this._worker();
    await this._emitLifecycle("node.started", { node: this.name });
  }

  /**
   * Stop the worker loop.
   */
  async stop(): Promise<void> {
    this._stopped = true;
    // Wake up the queue waiter so the worker can exit
    if (this._queueResolve) {
      this._queueResolve();
    }
    if (this._workerPromise) {
      await this._workerPromise;
    }
    await this._emitLifecycle("node.stopped", { node: this.name });
  }

  /**
   * Seed a message into the queue from the orchestrator.
   */
  async inject(content: string): Promise<void> {
    const synthetic: AgentMessageEvent = {
      type: "sandbox.agent.message",
      traceId: this._traceId,
      runId: "",
      spanId: `${Date.now().toString(36)}-inject`,
      timestamp: new Date(),
      origin: { deviceId: "", instanceId: "", agentId: "system", role: "system" },
      target: this.address,
      agencyId: this._bus.address.deviceId,
      lineupRunId: "",
      content,
      metadata: {},
    };
    this._enqueue(synthetic);
  }

  /** Number of turns the worker has completed. */
  get turnsTaken(): number {
    return this._turnsTaken;
  }

  /** Whether the worker is done (stopped or completed). */
  get isDone(): boolean {
    return this._stopped;
  }

  // ── Message filtering ──

  private _shouldHandle(event: SandboxEvent): boolean {
    if (event.type === "sandbox.agent.message") {
      const msg = event as AgentMessageEvent;
      return (
        msg.target !== undefined &&
        msg.target !== null &&
        msg.target.agentId === this.address.agentId &&
        msg.origin.agentId !== this.address.agentId
      );
    }
    if (event.type === "sandbox.agent.broadcast") {
      return event.origin.agentId !== this.address.agentId;
    }
    return false;
  }

  private _onMessage(event: AgentMessageEvent): void {
    if (this._shouldHandle(event)) {
      this._enqueue(event);
    }
  }

  private _onBroadcast(event: AgentBroadcastEvent): void {
    if (this._shouldHandle(event)) {
      this._enqueue(event);
    }
  }

  private _enqueue(event: QueuedEvent): void {
    this._queue.push(event);
    if (this._queueResolve) {
      this._queueResolve();
      this._queueResolve = undefined;
    }
  }

  // ── Worker loop ──

  private _waitForMessage(timeout: number): Promise<QueuedEvent | null> {
    if (this._queue.length > 0) {
      return Promise.resolve(this._queue.shift()!);
    }

    return new Promise<QueuedEvent | null>((resolve) => {
      // biome-ignore lint/style/useConst: assigned in setTimeout closure below
      let timer: ReturnType<typeof setTimeout>;

      this._queueResolve = () => {
        clearTimeout(timer);
        if (this._queue.length > 0) {
          resolve(this._queue.shift()!);
        } else {
          resolve(null);
        }
      };

      timer = setTimeout(() => {
        this._queueResolve = undefined;
        resolve(null);
      }, timeout);
    });
  }

  private _drainQueue(): QueuedEvent[] {
    const batch = [...this._queue];
    this._queue = [];
    return batch;
  }

  private async _worker(): Promise<void> {
    while (this._turnsTaken < this._maxTurns && !this._stopped) {
      // First message: wait up to global timeout; subsequent: use idle timeout
      const timeout = this._turnsTaken === 0 ? this._globalTimeout : this._idleTimeout;
      const msg = await this._waitForMessage(timeout);

      if (!msg || this._stopped) break;

      // Drain additional queued messages (batch window)
      await new Promise<void>((r) => setTimeout(r, BATCH_WINDOW));
      const batch = [msg, ...this._drainQueue()];

      // Emit lifecycle event
      await this._emitLifecycle("node.message_received", {
        node: this.name,
        count: batch.length,
      });

      // Format incoming messages as user input
      const userMsg = this._formatIncoming(batch);

      for (const p of batch) {
        this.transcript.push(`<- ${p.origin.role}: ${p.content}`);
      }

      try {
        const result = await this._runner.run(this.agent, userMsg, {
          toolExecutor: this._toolbox,
          messageHistory: this._conversation,
          traceId: this._traceId || undefined,
          maxIterations: 10,
        });

        // Append to conversation for continuity
        const request: CanonicalMessage = {
          kind: "request" as const,
          parts: [{ type: "user_prompt", content: userMsg }],
        };
        const response: CanonicalMessage = {
          kind: "response" as const,
          parts: [{ type: "text", content: result.response }],
        };
        this._conversation.push(request);
        this._conversation.push(response);

        this._turnsTaken++;
        this.transcript.push(`-> ${this.name}: ${result.response}`);

        // Emit lifecycle event
        await this._emitLifecycle("node.response_sent", {
          node: this.name,
          toolCalls: result.toolCallsCount,
          tokens: result.inputTokens + result.outputTokens,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.transcript.push(`! ${this.name} error: ${message}`);
        break;
      }
    }
  }

  // ── Helpers ──

  private _formatIncoming(events: QueuedEvent[]): string {
    const parts: string[] = [];
    for (const e of events) {
      if (e.type === "sandbox.agent.message") {
        parts.push(`[Message from ${e.origin.role}]: ${e.content}`);
      } else if (e.type === "sandbox.agent.broadcast") {
        parts.push(`[Broadcast from ${e.origin.role}]: ${e.content}`);
      }
    }
    return parts.join("\n\n");
  }

  private async _emitLifecycle(
    nodeEventType: NodeLifecycleEvent["nodeEventType"],
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const event: NodeLifecycleEvent = {
      type: "sandbox.node.lifecycle",
      traceId: this._traceId,
      runId: "",
      spanId: `${Date.now().toString(36)}-lifecycle`,
      timestamp: new Date(),
      origin: this.address,
      agencyId: "",
      lineupRunId: "",
      nodeEventType,
      message: `${nodeEventType}: ${this.name}`,
      metadata,
    };
    await this._bus.publish(event);
  }
}
