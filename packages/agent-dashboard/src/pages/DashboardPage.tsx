import type { DashboardStats } from "../api/types";
import { StatCard } from "../components/StatCard";
import { useAdminData } from "../hooks/useAdminData";

export function DashboardPage() {
  const { data, loading, error } = useAdminData<DashboardStats>("/admin/dashboard");

  if (loading) return <div style={{ color: "var(--text-secondary)" }}>Loading...</div>;
  if (error) return <div style={{ color: "var(--accent-red)" }}>Error: {error}</div>;
  if (!data) return null;

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
        <StatCard label="Agents" value={data.agentCount} color="var(--accent-blue)" />
        <StatCard label="Conversations" value={data.conversationCount} color="var(--accent-blue)" />
        <StatCard label="Tokens In" value={data.totalPromptTokens.toLocaleString()} />
        <StatCard label="Tokens Out" value={data.totalCompletionTokens.toLocaleString()} />
        <StatCard
          label="Error Rate"
          value={`${(data.errorRate * 100).toFixed(1)}%`}
          color={data.errorRate > 0.05 ? "var(--accent-red)" : "var(--accent-green)"}
          subtitle={`${data.errorCount} total errors`}
        />
      </div>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Conversations by State</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
        }}
      >
        {Object.entries(data.conversationsByState).map(([state, count]) => (
          <StatCard key={state} label={state} value={count} />
        ))}
      </div>
    </div>
  );
}
