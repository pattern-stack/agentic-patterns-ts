/**
 * /agents — the Agents roster (list view, docs §6). Situated instances: each
 * row is a role tuned by background, awareness, and mission. Cards link INTO
 * the Agent lens (/agents/:id); the role chip forks up to the Role door.
 */

import { useNavigate } from "react-router-dom";
import type { RosterAgent } from "../../api/composition";
import { Card } from "../../components/atoms/Card";
import { Chip } from "../../components/atoms/Chip";
import { Spinner } from "../../components/atoms/Spinner";
import { DetailPageShell } from "../../components/organisms/DetailPageShell";
import { useAdminData } from "../../hooks/useAdminData";

export function AgentsRosterPage() {
  const navigate = useNavigate();
  const { data, loading, error } = useAdminData<RosterAgent[]>("/agents", 0);

  if (loading) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Agents" }]} maxWidth={960}>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            color: "var(--fg-muted)",
            padding: 40,
          }}
        >
          <Spinner /> Loading agents…
        </div>
      </DetailPageShell>
    );
  }
  if (error || !data) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Agents" }]} maxWidth={960}>
        <Card style={{ borderColor: "var(--err)", color: "var(--err)" }}>
          {error ?? "Agents not found."}
        </Card>
      </DetailPageShell>
    );
  }

  return (
    <DetailPageShell breadcrumb={[{ label: "Agents" }]} maxWidth={960}>
      <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
        Situated instances — each a role tuned by background, awareness, and mission.
      </div>

      {data.length === 0 ? (
        <Card style={{ color: "var(--fg-subtle)" }}>No agents registered.</Card>
      ) : (
        data.map((a) => (
          <Card
            key={a.id}
            onClick={() => navigate(`/agents/${a.id}`)}
            style={{ cursor: "pointer" }}
          >
            <div style={{ fontWeight: 600, color: "var(--fg-default)" }}>{a.name}</div>
            {a.description && (
              <div
                style={{ marginTop: 6, fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.5 }}
              >
                {a.description}
              </div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
              {a.role && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/roles/${a.role?.id}`);
                  }}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    display: "inline-flex",
                  }}
                >
                  <Chip tone="accent">role · {a.role.name}</Chip>
                </button>
              )}
              {a.readiness.ready ? (
                <Chip tone="neutral">
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--green)",
                    }}
                  />
                  ready
                </Chip>
              ) : (
                <Chip tone="warn" title={`Missing: ${a.readiness.missing.join(", ")}`}>
                  not ready
                </Chip>
              )}
            </div>
          </Card>
        ))
      )}
    </DetailPageShell>
  );
}
