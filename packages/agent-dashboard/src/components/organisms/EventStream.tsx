/**
 * EventStream organism — live feed of agent events with click-to-expand.
 *
 * Each event row shows time, type badge, and a one-line summary. Clicking
 * a row expands it in place to show the full event payload as formatted
 * JSON — the canonical drill-down for observability work. The toggle button
 * wears `.ap-row-btn` (styles/atoms.css) for its hover tint — port-map §7.1
 * replaces the old onMouseEnter/onMouseLeave inline-style mutation with CSS.
 */

import { useEffect, useRef, useState } from "react";
import type { StreamEvent } from "../../hooks/useEventStream";
import { Badge, type Tone } from "../atoms/Badge";

const TYPE_TONES: Record<string, Tone> = {
  "agent.step.start": "violet",
  "agent.step.end": "violet",
  "step.start": "violet",
  "step.end": "violet",
  "agent.tool.start": "accent",
  "agent.tool.end": "accent",
  "agent.tool.intent": "accent",
  "agent.tool.rejected": "err",
  "agent.tool.progress": "accent",
  "agent.llm.start": "warn",
  "agent.llm.end": "warn",
  "agent.message.start": "ok",
  "agent.message.chunk": "ok",
  "agent.message.complete": "ok",
  "agent.message.cancel": "mute",
  "agent.reasoning": "violet",
  "agent.thinking.start": "violet",
  "agent.iteration.start": "mute",
  "agent.iteration.end": "mute",
  "agent.conversation.start": "ok",
  "agent.conversation.end": "mute",
  "agent.error": "err",
};

function toneForType(type: string): Tone {
  return TYPE_TONES[type] ?? "mute";
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
  /** Panel height; default preserves the full-page layout. */
  height?: string | number;
}

export function EventStream({ events, height = "calc(100vh - 220px)" }: EventStreamProps) {
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
        background: "var(--paper)",
        borderRadius: "var(--radius-lg)",
        height,
        overflow: "auto",
      }}
    >
      {events.length === 0 && (
        <div style={{ padding: 32, textAlign: "center", color: "var(--ink-2)", fontSize: 14 }}>
          Waiting for events...
        </div>
      )}
      {events.map((event) => {
        const isOpen = expanded.has(event.id);
        return (
          <div key={event.id} style={{ borderBottom: "1px solid var(--line-2)" }}>
            <button
              type="button"
              onClick={() => toggle(event.id)}
              aria-expanded={isOpen}
              className="ap-row-btn"
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 14px",
                border: "none",
                textAlign: "left",
                color: "inherit",
                fontFamily: "inherit",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <span style={{ width: 12, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
                {isOpen ? "▾" : "▸"}
              </span>
              <span
                style={{
                  color: "var(--ink-2)",
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
                  color: "var(--ink)",
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
                  background: "var(--background)",
                  color: "var(--ink-2)",
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
