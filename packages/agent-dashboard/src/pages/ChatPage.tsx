/**
 * ChatPage — pick a registered agent, converse with it over SSE.
 *
 * Fetches the agent registry from /agents, lets the operator pick one,
 * and renders ChatPanel wired to useChat.
 */

import { useEffect, useMemo, useState } from "react";
import { type AgentSummary, listAgents } from "../api/chat-client";
import { Button } from "../components/atoms/Button";
import { ChatPanel } from "../components/organisms/ChatPanel";
import { useChat } from "../hooks/useChat";

export function ChatPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAgents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
        setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load agents");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const chat = useChat(selected);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        height: "calc(100vh - 48px)",
        minHeight: 0,
      }}
    >
      <Header
        agents={agents}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          chat.reset();
        }}
        onNewChat={chat.reset}
        conversationId={chat.conversationId}
        loadError={loadError}
        description={selected?.description}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatPanel
          messages={chat.messages}
          streaming={chat.streaming}
          error={chat.error}
          onSend={chat.send}
          disabled={!selected}
          placeholder={
            selected ? `Message ${selected.name}…` : "Select an agent to start chatting."
          }
        />
      </div>
    </div>
  );
}

interface HeaderProps {
  agents: AgentSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  conversationId: string | null;
  loadError: string | null;
  description?: string;
}

function Header({
  agents,
  selectedId,
  onSelect,
  onNewChat,
  conversationId,
  loadError,
  description,
}: HeaderProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Chat</h1>
        <select
          value={selectedId ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          disabled={!agents.length}
          style={{
            fontFamily: "inherit",
            fontSize: 13,
            background: "var(--bg-inset)",
            color: "var(--fg-default)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "6px 10px",
            minWidth: 200,
          }}
        >
          {agents.length === 0 && <option value="">No agents registered</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="sm" onClick={onNewChat} disabled={!conversationId}>
          New Chat
        </Button>
        {conversationId && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--fg-subtle)",
            }}
          >
            conversation {conversationId.slice(0, 8)}
          </span>
        )}
      </div>
      {description && <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{description}</div>}
      {loadError && (
        <div style={{ fontSize: 12, color: "var(--red)" }}>Failed to load agents: {loadError}</div>
      )}
    </div>
  );
}
