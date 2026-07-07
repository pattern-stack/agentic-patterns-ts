import type { AgentStats, DashboardStats } from "../api/types";
import { Badge } from "../components/atoms/Badge";
import { Card } from "../components/atoms/Card";
import { AsyncState } from "../components/kit/AsyncState";
import { PageHeader } from "../components/kit/PageHeader";
import { SectionHeading } from "../components/kit/SectionHeading";
import { Stat } from "../components/kit/Stat";
import { useAdminData } from "../hooks/useAdminData";
import { statusTone } from "../lib/format";

export function DashboardPage() {
  const { data, loading, error } = useAdminData<DashboardStats>("/admin/dashboard");

  if (loading) {
    return (
      <div>
        <PageHeader title="Dashboard" />
        <AsyncState kind="loading" loading="Loading dashboard…" />
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <PageHeader title="Dashboard" />
        <AsyncState kind="error" error={{ title: "Failed to load dashboard", message: error }} />
      </div>
    );
  }
  if (!data) return null;

  const totalInputTokens = data.agents.reduce((sum, a) => sum + a.totalInputTokens, 0);
  const totalOutputTokens = data.agents.reduce((sum, a) => sum + a.totalOutputTokens, 0);
  const hasAgents = data.agents.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <PageHeader title="Dashboard" />

      <section>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 16,
          }}
        >
          <Card>
            <Stat label="Active Agents" value={data.activeAgentCount} tone="accent" />
          </Card>
          <Card>
            <Stat label="Conversations" value={data.activeConversationCount} tone="accent" />
          </Card>
          <Card>
            <Stat label="Tokens In" value={totalInputTokens.toLocaleString()} />
          </Card>
          <Card>
            <Stat label="Tokens Out" value={totalOutputTokens.toLocaleString()} />
          </Card>
          <Card>
            <Stat label="Tool Calls" value={data.totalToolCalls} />
          </Card>
          <Card>
            <Stat
              label="Errors"
              value={data.totalErrors}
              tone={data.totalErrors > 0 ? "err" : "ok"}
            />
          </Card>
        </div>
      </section>

      <section>
        <SectionHeading eyebrow="Agents" />
        {hasAgents ? <AgentList agents={data.agents} /> : <EmptyAgents />}
      </section>
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
          color: "var(--mute)",
          fontSize: 13,
          textAlign: "center",
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--ink)" }}>No agents have run yet</span>
        <span style={{ color: "var(--ink-3)" }}>
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
              borderTop: i === 0 ? "none" : "1px solid var(--line-2)",
            }}
          >
            <Badge tone="ok" variant="outline">
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
              <Badge tone="mute" title={`${agent.totalInputTokens.toLocaleString()} input tokens`}>
                {agent.totalInputTokens.toLocaleString()} in
              </Badge>
              <Badge
                tone="mute"
                title={`${agent.totalOutputTokens.toLocaleString()} output tokens`}
              >
                {agent.totalOutputTokens.toLocaleString()} out
              </Badge>
              <Badge tone="mute" title={`${agent.totalToolCalls} tool calls`}>
                {agent.totalToolCalls} tools
              </Badge>
              {agent.totalErrors > 0 && (
                <Badge tone="err" title={`${agent.totalErrors} errors`}>
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
