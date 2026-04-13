/**
 * Sandbox events for inter-agent communication and environment lifecycle.
 *
 * All sandbox events carry an AgentAddress origin and extend BaseEvent.
 */

import type { BaseEvent } from "./types.js";

// ---------------------------------------------------------------------------
// AgentAddress
// ---------------------------------------------------------------------------

export interface AgentAddress {
  readonly deviceId: string;
  readonly instanceId: string;
  readonly agentId: string;
  readonly role: string;
}

export function createAgentAddress(partial?: Partial<AgentAddress>): AgentAddress {
  return {
    deviceId: partial?.deviceId ?? "",
    instanceId: partial?.instanceId ?? "",
    agentId: partial?.agentId ?? "",
    role: partial?.role ?? "",
  };
}

export function agentAddressToString(addr: AgentAddress): string {
  return `${addr.role}@${addr.deviceId}/${addr.instanceId}/${addr.agentId}`;
}

// ---------------------------------------------------------------------------
// Base sandbox event
// ---------------------------------------------------------------------------

export interface BaseSandboxEvent extends BaseEvent {
  readonly origin: AgentAddress;
  readonly target?: AgentAddress;
  readonly correlationId?: string;
  readonly agencyId: string;
  readonly lineupRunId: string;
}

// ---------------------------------------------------------------------------
// Communication events
// ---------------------------------------------------------------------------

export interface AgentMessageEvent extends BaseSandboxEvent {
  readonly type: "sandbox.agent.message";
  readonly content: string;
  readonly metadata: Record<string, unknown>;
}

