/**
 * /agents/:id — the Agent lens (instance-centric detail, docs §3). Owns the
 * instantiation delta (background/awareness/mission/model — what makes THIS
 * agent this agent), the coherence check, and the delivered prompt with
 * per-section source attribution. The role's slot stack is shown but framed as
 * inherited identity, linking up to the Role door — NOT re-owned here.
 *
 * Two view modes when the registration ships an `instantiate` hook:
 *   declared  — the statically exported instance (GET …/composition)
 *   delivered — the instance an entrypoint would compose for a context
 *               (POST …/composition/delivered with e.g. { organizationId }),
 *               carrying the LIVE Background/prompt the model actually gets.
 */

import { useState } from "react";
import { useParams } from "react-router-dom";
import type { AgentComposition, DeliveredComposition } from "../../api/composition";
import { compositionApi } from "../../api/composition";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { Chip } from "../../components/atoms/Chip";
import { Spinner } from "../../components/atoms/Spinner";
import { Segmented } from "../../components/kit/Segmented";
import { DetailPageShell, Labeled } from "../../components/organisms/DetailPageShell";
import { CoherenceNotice, RenderedPromptView } from "../../components/organisms/RenderedPromptView";
import { SlotStack } from "../../components/organisms/SlotStack";
import { useAdminData } from "../../hooks/useAdminData";
import { AgentEvalsCard } from "./AgentEvalsCard";

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

type LensMode = "declared" | "delivered";

const LENS_MODE_OPTIONS: { value: LensMode; label: string; title: string }[] = [
  { value: "declared", label: "declared", title: "The statically exported instance" },
  {
    value: "delivered",
    label: "delivered",
    title: "The instance an entrypoint would compose for the context below",
  },
];

export function AgentLensPage() {
  const { id = "" } = useParams();
  const { data, loading, error } = useAdminData<AgentComposition>(
    `/agents/${encodeURIComponent(id)}/composition`,
    0,
  );

  // Delivered-instance state: the last composed payload, which view is shown,
  // and the context editor (null = untouched → prefilled from the defaults).
  const [delivered, setDelivered] = useState<DeliveredComposition | null>(null);
  const [mode, setMode] = useState<"declared" | "delivered">("declared");
  const [contextText, setContextText] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);

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

  const canInstantiate = data.instantiation?.available === true;
  const defaultsText = JSON.stringify(data.instantiation?.defaults ?? {}, null, 2);
  const editorText = contextText ?? defaultsText;

  // Everything below the hero renders from `view`: the delivered payload swaps
  // in the live Background/prompt (and the grounded role stack — a delivered
  // instance may carry extra judgments the declared one gates off).
  const view: AgentComposition = mode === "delivered" && delivered ? delivered : data;
  const showingDelivered = view !== data;

  const modelLabel = view.instance.modelOverride ?? view.model ?? view.role.defaultModel;
  const isOverride = view.instance.modelOverride != null;

  const compose = async () => {
    setComposing(true);
    setComposeError(null);
    try {
      let context: Record<string, unknown> | undefined;
      const trimmed = editorText.trim();
      if (trimmed.length > 0) {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("Context must be a JSON object");
        }
        context = parsed as Record<string, unknown>;
      }
      const result = await compositionApi.deliveredComposition(id, context);
      setDelivered(result);
      setMode("delivered");
    } catch (err) {
      setComposeError(err instanceof Error ? err.message : String(err));
    } finally {
      setComposing(false);
    }
  };

  return (
    <DetailPageShell
      breadcrumb={[{ label: "Agents", to: "/agents" }, { label: data.name }]}
      center={
        <>
          {data.role.name && <Chip tone="accent">role · {data.role.name}</Chip>}
          <Chip tone="mono" title={isOverride ? "instance override" : "role default"}>
            {modelLabel}
          </Chip>
          {showingDelivered && <Chip tone="warn">delivered · live</Chip>}
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
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 12,
              }}
            >
              <span style={{ fontWeight: 600, color: "var(--fg-default)", flex: 1 }}>
                Instantiation delta
              </span>
              {canInstantiate && (
                <Segmented<LensMode>
                  options={LENS_MODE_OPTIONS}
                  value={showingDelivered ? "delivered" : "declared"}
                  onChange={(next) => {
                    if (next === "declared") setMode("declared");
                    else if (delivered) setMode("delivered");
                    else compose();
                  }}
                  size="sm"
                  aria-label="Instance view"
                />
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Labeled label="Model">
                <Chip tone="mono">{modelLabel}</Chip>{" "}
                <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
                  {isOverride ? "instance override" : "inherited from role"}
                </span>
              </Labeled>
              <DataBlock label="Background — what it knows" value={view.instance.background} />
              <DataBlock label="Awareness — what it can know" value={view.instance.awareness} />
              <DataBlock label="Mission" value={view.instance.mission} />
            </div>
          </Card>

          {canInstantiate && (
            <Card>
              <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--fg-default)" }}>
                Delivered instance
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--fg-subtle)",
                  lineHeight: 1.5,
                  marginBottom: 10,
                }}
              >
                Compose the agent the way an entrypoint delivers it — the registration&apos;s
                <code style={{ fontFamily: "var(--font-mono)" }}> instantiate(context)</code> hook
                fetches the live Background for this context.
              </div>
              <textarea
                value={editorText}
                onChange={(e) => setContextText(e.target.value)}
                spellCheck={false}
                rows={Math.min(8, Math.max(3, editorText.split("\n").length))}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: "var(--fg-default)",
                  background: "var(--bg-inset)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: 8,
                  resize: "vertical",
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                <Button size="sm" onClick={compose} disabled={composing}>
                  {composing ? (
                    <>
                      <Spinner /> Composing…
                    </>
                  ) : (
                    "Compose delivered"
                  )}
                </Button>
                {delivered && !composing && (
                  <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
                    composed for {JSON.stringify(delivered.context)}
                  </span>
                )}
              </div>
              {composeError && (
                <div style={{ marginTop: 8, fontSize: 12, color: "var(--err)" }}>
                  {composeError}
                </div>
              )}
            </Card>
          )}

          {(data.evals?.length ?? 0) > 0 && (
            <AgentEvalsCard agentId={data.id} agentName={data.name} evals={data.evals ?? []} />
          )}

          <Card>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ fontWeight: 600, color: "var(--fg-default)" }}>Coherence</span>
              {view.coherence.heuristic && <Chip tone="neutral">heuristic</Chip>}
            </div>
            <CoherenceNotice warnings={view.coherence.warnings} />
          </Card>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <RenderedPromptView sections={view.prompt.sections} renderPath={view.prompt.renderPath} />

          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
              <span style={{ fontWeight: 600, color: "var(--fg-default)" }}>
                Inherited identity
              </span>
              <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
                from role · {view.role.name}
              </span>
            </div>
            <SlotStack
              persona={view.role.persona}
              judgments={view.role.judgments}
              responsibilities={view.role.responsibilities}
              capabilities={view.role.capabilities}
            />
          </div>
        </div>
      </div>
    </DetailPageShell>
  );
}
