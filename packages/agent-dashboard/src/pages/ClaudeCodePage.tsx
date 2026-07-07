/**
 * ClaudeCodePage — groups live `claude_code.hook` SSE events by session_id.
 *
 * Streams events from `/admin/events/stream` and buckets them into per-session
 * cards that show hook counts, cwd, duration, and a drill-down timeline.
 *
 * NOTE on dev-mode proxy: the default vite proxy for `/admin` points at
 * :3100 (the NestJS agentic-backend). Claude Code hooks are emitted by the
 * Hono `@agentic-patterns/server` on :3456. When running the dashboard via
 * `ap playground` (production mode, SPA served from Hono), this page works
 * out of the box. When running `pnpm dev` directly against the default
 * proxy target, you will not see CC events — repoint the proxy at :3456
 * to test locally.
 */

import { useEffect, useMemo, useState } from "react";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Card } from "../components/atoms/Card";
import { Spinner } from "../components/atoms/Spinner";
import { AlertIcon } from "../components/atoms/icons";
import { SessionCard } from "../components/organisms/SessionCard";
import { type StreamEvent, useEventStream } from "../hooks/useEventStream";
import { type SessionState, groupClaudeCodeEvents } from "../lib/claudeCodeSessions";
import { fetchRecentEvents } from "../lib/eventApi";

export function ClaudeCodePage() {
  const [initial, setInitial] = useState<StreamEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRecentEvents({ type: "claude_code.hook" })
      .then((rows) => {
        if (!cancelled) setInitial(rows);
      })
      .catch(() => {
        // Persistence may be off; show empty state until SSE delivers something.
        if (!cancelled) setInitial([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (initial === null) {
    return <HydratingState />;
  }
  return <ClaudeCodeLoaded initialEvents={initial} />;
}

function ClaudeCodeLoaded({ initialEvents }: { initialEvents: StreamEvent[] }) {
  const { events, connected, error, clear } = useEventStream("/admin/events/stream", {
    initialEvents,
  });

  const sessions: SessionState[] = useMemo(() => groupClaudeCodeEvents(events), [events]);

  const totalEvents = sessions.reduce((n, s) => n + s.events.length, 0);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Claude Code Sessions</h1>
          {connected ? (
            <Badge tone="ok" variant="outline">
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--ok)",
                }}
              />
              connected
            </Badge>
          ) : (
            <Badge tone="warn" variant="outline">
              <Spinner size={10} color="var(--warn)" thickness={1.5} />
              reconnecting…
            </Badge>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Badge tone="mute" variant="outline">
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </Badge>
          <Badge tone="mute" variant="outline">
            {totalEvents} event{totalEvents === 1 ? "" : "s"}
          </Badge>
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
        </div>
      </div>

      {error && (
        <Card
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
            padding: "10px 14px",
            color: "var(--err)",
            borderColor: "var(--err)",
            fontSize: 13,
          }}
          padded={false}
        >
          <AlertIcon size={14} />
          <span>{error}</span>
        </Card>
      )}

      {sessions.length === 0 ? <EmptyState /> : <SessionList sessions={sessions} />}
    </div>
  );
}

function SessionList({ sessions }: { sessions: SessionState[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {sessions.map((session) => (
        <SessionCard key={session.sessionId} session={session} />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          padding: "36px 16px",
          color: "var(--ink-2)",
          fontSize: 13,
          textAlign: "center",
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--ink)" }}>
          No Claude Code sessions observed yet
        </span>
        <span style={{ color: "var(--ink-3)", maxWidth: 520 }}>
          Install the @agentic-patterns plugin in a project and open Claude Code there. Hook events
          will stream in as the session runs.
        </span>
      </div>
    </Card>
  );
}

function HydratingState() {
  return (
    <Card>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          padding: "36px 16px",
          color: "var(--ink-2)",
          fontSize: 13,
        }}
      >
        <Spinner size={12} color="var(--ink-2)" thickness={1.5} />
        <span>Loading recent sessions…</span>
      </div>
    </Card>
  );
}
