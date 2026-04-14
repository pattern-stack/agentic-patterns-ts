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
    "agent.error",
  ],
  [EventProfile.OBSERVABILITY]: [
    "agent.conversation.start",
    "agent.conversation.end",
    "agent.message.start",
    "agent.message.complete",
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
    "agent.error",
  ],
  [EventProfile.DEBUG]: [
    "agent.conversation.start",
    "agent.conversation.end",
    "agent.message.start",
    "agent.message.chunk",
    "agent.message.complete",
    "agent.message.cancel",
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
