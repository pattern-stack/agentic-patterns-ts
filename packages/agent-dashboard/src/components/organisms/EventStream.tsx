/**
 * EventStream organism — live feed of agent events with click-to-expand.
 *
 * Each event row shows time, type badge, and a one-line summary. Clicking
 * a row expands it in place to show the full event payload as formatted
 * JSON — the canonical drill-down for observability work.
 */

import { useEffect, useRef, useState } from "react";
import type { StreamEvent } from "../../hooks/useEventStream";
import { Badge, type BadgeTone } from "../atoms/Badge";

const TYPE_TONES: Record<string, BadgeTone> = {
  "agent.tool.start": "accent",
  "agent.tool.end": "accent",
  "agent.tool.intent": "accent",
  "agent.tool.rejected": "red",
  "agent.tool.progress": "accent",
  "agent.llm.start": "yellow",
  "agent.llm.end": "yellow",
  "agent.message.start": "emerald",
  "agent.message.chunk": "emerald",
  "agent.message.complete": "emerald",
  "agent.message.cancel": "muted",
  "agent.reasoning": "purple",
  "agent.thinking.start": "purple",
  "agent.iteration.start": "neutral",
  "agent.iteration.end": "neutral",
  "agent.conversation.start": "emerald",
  "agent.conversation.end": "muted",
  "agent.error": "red",
};

function toneForType(type: string): BadgeTone {
  return TYPE_TONES[type] ?? "neutral";
}

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString();
  } catch {
    return timestamp;
  }
}

function summarize(event: StreamEvent): string {
  const d = event.data;
  if (typeof d.agentName === "string") return d.agentName;
  if (typeof d.toolName === "string") return d.toolName;
  if (typeof d.message === "string") return d.message;
  if (typeof d.content === "string") return d.content.slice(0, 80);
  if (typeof d.delta === "string") return d.delta;
  if (typeof d.reason === "string") return d.reason;
  return "";
}

interface EventStreamProps {
  events: StreamEvent[];
}

export function EventStream({ events }: EventStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Auto-scroll to the latest event, but only while the user is already
  // near the bottom — scrolling up to inspect older events shouldn't
  // snap back on every new arrival.
  // biome-ignore lint/correctness/useExhaustiveDependencies: events identity changes on every feed update
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [events]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div
      ref={containerRef}
      style={{
        background: "var(--bg-surface)",
        borderRadius: 8,
        height: "calc(100vh - 220px)",
        overflow: "auto",
      }}
    >
      {events.length === 0 && (
        <div
          style={{
            padding: 32,
            textAlign: "center",
            color: "var(--fg-muted)",
            fontSize: 14,
          }}
        >
          Waiting for events...
        </div>
      )}
      {events.map((event) => {
        const isOpen = expanded.has(event.id);
        return (
          <div key={event.id} style={{ borderBottom: "1px solid var(--border-muted)" }}>
            <button
              type="button"
              onClick={() => toggle(event.id)}
              aria-expanded={isOpen}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 14px",
                background: "transparent",
                border: "none",
                textAlign: "left",
                color: "inherit",
                fontFamily: "inherit",
                fontSize: 13,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-surface-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <span
                style={{
                  width: 12,
                  color: "var(--fg-subtle)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {isOpen ? "▾" : "▸"}
              </span>
              <span
                style={{
                  color: "var(--fg-muted)",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  minWidth: 90,
                }}
              >
                {formatTime(event.timestamp)}
              </span>
              <Badge tone={toneForType(event.type)}>{event.type.replace("agent.", "")}</Badge>
              <span
                style={{
                  color: "var(--fg-default)",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                  flex: 1,
                }}
              >
                {summarize(event)}
              </span>
            </button>
            {isOpen && (
              <pre
                style={{
                  margin: 0,
                  padding: "8px 14px 12px 40px",
                  background: "var(--bg-inset)",
                  color: "var(--fg-muted)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  lineHeight: 1.5,
                }}
              >
                {JSON.stringify(event.data, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
