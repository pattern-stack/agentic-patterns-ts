/**
 * SessionCard organism — collapsible panel for one Claude Code session.
 *
 * Header shows session_id (truncated), cwd, event count, hook-name chips,
 * and duration. Body (when expanded) is a timeline of hook events with
 * per-row expand-to-JSON.
 */

import { useState } from "react";
import {
  type HookCategory,
  type SessionEvent,
  type SessionState,
  formatDuration,
  hookCategory,
  summarizeHook,
} from "../../lib/claudeCodeSessions";
import { Badge, type BadgeTone } from "../atoms/Badge";
import { Card } from "../atoms/Card";

const CATEGORY_TONES: Record<HookCategory, BadgeTone> = {
  tool: "accent",
  permission: "yellow",
  compact: "purple",
  session: "muted",
  stop: "red",
  notification: "emerald",
  other: "neutral",
};

function toneForHook(hookName: string): BadgeTone {
  return CATEGORY_TONES[hookCategory(hookName)];
}

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString();
  } catch {
    return timestamp;
  }
}

function truncateId(id: string, head = 6, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

interface SessionCardProps {
  session: SessionState;
}

export function SessionCard({ session }: SessionCardProps) {
  const [open, setOpen] = useState(false);

  const countEntries = Object.entries(session.counts).sort((a, b) => b[1] - a[1]);
  const duration = formatDuration(session.firstSeen, session.lastSeen);

  return (
    <Card padded={false}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="ap-row-btn"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
          padding: "12px 16px",
          border: "none",
          textAlign: "left",
          color: "inherit",
          fontFamily: "inherit",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        <span
          style={{
            width: 12,
            color: "var(--fg-subtle)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {open ? "▾" : "▸"}
        </span>
        <Badge tone="emerald" variant="outline" title={session.sessionId}>
          <span style={{ fontFamily: "var(--font-mono)" }}>{truncateId(session.sessionId)}</span>
        </Badge>
        {session.source === "resume" && (
          <Badge tone="purple" variant="outline" title="SessionStart fired with source=resume">
            resumed
          </Badge>
        )}
        {session.cwd && (
          <span
            title={session.cwd}
            style={{
              color: "var(--fg-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              overflow: "hidden",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
              maxWidth: 360,
            }}
          >
            {session.cwd}
          </span>
        )}
        <Badge tone="muted">{session.events.length} events</Badge>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {countEntries.map(([hook, n]) => (
            <Badge key={hook} tone={toneForHook(hook)}>
              {hook} ×{n}
            </Badge>
          ))}
        </div>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            alignItems: "center",
            color: "var(--fg-subtle)",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
          }}
          title={`first ${session.firstSeen} → last ${session.lastSeen}`}
        >
          <span>{formatTime(session.firstSeen)}</span>
          <span>→</span>
          <span>{formatTime(session.lastSeen)}</span>
          <Badge tone="muted" variant="outline">
            {duration}
          </Badge>
        </div>
      </button>
      {open && <SessionTimeline events={session.events} />}
    </Card>
  );
}

function SessionTimeline({ events }: { events: SessionEvent[] }) {
  if (events.length === 0) {
    return (
      <div
        style={{
          padding: "12px 16px",
          borderTop: "1px solid var(--border-muted)",
          color: "var(--fg-muted)",
          fontSize: 13,
        }}
      >
        No events in this session yet.
      </div>
    );
  }
  return (
    <div style={{ borderTop: "1px solid var(--border-muted)" }}>
      {events.map((event) => (
        <TimelineRow key={event.id} event={event} />
      ))}
    </div>
  );
}

function TimelineRow({ event }: { event: SessionEvent }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeHook(event);
  return (
    <div style={{ borderBottom: "1px solid var(--border-muted)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="ap-row-btn"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 14px 6px 28px",
          border: "none",
          textAlign: "left",
          color: "inherit",
          fontFamily: "inherit",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        <span
          style={{
            width: 12,
            color: "var(--fg-subtle)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {open ? "▾" : "▸"}
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
        <Badge tone={toneForHook(event.hookName)}>{event.hookName}</Badge>
        {event.toolName && (
          <Badge tone="muted" variant="outline">
            {event.toolName}
          </Badge>
        )}
        {event.runnerCorrelationId && (
          <Badge
            tone="purple"
            variant="filled"
            title={`runner_correlation_id: ${event.runnerCorrelationId}`}
          >
            RUNNER
          </Badge>
        )}
        <span
          style={{
            color: "var(--fg-default)",
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
            flex: 1,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        >
          {summary}
        </span>
      </button>
      {open && (
        <pre
          style={{
            margin: 0,
            padding: "8px 14px 12px 52px",
            background: "var(--bg-inset)",
            color: "var(--fg-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            lineHeight: 1.5,
          }}
        >
          {JSON.stringify(event.raw, null, 2)}
        </pre>
      )}
    </div>
  );
}
