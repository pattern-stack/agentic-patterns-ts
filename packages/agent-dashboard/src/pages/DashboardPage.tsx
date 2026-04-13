import type { DashboardStats } from "../api/types";
import { StatCard } from "../components/StatCard";
import { useAdminData } from "../hooks/useAdminData";

export function DashboardPage() {
  const { data, loading, error } = useAdminData<DashboardStats>("/admin/dashboard");

  if (loading) return <div style={{ color: "var(--text-secondary)" }}>Loading...</div>;
  if (error) return <div style={{ color: "var(--accent-red)" }}>Error: {error}</div>;
  if (!data) return null;

  const totalInputTokens = data.agents.reduce((sum, a) => sum + a.totalInputTokens, 0);
  const totalOutputTokens = data.agents.reduce((sum, a) => sum + a.totalOutputTokens, 0);

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Dashboard</h1>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 16,
          marginBottom: 32,
        }}
      >
        <StatCard label="Active Agents" value={data.activeAgentCount} color="var(--accent-blue)" />
        <StatCard
          label="Conversations"
          value={data.activeConversationCount}
          color="var(--accent-blue)"
        />
        <StatCard label="Tokens In" value={totalInputTokens.toLocaleString()} />
        <StatCard label="Tokens Out" value={totalOutputTokens.toLocaleString()} />
        <StatCard label="Tool Calls" value={data.totalToolCalls} />
        <StatCard
          label="Errors"
          value={data.totalErrors}
          color={data.totalErrors > 0 ? "var(--accent-red)" : "var(--accent-green)"}
        />
      </div>
    </div>
  );
}
