/**
 * /agents/:id — the Agent lens (instance-centric detail, docs §3). Owns the
 * instantiation delta (background/awareness/mission/model — what makes THIS
 * agent this agent), the coherence check, and the delivered prompt with
 * per-section source attribution. The role's slot stack is shown but framed as
 * inherited identity, linking up to the Role door — NOT re-owned here.
 */

import { useParams } from "react-router-dom";
import type { AgentComposition } from "../../api/composition";
import { Card } from "../../components/atoms/Card";
import { Chip } from "../../components/atoms/Chip";
import { Spinner } from "../../components/atoms/Spinner";
import { DetailPageShell, Labeled } from "../../components/organisms/DetailPageShell";
import { CoherenceNotice, RenderedPromptView } from "../../components/organisms/RenderedPromptView";
import { SlotStack } from "../../components/organisms/SlotStack";
import { useAdminData } from "../../hooks/useAdminData";

function DataBlock({ label, value }: { label: string; value: Record<string, unknown> | null }) {
  const empty = !value || Object.keys(value).length === 0;
  return (
    <Labeled label={label}>
      {empty ? (
        <span style={{ fontSize: 13, color: "var(--fg-subtle)" }}>— none —</span>
      ) : (
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
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </Labeled>
  );
}

export function AgentLensPage() {
  const { id = "" } = useParams();
  const { data, loading, error } = useAdminData<AgentComposition>(
    `/agents/${encodeURIComponent(id)}/composition`,
    0,
  );

  if (loading) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Agents", to: "/agents" }, { label: id }]}>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            color: "var(--fg-muted)",
            padding: 40,
          }}
        >
          <Spinner /> Loading composition…
        </div>
      </DetailPageShell>
    );
  }
  if (error || !data) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Agents", to: "/agents" }, { label: id }]}>
        <Card style={{ borderColor: "var(--err)", color: "var(--err)" }}>
          {error ?? "Agent not found."}
        </Card>
      </DetailPageShell>
    );
  }

  const modelLabel = data.instance.modelOverride ?? data.model ?? data.role.defaultModel;
  const isOverride = data.instance.modelOverride != null;

  return (
    <DetailPageShell
      breadcrumb={[{ label: "Agents", to: "/agents" }, { label: data.name }]}
      center={
        <>
          {data.role.name && <Chip tone="accent">role · {data.role.name}</Chip>}
          <Chip tone="mono" title={isOverride ? "instance override" : "role default"}>
            {modelLabel}
          </Chip>
        </>
      }
      maxWidth={1080}
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

      {/* two columns: instance delta (owned here) | inherited identity + prompt */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 5fr) minmax(0, 7fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card>
            <div style={{ fontWeight: 600, marginBottom: 12, color: "var(--fg-default)" }}>
              Instantiation delta
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Labeled label="Model">
                <Chip tone="mono">{modelLabel}</Chip>{" "}
                <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
                  {isOverride ? "instance override" : "inherited from role"}
                </span>
              </Labeled>
              <DataBlock label="Background — what it knows" value={data.instance.background} />
              <DataBlock label="Awareness — what it can know" value={data.instance.awareness} />
              <DataBlock label="Mission" value={data.instance.mission} />
            </div>
          </Card>

          <Card>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ fontWeight: 600, color: "var(--fg-default)" }}>Coherence</span>
              {data.coherence.heuristic && <Chip tone="neutral">heuristic</Chip>}
            </div>
            <CoherenceNotice warnings={data.coherence.warnings} />
          </Card>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <RenderedPromptView sections={data.prompt.sections} renderPath={data.prompt.renderPath} />

          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
              <span style={{ fontWeight: 600, color: "var(--fg-default)" }}>
                Inherited identity
              </span>
              <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
                from role · {data.role.name}
              </span>
            </div>
            <SlotStack
              persona={data.role.persona}
              judgments={data.role.judgments}
              responsibilities={data.role.responsibilities}
              capabilities={data.role.capabilities}
            />
          </div>
        </div>
      </div>
    </DetailPageShell>
  );
}
