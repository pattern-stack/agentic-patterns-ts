/**
 * Conversation detail page — renders the thread for a single conversation.
 *
 * Fetches `/conversations/:id` + `/conversations/:id/messages` in parallel
 * on mount, then issues one `/messages/:id/parts` request per message.
 * Part-type rendering:
 *   user_prompt / text → prose
 *   tool_call          → pre-formatted metadata.arguments
 *   tool_result        → collapsed <pre> of content / metadata
 *   other              → raw JSON fallback
 * Response messages show an input/output token pill.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchJSON } from "../api/client";
import type {
  ConversationDetail,
  ConversationMessage,
  ConversationMessagePart,
} from "../api/types";
import { Badge, type BadgeTone } from "../components/atoms/Badge";
import { Card } from "../components/atoms/Card";
import { Spinner } from "../components/atoms/Spinner";
import { AlertIcon } from "../components/atoms/icons";

type MessageWithParts = ConversationMessage & { parts: ConversationMessagePart[] };

function statusTone(status: string): BadgeTone {
  switch (status) {
    case "active":
    case "pending":
      return "emerald";
    case "failed":
    case "error":
      return "red";
    case "completed":
      return "green";
    default:
      return "neutral";
  }
}

function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

export function ConversationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<MessageWithParts[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const [d, msgs] = await Promise.all([
          fetchJSON<ConversationDetail>(`/conversations/${id}`),
          fetchJSON<ConversationMessage[]>(`/conversations/${id}/messages`),
        ]);
        const withParts = await Promise.all(
          msgs.map(async (m) => ({
            ...m,
            parts: await fetchJSON<ConversationMessagePart[]>(`/messages/${m.id}/parts`),
          })),
        );
        if (!cancelled) {
          setDetail(d);
          setMessages(withParts);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <Card
        style={{
          borderColor: "var(--red)",
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <span style={{ color: "var(--red)", display: "inline-flex", flexShrink: 0 }}>
          <AlertIcon size={18} />
        </span>
        <div>
          <div style={{ fontWeight: 600, color: "var(--red)", marginBottom: 4 }}>
            Failed to load conversation
          </div>
          <div style={{ color: "var(--fg-muted)", fontSize: 14 }}>{error}</div>
        </div>
      </Card>
    );
  }

  if (!detail || !messages) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          padding: "48px 0",
          color: "var(--fg-muted)",
        }}
      >
        <Spinner />
        <span>Loading conversation...</span>
      </div>
    );
  }

  const duration = formatDuration(detail.startedAt, detail.completedAt);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Link
          to="/conversations"
          style={{ color: "var(--fg-muted)", fontSize: 13, textDecoration: "none" }}
        >
          ← Conversations
        </Link>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 14 }}>
            {detail.id.slice(0, 8)}
          </span>
        </h1>
      </div>

      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <Badge tone="emerald" variant="outline">
            {detail.agentName}
          </Badge>
          <Badge tone="muted">{detail.model}</Badge>
          <Badge tone={statusTone(detail.status)}>{detail.status}</Badge>
          <Badge tone="muted">{detail.messageCount} msgs</Badge>
          <Badge tone="muted">{detail.tokenCount.toLocaleString()} tokens</Badge>
          {duration && <Badge tone="muted">{duration}</Badge>}
        </div>
        {detail.error && (
          <div
            role="alert"
            style={{
              marginTop: 12,
              padding: "8px 12px",
              borderRadius: 6,
              background: "rgba(248, 81, 73, 0.08)",
              border: "1px solid var(--red)",
              color: "var(--red)",
              fontSize: 13,
              fontFamily: "var(--font-mono)",
            }}
          >
            {detail.error}
          </div>
        )}
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.length === 0 ? (
          <Card
            style={{
              textAlign: "center",
              padding: 40,
              color: "var(--fg-muted)",
            }}
          >
            No messages yet.
          </Card>
        ) : (
          messages.map((m) => <MessageCard key={m.id} message={m} />)
        )}
      </div>
    </div>
  );
}

function MessageCard({ message }: { message: MessageWithParts }) {
  const kindTone: BadgeTone = message.kind === "request" ? "accent" : "purple";
  return (
    <Card>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <Badge tone={kindTone}>{message.kind}</Badge>
        <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>
          {new Date(message.createdAt).toLocaleString()}
        </span>
        {message.kind === "response" && (
          <Badge tone="muted" title="input / output tokens">
            {message.inputTokens} in / {message.outputTokens} out
          </Badge>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {message.parts.length === 0 ? (
          <div style={{ color: "var(--fg-subtle)", fontSize: 13 }}>(no parts)</div>
        ) : (
          message.parts
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((p) => <PartBlock key={p.id} part={p} />)
        )}
      </div>
    </Card>
  );
}

function PartBlock({ part }: { part: ConversationMessagePart }) {
  const label = <Badge tone="muted">{part.type}</Badge>;
  const preStyle = {
    margin: 0,
    padding: 10,
    background: "var(--bg-inset)",
    borderRadius: 6,
    fontSize: 12,
    fontFamily: "var(--font-mono)",
    overflowX: "auto" as const,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  };

  if (part.type === "user_prompt" || part.type === "text") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {label}
        <div style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>{part.content ?? ""}</div>
      </div>
    );
  }

  if (part.type === "tool_call") {
    const args = (part.metadata as { arguments?: unknown } | null)?.arguments;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {label}
        <pre style={preStyle}>{JSON.stringify(args ?? part.metadata ?? {}, null, 2)}</pre>
      </div>
    );
  }

  if (part.type === "tool_result") {
    return (
      <details>
        <summary style={{ cursor: "pointer", fontSize: 13 }}>
          <Badge tone="muted">{part.type}</Badge>
        </summary>
        <pre style={{ ...preStyle, marginTop: 6 }}>
          {part.content ?? JSON.stringify(part.metadata ?? {}, null, 2)}
        </pre>
      </details>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {label}
      <pre style={preStyle}>
        {JSON.stringify({ content: part.content, metadata: part.metadata }, null, 2)}
      </pre>
    </div>
  );
}
