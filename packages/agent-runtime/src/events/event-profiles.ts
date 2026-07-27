/**
 * Event profiles for curated event subscriptions.
 *
 * Profiles are handler groups that subscribe to specific event types
 * for different use cases (UX rendering, observability, debugging).
 */

import type { EventBus, EventHandlerFn } from "./event-bus.js";

// ---------------------------------------------------------------------------
// Profile enum
// ---------------------------------------------------------------------------

export const EventProfile = {
  UX: "ux",
  OBSERVABILITY: "obs",
  DEBUG: "debug",
  TOOLS: "tools",
  STREAMING: "stream",
} as const;

export type EventProfile = (typeof EventProfile)[keyof typeof EventProfile];

// ---------------------------------------------------------------------------
// Profile -> event type mappings
// ---------------------------------------------------------------------------

export const PROFILE_EVENT_TYPES: Readonly<Record<EventProfile, readonly string[]>> = {
  [EventProfile.UX]: [
    "agent.conversation.start",
    "agent.conversation.end",
    "agent.message.start",
    "agent.message.chunk",
    "agent.message.complete",
    "agent.message.cancel",
    "agent.input.request",
    "agent.reasoning",
    "agent.thinking.start",
    "agent.iteration.start",
    "agent.iteration.end",
    "agent.llm.start",
    "agent.llm.end",
    "agent.tool.intent",
    "agent.tool.rejected",
    "agent.tool.start",
    "agent.tool.end",
    "agent.tool.progress",
    // Tool-approval SDK-framing pair (#389) — the `toolApproval` bridge's
    // requested/granted/denied events on the capable path. UI-facing by
    // design; `agent.gate.decision` below (OBSERVABILITY) stays the
    // exporter-facing decision record — deliberately NOT duplicated here.
    "agent.tool.approval.request",
    "agent.tool.approval.response",
    // Step / delegation spans (#226) — previously in NO profile, so
    // profile-attached exporters (admin collector, SSE broadcast, SQLite)
    // never saw a stage boundary.
    "agent.step.start",
    "agent.step.end",
    // State-delta events (#226) — Backpack/Scratchpad mutations the dashboard
    // renders as Delta Frames + the Scratchpad rail. UI-facing by design;
    // never aggregated (the collector records them into the ring buffer only).
    "agent.backpack.drop",
    "agent.backpack.read",
    "agent.backpack.absorb",
    "agent.scratchpad.write",
    "agent.scratchpad.read",
    "agent.scratchpad.fork",
    "agent.scratchpad.join",
    "agent.error",
    "claude_code.hook",
  ],
  [EventProfile.OBSERVABILITY]: [
    "agent.conversation.start",
    "agent.conversation.end",
    "agent.message.start",
    "agent.message.complete",
    "agent.input.request",
    "agent.reasoning",
    "agent.thinking.start",
    "agent.iteration.start",
    "agent.iteration.end",
    "agent.llm.start",
    "agent.llm.end",
    "agent.tool.intent",
    "agent.tool.rejected",
    "agent.tool.start",
    "agent.tool.end",
    "agent.tool.progress",
    // Gate-decision audit signal (F-2, #324) — a post-decision record for every
    // intent (allow or block). Belongs in observability so the otel/langfuse
    // exporters surface it as a span/generation; see exporter `_onGateDecision`.
    "agent.gate.decision",
    "agent.error",
  ],
  [EventProfile.DEBUG]: [
    "agent.conversation.start",
    "agent.conversation.end",
    "agent.message.start",
    "agent.message.chunk",
    "agent.message.complete",
    "agent.message.cancel",
    "agent.input.request",
    "agent.reasoning",
    "agent.thinking.start",
    "agent.iteration.start",
    "agent.iteration.end",
    "agent.llm.start",
    "agent.llm.end",
    "agent.tool.intent",
    "agent.tool.rejected",
    "agent.tool.start",
    "agent.tool.end",
    "agent.tool.progress",
    "agent.gate.decision",
    // Tool-approval SDK-framing pair (#389) — see the UX profile's comment above.
    "agent.tool.approval.request",
    "agent.tool.approval.response",
    // Harness-native passthrough envelope (#323/#324) — compaction boundaries,
    // subagent/task progress, rate-limit notices. Debug-only: high-volume,
    // harness-specific detail most consumers never need.
    "harness.native",
    "agent.error",
  ],
  [EventProfile.TOOLS]: [
    "agent.tool.intent",
    "agent.tool.rejected",
    "agent.tool.start",
    "agent.tool.end",
    "agent.tool.progress",
  ],
  [EventProfile.STREAMING]: ["agent.message.chunk"],
};

// ---------------------------------------------------------------------------
// Subscription helpers
// ---------------------------------------------------------------------------

/**
 * Subscribe handler to all event types in a profile.
 *
 * @returns List of event types subscribed to.
 */
export function subscribeProfile(
  bus: EventBus,
  profile: EventProfile,
  handler: EventHandlerFn,
  priority = 0,
): string[] {
  const eventTypes = [...PROFILE_EVENT_TYPES[profile]];
  for (const eventType of eventTypes) {
    bus.subscribe(eventType, handler, priority);
  }
  return eventTypes;
}

/**
 * Unsubscribe handler from all event types in a profile.
 */
export function unsubscribeProfile(
  bus: EventBus,
  profile: EventProfile,
  handler: EventHandlerFn,
): void {
  for (const eventType of PROFILE_EVENT_TYPES[profile]) {
    bus.unsubscribe(eventType, handler);
  }
}

/**
 * Subscribe to multiple profiles, deduplicating event types.
 */
export function subscribeProfiles(
  bus: EventBus,
  profiles: EventProfile[],
  handler: EventHandlerFn,
  priority = 0,
): string[] {
  const eventTypes = new Set<string>();
  for (const profile of profiles) {
    for (const et of PROFILE_EVENT_TYPES[profile]) {
      eventTypes.add(et);
    }
  }
  for (const eventType of eventTypes) {
    bus.subscribe(eventType, handler, priority);
  }
  return [...eventTypes];
}
