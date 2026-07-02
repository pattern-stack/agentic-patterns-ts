/**
 * AgencyRuntime - takes an Agency atom and produces a running system of AgentNode instances.
 *
 * Bridges the declarative Agency definition (atoms layer) to the runtime systems layer
 * by creating transport, building agents with roles/capabilities, and wiring up
 * event-driven communication between nodes.
 *
 * Architecture:
 *   Agency (atom) -> AgencyRuntime -> [AgentNode, AgentNode, ...] on shared transport
 */

import {
  type Agency,
  AgentBuilder,
  type AgentSpecData,
  Capability,
  Judgment,
  Mission,
  Persona,
  RoleBuilder,
  TextManual,
} from "@agentic-patterns/core";
import { SandboxEventBus } from "../events/sandbox-event-bus.js";
import type { AgentAddress } from "../events/sandbox-types.js";
import type { RunnerProtocol } from "../runner/types.js";
import { InProcessTransport } from "../transport/in-process.js";
import { MessagingToolbox } from "../transport/messaging-toolbox.js";
import { AgentNode } from "./agent-node.js";

// ---------------------------------------------------------------------------
// ID generation (works without DOM or Node types)
// ---------------------------------------------------------------------------

let _counter = 0;
function generateId(): string {
  if (typeof globalThis !== "undefined" && "crypto" in globalThis) {
    return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${(++_counter).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Messaging manual (inline, matches Python _MessagingManual)
// ---------------------------------------------------------------------------

const MESSAGING_GUIDANCE =
  "## Team Communication\n" +
  "Use send_message(to, content) to message a specific teammate by role name.\n" +
  "Use broadcast(content) for team-wide announcements.\n" +
  "Use list_team() to see who's on the team.\n\n" +
  "Keep messages brief and actionable. Don't send more than 2 messages per turn.\n" +
  "When your work is done, stop messaging.";

// ---------------------------------------------------------------------------
// AgencyRuntime
// ---------------------------------------------------------------------------

/**
 * Takes an Agency atom and creates an AgentNode swarm with transport wiring.
 *
 * Lifecycle:
 *   const runtime = new AgencyRuntime(agency, runner);
 *   await runtime.start();               // creates transport, builds nodes, starts all
 *   await runtime.injectCoordinator("Go!");
 *   ...
 *   await runtime.stop();                // stops all nodes and transport
 */
export class AgencyRuntime {
  private readonly _agency: Agency;
  private readonly _runner: RunnerProtocol;
  private readonly _runId: string;
  private _transport: InProcessTransport | null = null;
  private _nodes: Record<string, AgentNode> = {};
  private _buses: Record<string, SandboxEventBus> = {};
  private _addresses: Record<string, AgentAddress> = {};
  private _started = false;

  constructor(agency: Agency, runner: RunnerProtocol, runId?: string) {
    this._agency = agency;
    this._runner = runner;
    this._runId = runId ?? generateId();
  }

  // ── Lifecycle ──

  /**
   * Create transport, build nodes, start all.
   */
  async start(): Promise<void> {
    if (this._started) return;

    // 1. Create transport (MVP: in-process only)
    this._transport = new InProcessTransport();

    // 2. Build addresses for all agents (needed for roster)
    for (const spec of this._agency.data.agents) {
      const addr: AgentAddress = {
        deviceId: "local",
        instanceId: this._runId,
        agentId: spec.role,
        role: spec.role,
      };
      this._addresses[spec.role] = addr;
    }

    // 3. Build AgentNode per AgentSpec
    for (const spec of this._agency.data.agents) {
      const node = await this._buildNode(spec);
      this._nodes[spec.role] = node;
    }

    // 4. Start all nodes
    for (const node of Object.values(this._nodes)) {
      await node.start();
    }

    this._started = true;
  }

  /**
   * Stop all nodes and transport.
   */
  async stop(): Promise<void> {
    if (!this._started) return;

    // Stop nodes
    for (const node of Object.values(this._nodes)) {
      await node.stop();
    }

    // Stop buses
    for (const bus of Object.values(this._buses)) {
      await bus.stop();
    }

    this._started = false;
  }

  // ── Messaging ──

  /**
   * Inject a message to a specific agent by role.
   */
  async inject(role: string, content: string): Promise<void> {
    const node = this._nodes[role];
    if (!node) {
      const available = Object.keys(this._nodes).sort().join(", ");
      throw new Error(`No agent with role '${role}'. Available: ${available}`);
    }
    await node.inject(content);
  }

  /**
   * Inject a message to the coordinator agent.
   */
  async injectCoordinator(content: string): Promise<void> {
    const coord = this._agency.coordinator;
    if (!coord) {
      throw new Error("Agency has no coordinator");
    }
    await this.inject(coord.role, content);
  }

  // ── Introspection ──

  /**
   * Get the coordinator's address.
   */
  get coordinatorAddress(): AgentAddress | undefined {
    const coord = this._agency.coordinator;
    if (!coord) return undefined;
    return this._addresses[coord.role];
  }

  /**
   * Return role -> state mapping for all nodes.
   */
  status(): Record<string, "running" | "stopped"> {
    const result: Record<string, "running" | "stopped"> = {};
    for (const [role, node] of Object.entries(this._nodes)) {
      result[role] = node.isDone ? "stopped" : "running";
    }
    return result;
  }

  /**
   * Access the underlying nodes (read-only view).
   */
  get nodes(): Record<string, AgentNode> {
    return { ...this._nodes };
  }

  /**
   * The run ID for this runtime instance.
   */
  get runId(): string {
    return this._runId;
  }

  // ── Internal ──

  /**
   * Build a single AgentNode from an AgentSpec.
   */
  private async _buildNode(spec: AgentSpecData): Promise<AgentNode> {
    if (!this._transport) {
      throw new Error("Transport not initialized");
    }

    const addr = this._addresses[spec.role];
    if (!addr) {
      throw new Error(`No address for role '${spec.role}'`);
    }

    // 1. SandboxEventBus with shared transport
    const bus = new SandboxEventBus(addr, this._transport);
    await bus.start();
    this._buses[spec.role] = bus;

    // 2. MessagingToolbox with full roster
    const toolbox = new MessagingToolbox(bus, addr, this._agency.data.name, this._runId, {
      ...this._addresses,
    });

    // 3. Wrap in Capability with messaging manual
    const manual = new TextManual(
      "Team Communication",
      MESSAGING_GUIDANCE,
      "How to communicate with teammates",
    );
    const messagingCap = new Capability("messaging", "Inter-agent messaging", toolbox, manual);

    // 4. Build Role
    const personaData = spec.persona;
    const persona = personaData
      ? new Persona(personaData)
      : new Persona({
          identity: `a ${spec.role} agent`,
          tone: "professional and concise",
        });

    const roleBuilder = new RoleBuilder(spec.role)
      .withPersona(persona)
      .withCapability(messagingCap)
      .withDefaultModel(spec.model);

    if (spec.judgment) {
      roleBuilder.withJudgment(new Judgment(spec.judgment));
    }

    const role = roleBuilder.build();

    // 5. Build Agent
    const mission = new Mission({
      objective: `Fulfill the ${spec.role} role within the ${this._agency.data.name} agency.`,
    });
    const agent = new AgentBuilder(role).withMission(mission).build();

    // 6. Create AgentNode
    return new AgentNode({
      name: spec.role,
      agent,
      bus,
      address: addr,
      toolbox,
      runner: this._runner,
      maxTurns: spec.maxTurns,
    });
  }
}
