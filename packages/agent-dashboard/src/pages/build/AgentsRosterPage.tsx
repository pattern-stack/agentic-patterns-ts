/**
 * /agents — the Agents roster (list view, docs §6). Situated instances: each
 * agent is a role tuned by background, awareness, and mission. GROUPED BY ROLE
 * (the framework's parent-of-agent) into collapsible sections so a large roster
 * scans as a handful of roles rather than N sprawling cards; expand a role to
 * see its situated instances. Cards link INTO the Agent lens (/agents/:id); the
 * role chip forks up to the Role door.
 */

import { useMemo, useState } from "react";
import { type NavigateFunction, useNavigate } from "react-router-dom";
import type { RosterAgent } from "../../api/composition";
import { Card } from "../../components/atoms/Card";
import { Chip } from "../../components/atoms/Chip";
import { Spinner } from "../../components/atoms/Spinner";
import { DetailPageShell } from "../../components/organisms/DetailPageShell";
import { useAdminData } from "../../hooks/useAdminData";

export function AgentsRosterPage() {
  const navigate = useNavigate();
  const { data, loading, error } = useAdminData<RosterAgent[]>("/agents", 0);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const byRole = new Map<string, RosterAgent[]>();
    for (const a of data ?? []) {
      const key = a.role?.name ?? "No role";
      const list = byRole.get(key);
      if (list) list.push(a);
      else byRole.set(key, [a]);
    }
    return [...byRole.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  const toggle = (role: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });

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
        {data.length} situated instance{data.length === 1 ? "" : "s"} across {groups.length} role
        {groups.length === 1 ? "" : "s"} — click a role to see its agents.
      </div>

      {groups.length === 0 ? (
        <Card style={{ color: "var(--fg-subtle)" }}>No agents registered.</Card>
      ) : (
        groups.map(([role, agents]) => {
          const isOpen = open.has(role);
          const notReady = agents.filter((a) => !a.readiness.ready).length;
          return (
            <Card key={role} padded={false} style={{ overflow: "hidden" }}>
              <button
                type="button"
                onClick={() => toggle(role)}
                aria-expanded={isOpen}
                style={{
                  all: "unset",
                  boxSizing: "border-box",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "14px 16px",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    display: "inline-block",
                    transform: isOpen ? "rotate(90deg)" : "none",
                    transition: "transform 0.15s ease",
                    color: "var(--fg-muted)",
                    fontSize: 11,
                  }}
                >
                  ▶
                </span>
                <span style={{ fontWeight: 600, color: "var(--fg-default)" }}>{role}</span>
                <Chip tone="neutral">
                  {agents.length} agent{agents.length === 1 ? "" : "s"}
                </Chip>
                {notReady > 0 && <Chip tone="warn">{notReady} not ready</Chip>}
              </button>

              {isOpen && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    padding: "0 16px 16px",
                  }}
                >
                  {agents.map((a) => (
                    <AgentCard key={a.id} agent={a} navigate={navigate} />
                  ))}
                </div>
              )}
            </Card>
          );
        })
      )}
    </DetailPageShell>
  );
}

function AgentCard({ agent: a, navigate }: { agent: RosterAgent; navigate: NavigateFunction }) {
  return (
    <Card
      onClick={() => navigate(`/agents/${a.id}`)}
      style={{ cursor: "pointer", background: "var(--bg-subtle, transparent)" }}
    >
      <div style={{ fontWeight: 600, color: "var(--fg-default)" }}>{a.name}</div>
      {a.description && (
        <div style={{ marginTop: 6, fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.5 }}>
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
            style={{ all: "unset", cursor: "pointer", display: "inline-flex" }}
          >
            <Chip tone="accent">role · {a.role.name}</Chip>
          </button>
        )}
        {a.readiness.ready ? (
          <Chip tone="neutral">
            <span
              aria-hidden
              style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)" }}
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
  );
}
