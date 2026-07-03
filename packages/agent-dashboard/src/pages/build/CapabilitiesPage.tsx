/**
 * /capabilities and /capabilities/:id — the Capabilities door (docs §3, the
 * SUBSTRATE). The list is the catalog of shared toolbox+manual+playbook bundles;
 * the detail OWNS the tool schemas and the used-by up-chain (which roles and
 * agents depend on this capability), linking upward to the Role and Agent doors.
 */

import type { ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { CapabilityDetail, CapabilitySummary, ToolDef } from "../../api/composition";
import { Card } from "../../components/atoms/Card";
import { Chip, ProvenanceChip } from "../../components/atoms/Chip";
import { Spinner } from "../../components/atoms/Spinner";
import { DetailPageShell, Labeled } from "../../components/organisms/DetailPageShell";
import { useAdminData } from "../../hooks/useAdminData";

// --------------------------------------------------------------------------
// List view
// --------------------------------------------------------------------------

function CapabilitiesList() {
  const navigate = useNavigate();
  const { data, loading, error } = useAdminData<CapabilitySummary[]>("/capabilities", 0);

  if (loading) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Capabilities" }]}>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            color: "var(--fg-muted)",
            padding: 40,
          }}
        >
          <Spinner /> Loading capabilities…
        </div>
      </DetailPageShell>
    );
  }
  if (error || !data) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Capabilities" }]}>
        <Card style={{ borderColor: "var(--err)", color: "var(--err)" }}>
          {error ?? "Capabilities not found."}
        </Card>
      </DetailPageShell>
    );
  }

  return (
    <DetailPageShell breadcrumb={[{ label: "Capabilities" }]}>
      {data.length === 0 ? (
        <Card>
          <span style={{ fontSize: 13, color: "var(--fg-subtle)" }}>
            No capabilities discovered.
          </span>
        </Card>
      ) : (
        data.map((c) => (
          <Card
            key={c.id}
            onClick={() => navigate(`/capabilities/${encodeURIComponent(c.id)}`)}
            style={{ cursor: "pointer" }}
          >
            <div style={{ fontWeight: 600, color: "var(--fg-default)" }}>{c.name}</div>
            {c.description && (
              <div
                style={{
                  marginTop: 6,
                  fontSize: 14,
                  color: "var(--fg-muted)",
                  lineHeight: 1.5,
                }}
              >
                {c.description}
              </div>
            )}
            <div
              style={{
                marginTop: 12,
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Chip tone="mono">{c.toolbox.name}</Chip>
              <Chip tone="neutral">{c.toolbox.toolCount} tools</Chip>
              {c.sharesToolboxWith.length > 0 && <Chip tone="neutral">shares toolbox</Chip>}
              <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
                used by {c.usedBy.roles.length} roles · {c.usedBy.agents.length} agents
              </span>
            </div>
          </Card>
        ))
      )}
    </DetailPageShell>
  );
}

// --------------------------------------------------------------------------
// Detail view — tool schemas
// --------------------------------------------------------------------------

interface SchemaProp {
  type?: string;
  description?: string;
}

const mono = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fz-tiny, 12px)",
} as const;

