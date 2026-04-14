import { useEffect, useRef, useState } from "react";
import type { StreamEvent } from "../../hooks/useEventStream";

const typeBadgeColors: Record<string, string> = {
  "tool.start": "var(--accent)",
  "tool.end": "var(--accent)",
  "llm.start": "var(--yellow)",
  "llm.end": "var(--yellow)",
  "agent.start": "var(--green)",
  "agent.end": "var(--green)",
  error: "var(--red)",
};

function badgeColor(type: string): string {
  return typeBadgeColors[type] ?? "var(--fg-muted)";
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
  if (d.agentName) return String(d.agentName);
  if (d.toolName) return String(d.toolName);
  if (d.message) return String(d.message);
  return "";
}

interface EventStreamProps {
  events: StreamEvent[];
  connected: boolean;
}

export function EventStream({ events, connected }: EventStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!paused && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [paused]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: connected ? "var(--green)" : "var(--red)",
          }}
        />
        <span style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          {connected ? "Connected" : "Disconnected"}
        </span>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          style={{
            marginLeft: "auto",
            padding: "4px 12px",
            fontSize: 13,
            background: paused ? "var(--yellow)" : "var(--bg-surface-hover)",
            color: paused ? "var(--bg-canvas)" : "var(--fg-default)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
      <div
        ref={containerRef}
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          height: "calc(100vh - 200px)",
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
        {events.map((event) => (
          <div
            key={event.id}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              padding: "6px 14px",
              borderBottom: "1px solid var(--border)",
              fontSize: 13,
            }}
          >
            <span
              style={{
                color: "var(--fg-muted)",
                fontSize: 12,
                fontFamily: "monospace",
                flexShrink: 0,
              }}
            >
              {formatTime(event.timestamp)}
            </span>
            <span
              style={{
                background: badgeColor(event.type),
                color: "var(--bg-canvas)",
                padding: "1px 8px",
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {event.type}
            </span>
            <span style={{ color: "var(--fg-default)" }}>{summarize(event)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
