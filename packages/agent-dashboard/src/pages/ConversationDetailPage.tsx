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
import { AsyncState } from "../components/kit/AsyncState";
import { JsonBlock } from "../components/kit/JsonBlock";
import { formatDuration, statusTone } from "../lib/format";

type MessageWithParts = ConversationMessage & { parts: ConversationMessagePart[] };

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
      <AsyncState kind="error" error={{ title: "Failed to load conversation", message: error }} />
    );
  }

  if (!detail || !messages) {
    return <AsyncState kind="loading" loading="Loading conversation..." />;
  }

  const duration = formatDuration(detail.startedAt, detail.completedAt);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Link
          to="/conversations"
          style={{ color: "var(--mute)", fontSize: 13, textDecoration: "none" }}
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
          <Badge tone="ok" variant="outline">
            {detail.agentName}
          </Badge>
          <Badge tone="mute">{detail.model}</Badge>
          <Badge tone={statusTone(detail.status)}>{detail.status}</Badge>
          <Badge tone="mute">{detail.messageCount} msgs</Badge>
          <Badge tone="mute">{detail.tokenCount.toLocaleString()} tokens</Badge>
          {duration && <Badge tone="mute">{duration}</Badge>}
        </div>
        {detail.error && (
          <div
            role="alert"
            style={{
              marginTop: 12,
              padding: "8px 12px",
              borderRadius: "var(--radius-sm)",
              background: "var(--err-soft)",
              border: "1px solid var(--err)",
              color: "var(--err)",
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
          <Card style={{ textAlign: "center", padding: 40, color: "var(--mute)" }}>
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
  const kindTone: BadgeTone = message.kind === "request" ? "accent" : "violet";
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
        <span style={{ color: "var(--ink-3)", fontSize: 12 }}>
          {new Date(message.createdAt).toLocaleString()}
        </span>
        {message.kind === "response" && (
          <Badge tone="mute" title="input / output tokens">
            {message.inputTokens} in / {message.outputTokens} out
          </Badge>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {message.parts.length === 0 ? (
          <div style={{ color: "var(--ink-3)", fontSize: 13 }}>(no parts)</div>
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
  const label = <Badge tone="mute">{part.type}</Badge>;

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
        <JsonBlock value={args ?? part.metadata ?? {}} />
      </div>
    );
  }

  if (part.type === "tool_result") {
    return (
      <details>
        <summary style={{ cursor: "pointer", fontSize: 13 }}>{label}</summary>
        <div style={{ marginTop: 6 }}>
          {part.content ? (
            <JsonBlock value={part.content} raw />
          ) : (
            <JsonBlock value={part.metadata ?? {}} />
          )}
        </div>
      </details>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {label}
      <JsonBlock value={{ content: part.content, metadata: part.metadata }} />
    </div>
  );
}