export interface AgentBroadcastEvent extends BaseSandboxEvent {
  readonly type: "sandbox.agent.broadcast";
  readonly content: string;
  readonly channel: string;
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export interface AgentJoinEvent extends BaseSandboxEvent {
  readonly type: "sandbox.agent.join";
  readonly reason: string;
}

export interface AgentLeaveEvent extends BaseSandboxEvent {
  readonly type: "sandbox.agent.leave";
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Task coordination events
// ---------------------------------------------------------------------------

export interface TaskCreateEvent extends BaseSandboxEvent {
  readonly type: "sandbox.task.create";
  readonly taskId: string;
  readonly taskTitle: string;
}

export interface TaskUpdateEvent extends BaseSandboxEvent {
  readonly type: "sandbox.task.update";
  readonly taskId: string;
  readonly changes: Record<string, unknown>;
}

export interface TaskAssignEvent extends BaseSandboxEvent {
  readonly type: "sandbox.task.assign";
  readonly taskId: string;
  readonly assignee: AgentAddress;
}

// ---------------------------------------------------------------------------
// Health events
// ---------------------------------------------------------------------------

export interface HealthPingEvent extends BaseSandboxEvent {
  readonly type: "sandbox.health.ping";
}

export interface HealthPongEvent extends BaseSandboxEvent {
  readonly type: "sandbox.health.pong";
  readonly status: string;
  readonly uptimeSeconds: number;
}

// ---------------------------------------------------------------------------
// Node lifecycle events
// ---------------------------------------------------------------------------

export interface NodeLifecycleEvent extends BaseSandboxEvent {
  readonly type: "sandbox.node.lifecycle";
  readonly nodeEventType:
    | "node.started"
    | "node.stopped"
    | "node.message_received"
    | "node.response_sent";
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type SandboxEvent =
  | AgentMessageEvent
  | AgentBroadcastEvent
  | AgentJoinEvent
  | AgentLeaveEvent
  | TaskCreateEvent
  | TaskUpdateEvent
  | TaskAssignEvent
  | HealthPingEvent
  | HealthPongEvent
  | NodeLifecycleEvent;

export type SandboxEventType = SandboxEvent["type"];

// ---------------------------------------------------------------------------
// Serialization (JSON for transport)
// ---------------------------------------------------------------------------

interface SerializedAddress {
  deviceId: string;
  instanceId: string;
  agentId: string;
  role: string;
}

function serializeAddress(addr: AgentAddress): SerializedAddress {
  return {
    deviceId: addr.deviceId,
    instanceId: addr.instanceId,
    agentId: addr.agentId,
    role: addr.role,
  };
}

function deserializeAddress(raw: Record<string, unknown>): AgentAddress {
  // Support legacy lxc_id key
  const instanceId =
    (raw.instanceId as string | undefined) ??
    (raw.instance_id as string | undefined) ??
    (raw.lxc_id as string | undefined) ??
    "";
  return {
    deviceId: (raw.deviceId as string | undefined) ?? (raw.device_id as string | undefined) ?? "",
    instanceId,
    agentId: (raw.agentId as string | undefined) ?? (raw.agent_id as string | undefined) ?? "",
    role: (raw.role as string | undefined) ?? "",
  };
}

/**
 * Serialize a sandbox event to a JSON string for transport.
 */
export function serializeSandboxEventToString(event: SandboxEvent): string {
  const data: Record<string, unknown> = {
    type: event.type,
    spanId: event.spanId,
    timestamp: event.timestamp.toISOString(),
    runId: event.runId,
    agencyId: event.agencyId,
    lineupRunId: event.lineupRunId,
    correlationId: event.correlationId,
    origin: serializeAddress(event.origin),
  };

  if (event.target) {
    data.target = serializeAddress(event.target);
  }

  // Add type-specific fields
  switch (event.type) {
    case "sandbox.agent.message":
      data.content = event.content;
      data.metadata = event.metadata;
      break;
    case "sandbox.agent.broadcast":
      data.content = event.content;
      data.channel = event.channel;
      break;
    case "sandbox.agent.join":
    case "sandbox.agent.leave":
      data.reason = event.reason;
      break;
    case "sandbox.task.create":
      data.taskId = event.taskId;
      data.taskTitle = event.taskTitle;
      break;
    case "sandbox.task.update":
      data.taskId = event.taskId;
      data.changes = event.changes;
      break;
    case "sandbox.task.assign":
      data.taskId = event.taskId;
      data.assignee = serializeAddress(event.assignee);
      break;
    case "sandbox.health.ping":
      break;
    case "sandbox.health.pong":
      data.status = event.status;
      data.uptimeSeconds = event.uptimeSeconds;
      break;
    case "sandbox.node.lifecycle":
      data.nodeEventType = event.nodeEventType;
      data.message = event.message;
      data.metadata = event.metadata;
      break;
  }

  return JSON.stringify(data);
}

/**
 * Serialize a sandbox event to bytes for transport.
 */
export function serializeSandboxEvent(event: SandboxEvent): Uint8Array {
  const json = serializeSandboxEventToString(event);
  return new Uint8Array(Array.from(json, (c) => c.charCodeAt(0)));
}

/**
 * Deserialize a sandbox event from a JSON string.
 */
export function deserializeSandboxEventFromString(json: string): SandboxEvent {
  const d = JSON.parse(json) as Record<string, unknown>;
  const origin = deserializeAddress((d.origin as Record<string, unknown>) ?? {});
  const target = d.target ? deserializeAddress(d.target as Record<string, unknown>) : undefined;
  const eventType = d.type as string;

  const base: Omit<BaseSandboxEvent, "type"> = {
    traceId: (d.traceId as string) ?? (d.runId as string) ?? "",
    runId: (d.runId as string) ?? "",
    spanId: (d.spanId as string) ?? "",
    parentSpanId: d.parentSpanId as string | undefined,
    timestamp: new Date((d.timestamp as string) ?? Date.now()),
    origin,
    target,
    correlationId: d.correlationId as string | undefined,
    agencyId: (d.agencyId as string) ?? "",
    lineupRunId: (d.lineupRunId as string) ?? "",
  };

  switch (eventType) {
    case "sandbox.agent.message":
      return {
        ...base,
        type: "sandbox.agent.message",
        content: (d.content as string) ?? "",
        metadata: (d.metadata as Record<string, unknown>) ?? {},
      };
    case "sandbox.agent.broadcast":
      return {
        ...base,
        type: "sandbox.agent.broadcast",
        content: (d.content as string) ?? "",
        channel: (d.channel as string) ?? "",
      };
    case "sandbox.agent.join":
      return {
        ...base,
        type: "sandbox.agent.join",
        reason: (d.reason as string) ?? "",
      };
    case "sandbox.agent.leave":
      return {
        ...base,
        type: "sandbox.agent.leave",
        reason: (d.reason as string) ?? "",
      };
    case "sandbox.task.create":
      return {
        ...base,
        type: "sandbox.task.create",
        taskId: (d.taskId as string) ?? "",
        taskTitle: (d.taskTitle as string) ?? "",
      };
    case "sandbox.task.update":
      return {
        ...base,
        type: "sandbox.task.update",
        taskId: (d.taskId as string) ?? "",
        changes: (d.changes as Record<string, unknown>) ?? {},
      };
    case "sandbox.task.assign":
      return {
        ...base,
        type: "sandbox.task.assign",
        taskId: (d.taskId as string) ?? "",
        assignee: d.assignee
          ? deserializeAddress(d.assignee as Record<string, unknown>)
          : createAgentAddress(),
      };
    case "sandbox.health.ping":
      return { ...base, type: "sandbox.health.ping" };
    case "sandbox.health.pong":
      return {
        ...base,
        type: "sandbox.health.pong",
        status: (d.status as string) ?? "healthy",
        uptimeSeconds: (d.uptimeSeconds as number) ?? 0,
      };
    case "sandbox.node.lifecycle":
      return {
        ...base,
        type: "sandbox.node.lifecycle",
        nodeEventType: (d.nodeEventType as NodeLifecycleEvent["nodeEventType"]) ?? "node.started",
        message: (d.message as string) ?? "",
        metadata: (d.metadata as Record<string, unknown>) ?? {},
      };
    default:
      // Fallback: return as agent.message with empty content
      return {
        ...base,
        type: "sandbox.agent.message",
        content: "",
        metadata: {},
      };
  }
}

/**
 * Deserialize a sandbox event from bytes.
 */
export function deserializeSandboxEvent(data: Uint8Array): SandboxEvent {
  const json = Array.from(data, (b) => String.fromCharCode(b)).join("");
  return deserializeSandboxEventFromString(json);
}
