import type { CSSProperties } from "react";
import type { AgentStats, DashboardStats } from "../api/types";
import { Badge, type BadgeTone } from "../components/atoms/Badge";
import { Card } from "../components/atoms/Card";
import { Spinner } from "../components/atoms/Spinner";
import { AlertIcon } from "../components/atoms/icons";
import { StatCard } from "../components/molecules/StatCard";
import { useAdminData } from "../hooks/useAdminData";

const SECTION_HEADING: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginTop: 0,
  marginBottom: 12,
  color: "var(--fg-default)",
};

export function DashboardPage() {
  const { data, loading, error } = useAdminData<DashboardStats>("/admin/dashboard");

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  const totalInputTokens = data.agents.reduce((sum, a) => sum + a.totalInputTokens, 0);
  const totalOutputTokens = data.agents.reduce((sum, a) => sum + a.totalOutputTokens, 0);
  const hasAgents = data.agents.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Dashboard</h1>

      <section>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 16,
          }}
        >
          <StatCard label="Active Agents" value={data.activeAgentCount} color="var(--accent)" />
          <StatCard
            label="Conversations"
            value={data.activeConversationCount}
            color="var(--accent)"
          />
          <StatCard label="Tokens In" value={totalInputTokens.toLocaleString()} />
          <StatCard label="Tokens Out" value={totalOutputTokens.toLocaleString()} />
          <StatCard label="Tool Calls" value={data.totalToolCalls} />
          <StatCard
            label="Errors"
            value={data.totalErrors}
            color={data.totalErrors > 0 ? "var(--red)" : "var(--green)"}
          />
        </div>
      </section>

      <section>
        <h2 style={SECTION_HEADING}>Agents</h2>
        {hasAgents ? <AgentList agents={data.agents} /> : <EmptyAgents />}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    <output
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: "48px 16px",
        color: "var(--fg-muted)",
        fontSize: 13,
      }}
    >
      <Spinner size={16} />
      <span>Loading dashboard…</span>
    </output>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Dashboard</h1>
      <div
        role="alert"
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          background: "rgba(248, 81, 73, 0.08)",
          border: "1px solid var(--red)",
          borderRadius: 8,
          padding: "12px 14px",
          color: "var(--red)",
          fontSize: 13,
        }}
      >
        <AlertIcon size={16} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 600 }}>Failed to load dashboard</span>
          <span style={{ color: "var(--fg-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            {message}
          </span>
        </div>
      </div>
    </div>
  );
}

function EmptyAgents() {
  return (
    <Card>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          padding: "24px 16px",
          color: "var(--fg-muted)",
          fontSize: 13,
          textAlign: "center",
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--fg-default)" }}>No agents have run yet</span>
        <span style={{ color: "var(--fg-subtle)" }}>
          Start an agent to see its activity and token usage here.
        </span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Agent list
// ---------------------------------------------------------------------------

function AgentList({ agents }: { agents: AgentStats[] }) {
  return (
    <Card padded={false}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {agents.map((agent, i) => (
          <li
            key={agent.agentName}
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 10,
              padding: "12px 16px",
              borderTop: i === 0 ? "none" : "1px solid var(--border-muted)",
            }}
          >
            <Badge tone="emerald" variant="outline">
              {agent.agentName}
            </Badge>
            <Badge tone={statusTone(agent.status)} variant="outline">
              {agent.status}
            </Badge>
            <div
              style={{
                marginLeft: "auto",
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                justifyContent: "flex-end",
              }}
            >
              <Badge tone="muted" title={`${agent.totalInputTokens.toLocaleString()} input tokens`}>
                {agent.totalInputTokens.toLocaleString()} in
              </Badge>
              <Badge
                tone="muted"
                title={`${agent.totalOutputTokens.toLocaleString()} output tokens`}
              >
                {agent.totalOutputTokens.toLocaleString()} out
              </Badge>
              <Badge tone="muted" title={`${agent.totalToolCalls} tool calls`}>
                {agent.totalToolCalls} tools
              </Badge>
              {agent.totalErrors > 0 && (
                <Badge tone="red" title={`${agent.totalErrors} errors`}>
                  {agent.totalErrors} err
                </Badge>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function statusTone(status: AgentStats["status"]): BadgeTone {
  switch (status) {
    case "running":
      return "green";
    case "idle":
      return "yellow";
    case "error":
      return "red";
    case "completed":
      return "neutral";
    default:
      return "neutral";
  }
}