function SchemaObject({ schema }: { schema: Record<string, unknown> }) {
  const props = (schema.properties ?? {}) as Record<string, SchemaProp>;
  const names = Object.keys(props);
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  if (names.length === 0) {
    return <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>no parameters</span>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {names.map((name) => {
        const p = props[name] ?? {};
        return (
          <div
            key={name}
            style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8 }}
          >
            <span style={{ ...mono, color: "var(--fg-default)", fontWeight: 600 }}>{name}</span>
            <span style={{ ...mono, color: "var(--fg-muted)" }}>{p.type ?? "unknown"}</span>
            {required.includes(name) && <Chip tone="warn">required</Chip>}
            {p.description && (
              <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>{p.description}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolDef }) {
  return (
    <Card inset>
      <div style={{ ...mono, color: "var(--fg-default)", fontWeight: 600 }}>{tool.name}</div>
      {tool.description && (
        <div style={{ marginTop: 4, fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.5 }}>
          {tool.description}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <Labeled label="Parameters">
          <SchemaObject schema={tool.parameters} />
        </Labeled>
      </div>
      {tool.returns && (
        <div style={{ marginTop: 12 }}>
          <Labeled label="Returns">
            <SchemaObject schema={tool.returns} />
          </Labeled>
        </div>
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 10, color: "var(--fg-default)" }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
    </div>
  );
}

function CapabilityDetailView({ id }: { id: string }) {
  const { data, loading, error } = useAdminData<CapabilityDetail>(
    `/capabilities/${encodeURIComponent(id)}`,
    0,
  );

  if (loading) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Capabilities", to: "/capabilities" }, { label: id }]}>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            color: "var(--fg-muted)",
            padding: 40,
          }}
        >
          <Spinner /> Loading capability…
        </div>
      </DetailPageShell>
    );
  }
  if (error || !data) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Capabilities", to: "/capabilities" }, { label: id }]}>
        <Card style={{ borderColor: "var(--err)", color: "var(--err)" }}>
          {error ?? "Capability not found."}
        </Card>
      </DetailPageShell>
    );
  }

  const plays = data.playbook?.plays ?? [];

  return (
    <DetailPageShell
      breadcrumb={[{ label: "Capabilities", to: "/capabilities" }, { label: data.name }]}
      center={
        <>
          <Chip tone="mono">{data.toolbox.name}</Chip>
          {data.provenance && (
            <ProvenanceChip tier={data.provenance.tier} sourcePath={data.provenance.sourcePath} />
          )}
        </>
      }
    >
      {/* hero */}
      <Card>
        <div
          style={{
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "var(--fg-default)",
          }}
        >
          {data.name}
        </div>
        {data.description && (
          <div style={{ marginTop: 6, fontSize: 14, color: "var(--fg-muted)", lineHeight: 1.5 }}>
            {data.description}
          </div>
        )}
      </Card>

      {/* tool schemas — owned here */}
      <Section title="Tools">
        {data.toolbox.tools.length === 0 ? (
          <span style={{ fontSize: 13, color: "var(--fg-subtle)" }}>No tools.</span>
        ) : (
          data.toolbox.tools.map((tool) => <ToolCard key={tool.name} tool={tool} />)
        )}
      </Section>

      {/* manual */}
      {data.manual && (
        <Card>
          <Labeled label="Manual">
            <pre
              style={{
                margin: 0,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--fg-muted)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {data.manual.text}
            </pre>
          </Labeled>
        </Card>
      )}

      {/* playbook */}
      {data.playbook && plays.length > 0 && (
        <Card>
          <Labeled label="Plays">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {plays.map((play) => (
                <Chip key={play} tone="neutral">
                  {play}
                </Chip>
              ))}
            </div>
          </Labeled>
        </Card>
      )}

      {/* used-by up-chain */}
      <Card>
        <Labeled label="Used by">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>Roles</span>
              {data.usedBy.roles.length === 0 ? (
                <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>— none —</span>
              ) : (
                data.usedBy.roles.map((roleId) => (
                  <Link
                    key={roleId}
                    to={`/roles/${encodeURIComponent(roleId)}`}
                    style={{ textDecoration: "none" }}
                  >
                    <Chip tone="accent">{roleId}</Chip>
                  </Link>
                ))
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>Agents</span>
              {data.usedBy.agents.length === 0 ? (
                <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>— none —</span>
              ) : (
                data.usedBy.agents.map((agentId) => (
                  <Link
                    key={agentId}
                    to={`/agents/${encodeURIComponent(agentId)}`}
                    style={{ textDecoration: "none" }}
                  >
                    <Chip tone="neutral">{agentId}</Chip>
                  </Link>
                ))
              )}
            </div>
            {data.sharesToolboxWith.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>Shares toolbox with</span>
                {data.sharesToolboxWith.map((capId) => (
                  <Link
                    key={capId}
                    to={`/capabilities/${encodeURIComponent(capId)}`}
                    style={{ textDecoration: "none" }}
                  >
                    <Chip tone="mono">{capId}</Chip>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </Labeled>
      </Card>
    </DetailPageShell>
  );
}

// --------------------------------------------------------------------------
// Router entry — branch on :id
// --------------------------------------------------------------------------

export function CapabilitiesPage() {
  const { id } = useParams();
  return id ? <CapabilityDetailView id={id} /> : <CapabilitiesList />;
}
