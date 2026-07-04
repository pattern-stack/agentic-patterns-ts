/**
 * ChatPage — pick a registered agent, converse with it over the framework SSE
 * transport, rendered through the ported cockpit chat organism.
 *
 * Fetches the agent registry from /agents, lets the operator pick one, and
 * renders the cockpit <ChatPanel> driven by the rewired useChat (Phase B). The
 * chat subtree is wrapped in `.chat-route` so the cockpit design tokens resolve
 * locally (see pages/chat-route.css) without a global theme.css port.
 */

import { useEffect, useMemo, useState } from "react";
import { type AgentSummary, listAgents } from "../api/chat-client";
import { ChatPanel, useChat } from "../chat";
import "./chat-route.css";
import { AgentUniverse } from "../components/AgentUniverse";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Spinner } from "../components/atoms/Spinner";

export function ChatPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [maxIterations, setMaxIterations] = useState(10); // matches the runner default
  const [railOpen, setRailOpen] = useState(true);

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

  const chat = useChat(selectedId, { maxIterations });
  const exchangeCount = useMemo(
    () => chat.messages.filter((m) => m.role === "user").length,
    [chat.messages],
  );

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
        exchangeCount={exchangeCount}
        streaming={chat.streaming}
        loadError={loadError}
        chatError={chat.error}
        description={selected?.description}
        maxIterations={maxIterations}
        onMaxIterations={setMaxIterations}
      />
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 16 }}>
        <div className="chat-route" style={{ flex: 1, minWidth: 0 }}>
          <ChatPanel
            messages={chat.messages}
            fill
            streaming={chat.streaming}
            assistantName={selected?.name ?? "agent"}
            onSend={chat.send}
            onAbort={chat.abort}
            disabled={!selected}
            emptyLabel={
              selected ? "No messages yet — say hello." : "Select an agent to start chatting."
            }
            placeholder={
              selected ? `Message ${selected.name}…` : "Select an agent to start chatting."
            }
          />
        </div>
        <div style={{ display: "flex", alignItems: "stretch", flex: "none" }}>
          <button
            type="button"
            onClick={() => setRailOpen((v) => !v)}
            title={railOpen ? "Collapse panel" : "Show panel"}
            aria-label={railOpen ? "Collapse panel" : "Show panel"}
            style={{
              flex: "none",
              width: 20,
              border: "1px solid var(--border)",
              borderRight: railOpen ? "none" : "1px solid var(--border)",
              borderRadius: railOpen ? "8px 0 0 8px" : 8,
              background: "var(--bg-surface)",
              color: "var(--fg-muted)",
              cursor: "pointer",
              fontSize: 12,
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {railOpen ? "›" : "‹"}
          </button>
          {railOpen && <AgentUniverse agentId={selectedId} />}
        </div>
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
  exchangeCount: number;
  streaming: boolean;
  loadError: string | null;
  chatError: string | null;
  description?: string;
  maxIterations: number;
  onMaxIterations: (n: number) => void;
}

function Header({
  agents,
  selectedId,
  onSelect,
  onNewChat,
  conversationId,
  exchangeCount,
  streaming,
  loadError,
  chatError,
  description,
  maxIterations,
  onMaxIterations,
}: HeaderProps) {
  const selected = agents.find((a) => a.id === selectedId);
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
        <label
          title="Cap the agent's tool-loop iterations for each message (the runner stops after this many)."
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--fg-muted)",
          }}
        >
          max tool calls
          <input
            type="number"
            min={1}
            max={50}
            value={maxIterations}
            onChange={(e) =>
              onMaxIterations(Math.min(50, Math.max(1, Math.trunc(Number(e.target.value)) || 1)))
            }
            style={{
              width: 56,
              fontFamily: "inherit",
              fontSize: 13,
              background: "var(--bg-inset)",
              color: "var(--fg-default)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 8px",
            }}
          />
        </label>
        <div style={{ flex: 1 }} />
        {selected && (
          <Badge tone="emerald" variant="outline">
            agent: {selected.name}
          </Badge>
        )}
        {exchangeCount > 0 && (
          <Badge tone="muted" variant="outline">
            {exchangeCount} {exchangeCount === 1 ? "exchange" : "exchanges"}
          </Badge>
        )}
        {streaming && (
          <Badge tone="emerald" variant="outline">
            <Spinner size={9} color="var(--accent-emerald)" /> streaming
          </Badge>
        )}
        {conversationId && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--fg-subtle)",
            }}
          >
            {conversationId.slice(0, 8)}
          </span>
        )}
      </div>
      {description && <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{description}</div>}
      {loadError && (
        <div style={{ fontSize: 12, color: "var(--red)" }}>Failed to load agents: {loadError}</div>
      )}
      {chatError && (
        <div style={{ fontSize: 12, color: "var(--red)" }}>Stream error: {chatError}</div>
      )}
    </div>
  );
}
