/**
 * /roles and /roles/:id — the Roles door (identity catalog, docs §10). The
 * detail view is the IDENTITY door: it OWNS the slot stack (persona, judgments,
 * responsibilities, capabilities) and the instantiation matrix — the table of
 * every agent that instantiates this role, with its per-instance delta. The
 * `similarTo` row surfaces structurally-identical roles that are deliberately
 * NOT merged. Branches on the `:id` param: present → detail, absent → list.
 */

import type { ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { RoleDetail, RoleInstance, RoleSummary } from "../../api/composition";
import { Card } from "../../components/atoms/Card";
import { Chip } from "../../components/atoms/Chip";
import { Spinner } from "../../components/atoms/Spinner";
import { FamilyTabs } from "../../components/molecules/FamilyTabs";
import { DetailPageShell, Labeled } from "../../components/organisms/DetailPageShell";
import { SlotStack } from "../../components/organisms/SlotStack";
import { useAdminData } from "../../hooks/useAdminData";

export function RolesPage() {
  const { id } = useParams();
  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <FamilyTabs />
      </div>
      {id ? <RoleDetailView id={id} /> : <RoleListView />}
    </>
  );
}

// --------------------------------------------------------------------------
// List view — /roles
// --------------------------------------------------------------------------

function RoleListView() {
  const navigate = useNavigate();
  const { data, loading, error } = useAdminData<RoleSummary[]>("/roles", 0);

  if (loading) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Roles" }]}>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            color: "var(--ink-2)",
            padding: 40,
          }}
        >
          <Spinner /> Loading roles…
        </div>
      </DetailPageShell>
    );
  }
  if (error || !data) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Roles" }]}>
        <Card style={{ borderColor: "var(--err)", color: "var(--err)" }}>
          {error ?? "Roles not found."}
        </Card>
      </DetailPageShell>
    );
  }

  return (
    <DetailPageShell breadcrumb={[{ label: "Roles" }]}>
      {data.length === 0 ? (
        <Card style={{ color: "var(--ink-3)" }}>No roles discovered.</Card>
      ) : (
        data.map((r) => (
          <Card
            key={r.id}
            onClick={() => navigate(`/roles/${encodeURIComponent(r.id)}`)}
            style={{ cursor: "pointer" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600, color: "var(--ink)", fontSize: 15 }}>{r.name}</span>
              <Chip tone="mono">{r.defaultModel}</Chip>
              <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
                {r.agents.length} {r.agents.length === 1 ? "agent" : "agents"}
              </span>
              {r.similarTo.length > 0 && (
                <span style={{ marginLeft: "auto" }}>
                  <Chip tone="warn">{r.similarTo.length} similar</Chip>
                </span>
              )}
            </div>
          </Card>
        ))
      )}
    </DetailPageShell>
  );
}

// --------------------------------------------------------------------------
// Detail view — /roles/:id
// --------------------------------------------------------------------------

/** Compact cell for a per-instance delta field (background/awareness/mission). */
function MatrixCell({ children }: { children: ReactNode }) {
  return <span style={{ fontSize: 13, color: "var(--ink-2)" }}>{children}</span>;
}

function instanceRows(agents: RoleInstance[]) {
  return agents.map((a) => {
    const bgCount = a.background ? Object.keys(a.background).length : 0;
    const awareness = a.awareness;
    const domains = awareness ? (awareness.domains as unknown[] | undefined) : undefined;
    const domainCount = domains?.length ?? 0;
    const mission = a.mission;
    const objective = mission ? ((mission.objective as string | undefined) ?? "—") : "—";
    return {
      id: a.id,
      name: a.name,
      model: a.model ?? "—",
      background: bgCount > 0 ? `${bgCount} keys` : "—",
      awareness: domainCount > 0 ? `${domainCount} domains` : "—",
      mission: objective,
    };
  });
}

function InstantiationMatrix({ agents }: { agents: RoleInstance[] }) {
  const rows = instanceRows(agents);
  const headers = ["Agent", "Model", "Background", "Awareness", "Mission"];
  const headerCell = {
    padding: "8px 12px",
    textAlign: "left" as const,
    color: "var(--ink-3)",
    fontWeight: 600,
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    borderBottom: "1px solid var(--line-2)",
  };
  const bodyCell = {
    padding: "10px 12px",
    borderBottom: "1px solid var(--line-2)",
    fontSize: 13,
    verticalAlign: "top" as const,
  };

  return (
    <Card padded={false} style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} style={headerCell}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={headers.length}
                style={{ ...bodyCell, color: "var(--ink-3)", textAlign: "center" }}
              >
                No agents instantiate this role.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td style={bodyCell}>
                  <Link
                    to={`/agents/${encodeURIComponent(row.id)}`}
                    style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}
                  >
                    {row.name}
                  </Link>
                </td>
                <td style={bodyCell}>
                  <Chip tone="mono">{row.model}</Chip>
                </td>
                <td style={bodyCell}>
                  <MatrixCell>{row.background}</MatrixCell>
                </td>
                <td style={bodyCell}>
                  <MatrixCell>{row.awareness}</MatrixCell>
                </td>
                <td style={bodyCell}>
                  <MatrixCell>{row.mission}</MatrixCell>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Card>
  );
}

function RoleDetailView({ id }: { id: string }) {
  const { data, loading, error } = useAdminData<RoleDetail>(`/roles/${encodeURIComponent(id)}`, 0);

  if (loading) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Roles", to: "/roles" }, { label: id }]}>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            color: "var(--ink-2)",
            padding: 40,
          }}
        >
          <Spinner /> Loading role…
        </div>
      </DetailPageShell>
    );
  }
  if (error || !data) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Roles", to: "/roles" }, { label: id }]}>
        <Card style={{ borderColor: "var(--err)", color: "var(--err)" }}>
          {error ?? "Role not found."}
        </Card>
      </DetailPageShell>
    );
  }

  return (
    <DetailPageShell
      breadcrumb={[{ label: "Roles", to: "/roles" }, { label: data.name }]}
      center={<Chip tone="mono">{data.defaultModel}</Chip>}
      maxWidth={1080}
    >
      {/* hero */}
      <Card>
        <div
          style={{
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "var(--ink)",
          }}
        >
          {data.name}
        </div>
        {data.similarTo.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {data.similarTo.map((sid) => (
                <Link
                  key={sid}
                  to={`/roles/${encodeURIComponent(sid)}`}
                  style={{ textDecoration: "none" }}
                >
                  <Chip tone="warn">{sid}</Chip>
                </Link>
              ))}
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-3)" }}>
              structurally similar — not merged (see docs §10)
            </div>
          </div>
        )}
      </Card>

      {/* slot stack — owned here */}
      <div>
        <div style={{ fontWeight: 600, marginBottom: 12, color: "var(--ink)" }}>Slot stack</div>
        <SlotStack
          persona={data.persona}
          judgments={data.judgments}
          responsibilities={data.responsibilities}
          capabilities={data.capabilities}
        />
      </div>

      {/* instantiation matrix — the whole point of the Role door */}
      <Labeled label="Instantiation matrix">
        <InstantiationMatrix agents={data.agents} />
      </Labeled>
    </DetailPageShell>
  );
}
