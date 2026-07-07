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

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { AgentComposition, DeliveredComposition } from "../../api/composition";
import { compositionApi } from "../../api/composition";
import type { RunRow, RunSummary } from "../../api/types";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { Chip } from "../../components/atoms/Chip";
import { Spinner } from "../../components/atoms/Spinner";
import { AsyncState } from "../../components/kit/AsyncState";
import { inputStyle } from "../../components/kit/Field";
import { JsonBlock } from "../../components/kit/JsonBlock";
import { Segmented } from "../../components/kit/Segmented";
import { HonestyBanner } from "../../components/molecules/HonestyBanner";
import { DetailPageShell, Labeled } from "../../components/organisms/DetailPageShell";
import { CoherenceNotice, RenderedPromptView } from "../../components/organisms/RenderedPromptView";
import { SlotStack } from "../../components/organisms/SlotStack";
import { TraceLog } from "../../components/organisms/TraceLog";
import { TraceWaterfall } from "../../components/organisms/TraceWaterfall";
import { buildToolIndex } from "../../graph/composition";
import { SAMPLE_EVENTS, SAMPLE_REQUEST } from "../../graph/sample-run-trace";
import { eventsToSteps, persistedToEventLike } from "../../graph/trace-from-events";
import type { TraceStep } from "../../graph/types";
import { useAdminData } from "../../hooks/useAdminData";
import { relTime, shortId } from "../../lib/format";
import { sortRunsNewestFirst } from "../../lib/runPicker";
import { fetchRun, fetchRunEvents, fetchRuns } from "../../lib/runsApi";
import { T } from "../../ui/tokens";
import { AgentEvalsCard } from "./AgentEvalsCard";

/** Honest degradation (port-map §6, mirrors `RunSurfacePage`'s "request not
 *  persisted" note): neither `RunSummary` nor `RunRow` carries the user's
 *  original request text on this runtime version. */
const REQUEST_NOT_PERSISTED = "(request not persisted)";

const TOOL_INDEX = buildToolIndex();
const SAMPLE_STEPS = eventsToSteps(SAMPLE_EVENTS, TOOL_INDEX, { terminal: true });

interface RunStats {
  iterations: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalMs: number;
  finishReason: string;
}

/** Derive the 6-stat strip from the REAL fold — the sample fixture has no
 *  RunRow envelope, so its stats come from the folded steps themselves
 *  (port-map §5: "SAMPLE_EVENTS fed through the real fold is the fixture",
 *  not a hand-built RunTrace). */
function summarizeSteps(steps: TraceStep[]): RunStats {
  const iterations = steps.reduce((max, s) => Math.max(max, s.iter), 0);
  const toolCalls = steps.filter((s) => s.kind === "tool_call").length;
  const inputTokens = steps.reduce(
    (sum, s) => sum + (s.kind === "model" ? (s.ctxTokens ?? 0) : 0),
    0,
  );
  const outputTokens = steps.reduce(
    (sum, s) => sum + (s.kind === "model" ? (s.outTokens ?? 0) : 0),
    0,
  );
  const totalMs = steps.reduce((sum, s) => sum + s.ms, 0);
  const finish = [...steps].reverse().find((s) => s.kind === "finish");
  const finishReason = finish?.label?.replace(/^finishReason:\s*/, "") ?? finish?.status ?? "—";
  return { iterations, toolCalls, inputTokens, outputTokens, totalMs, finishReason };
}
const SAMPLE_STATS = summarizeSteps(SAMPLE_STEPS);

/** A REAL run's stats come straight off its `RunRow` (authoritative totals
 *  the runner/store already computed) rather than being re-derived from steps. */
function summarizeFromRow(run: RunRow): RunStats {
  return {
    iterations: run.iterations ?? 0,
    toolCalls: run.toolCalls ?? 0,
    inputTokens: run.inputTokens ?? 0,
    outputTokens: run.outputTokens ?? 0,
    totalMs: run.elapsedMs ?? 0,
    finishReason: run.finishReason ?? run.status,
  };
}

function DataBlock({ label, value }: { label: string; value: Record<string, unknown> | null }) {
  const empty = !value || Object.keys(value).length === 0;
  return (
    <Labeled label={label}>
      {empty ? (
        <span style={{ fontSize: 13, color: "var(--ink-3)" }}>— none —</span>
      ) : (
        <JsonBlock value={value} />
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

/** Top-level page lens (S8, port-map §5) — distinct from `LensMode` above
 *  (that's the declared/delivered instance toggle, nested inside "Overview"). */
type PageLens = "overview" | "runs";

const PAGE_LENS_OPTIONS: { value: PageLens; label: string; title: string }[] = [
  {
    value: "overview",
    label: "Overview",
    title: "Instantiation delta, coherence, delivered prompt",
  },
  {
    value: "runs",
    label: "Runs",
    title: "The run trace waterfall/log for this agent's recent runs",
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
  const [pageLens, setPageLens] = useState<PageLens>("overview");

  if (loading) {
    return (
      <DetailPageShell breadcrumb={[{ label: "Agents", to: "/agents" }, { label: id }]}>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            color: "var(--ink-2)",
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
            color: "var(--ink)",
          }}
        >
          {data.name}
        </div>
        {data.description && (
          <div style={{ marginTop: 6, fontSize: 14, color: "var(--ink-2)", lineHeight: 1.5 }}>
            {data.description}
          </div>
        )}
      </Card>

      <Segmented
        options={PAGE_LENS_OPTIONS}
        value={pageLens}
        onChange={setPageLens}
        size="sm"
        aria-label="Page lens"
      />

      {pageLens === "runs" ? (
        <RunsLens agentName={data.name} />
      ) : (
        <>
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
                  <span style={{ fontWeight: 600, color: "var(--ink)", flex: 1 }}>
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
                    <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
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
                  <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--ink)" }}>
                    Delivered instance
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--ink-3)",
                      lineHeight: 1.5,
                      marginBottom: 10,
                    }}
                  >
                    Compose the agent the way an entrypoint delivers it — the registration&apos;s
                    <code style={{ fontFamily: "var(--font-mono)" }}> instantiate(context)</code>{" "}
                    hook fetches the live Background for this context.
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
                      color: "var(--ink)",
                      background: "var(--background)",
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
                      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
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
                  <span style={{ fontWeight: 600, color: "var(--ink)" }}>Coherence</span>
                  {view.coherence.heuristic && <Chip tone="neutral">heuristic</Chip>}
                </div>
                <CoherenceNotice warnings={view.coherence.warnings} />
              </Card>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <RenderedPromptView
                sections={view.prompt.sections}
                renderPath={view.prompt.renderPath}
              />

              <div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
                  <span style={{ fontWeight: 600, color: "var(--ink)" }}>Inherited identity</span>
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
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
        </>
      )}
    </DetailPageShell>
  );
}

/**
 * DevRunBar analog (port-map §5: "inline in AgentLensPage runs lens", not a
 * shared organism) — runId · model · sample chip · request (honest note, see
 * `REQUEST_NOT_PERSISTED`) + the 6-stat strip (iterations / tool calls /
 * input tok / output tok / total time / finish reason).
 */
function RunStatStrip({
  runId,
  request,
  model,
  sample,
  stats,
}: {
  runId: string;
  request: string;
  model?: string;
  sample: boolean;
  stats: RunStats;
}) {
  const items: { n: string; l: string }[] = [
    { n: String(stats.iterations), l: "iterations" },
    { n: String(stats.toolCalls), l: "tool calls" },
    { n: stats.inputTokens.toLocaleString(), l: "input tok" },
    { n: stats.outputTokens.toLocaleString(), l: "output tok" },
    { n: `${(stats.totalMs / 1000).toFixed(2)}s`, l: "total" },
    { n: stats.finishReason, l: "finish" },
  ];
  return (
    <Card padded={false}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "13px 16px",
          borderBottom: "1px solid var(--line-2)",
        }}
      >
        <span style={{ fontFamily: T.font.mono, fontSize: T.fz.tiny, fontWeight: 600 }}>
          {shortId(runId)}
        </span>
        {model && <Chip tone="mono">{model}</Chip>}
        {sample && <Chip tone="warn">sample</Chip>}
        <span
          style={{
            color: "var(--ink-2)",
            fontSize: T.fz.small,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          "{request}"
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, auto)" }}>
        {items.map((it, i) => (
          <div
            key={it.l}
            style={{
              padding: "11px 18px",
              borderRight: i === items.length - 1 ? "none" : "1px solid var(--line-2)",
            }}
          >
            <div
              style={{
                fontFamily: T.font.mono,
                fontSize: T.fz.lg,
                fontWeight: 600,
                letterSpacing: "-0.01em",
              }}
            >
              {it.n}
            </div>
            <div
              style={{
                fontSize: T.fz.micro,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--mute)",
                marginTop: 3,
              }}
            >
              {it.l}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

type TraceLensMode = "waterfall" | "log";
const TRACE_LENS_OPTIONS: { value: TraceLensMode; label: string }[] = [
  { value: "waterfall", label: "Waterfall" },
  { value: "log", label: "Log" },
];

type RunsFetchState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "empty" }
  | { kind: "ok"; runs: RunSummary[] };

/**
 * Runs lens (S8, port-map §5): `fetchRuns({agent, limit: 10})` -> the latest
 * run's events -> the canonical fold -> TraceWaterfall/TraceLog. No persisted
 * runs -> the deterministic SAMPLE_EVENTS fed through the SAME real fold,
 * behind a HonestyBanner (port-map §6 mechanism 1 — never a hand-built
 * RunTrace fixture). Unconfigured persistence -> the standard unconfigured card.
 */
function RunsLens({ agentName }: { agentName: string }) {
  const [runsState, setRunsState] = useState<RunsFetchState>({ kind: "loading" });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [traceLens, setTraceLens] = useState<TraceLensMode>("waterfall");
  const [detail, setDetail] = useState<{ run: RunRow; steps: TraceStep[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRunsState({ kind: "loading" });
    fetchRuns({ agent: agentName, limit: 10 })
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "unconfigured") {
          setRunsState({ kind: "unconfigured" });
          return;
        }
        const sorted = sortRunsNewestFirst(res.data);
        setRunsState(sorted.length === 0 ? { kind: "empty" } : { kind: "ok", runs: sorted });
      })
      .catch(() => {
        // list fetch failures degrade to the sample fixture — honest-degradation §6.
        if (!cancelled) setRunsState({ kind: "empty" });
      });
    return () => {
      cancelled = true;
    };
  }, [agentName]);

  const runs = runsState.kind === "ok" ? runsState.runs : [];
  const effectiveRunId = selectedRunId ?? runs[0]?.runId ?? null;

  useEffect(() => {
    if (!effectiveRunId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    Promise.all([fetchRun(effectiveRunId), fetchRunEvents(effectiveRunId)])
      .then(([runRes, eventsRes]) => {
        if (cancelled) return;
        if (runRes.kind !== "ok" || eventsRes.kind !== "ok") {
          setDetailError("Failed to load this run's trace.");
          setDetail(null);
          return;
        }
        const events = eventsRes.data.events.map(persistedToEventLike);
        setDetail({
          run: runRes.data,
          steps: eventsToSteps(events, TOOL_INDEX, { terminal: true }),
        });
      })
      .catch((e) => {
        if (!cancelled) setDetailError(e instanceof Error ? e.message : "Failed to load run");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveRunId]);

  if (runsState.kind === "loading") {
    return <AsyncState kind="loading" loading="Loading runs…" />;
  }
  if (runsState.kind === "unconfigured") {
    return (
      <AsyncState
        kind="unconfigured"
        unconfigured={{
          title: "Run history is not configured",
          body: (
            <>
              Start <code>ap playground</code> with <code>AP_PERSISTENCE != 0</code> to enable run
              history.
            </>
          ),
        }}
      />
    );
  }

  const sample = runsState.kind === "empty";
  const steps = sample ? SAMPLE_STEPS : (detail?.steps ?? []);
  const stats = sample ? SAMPLE_STATS : detail ? summarizeFromRow(detail.run) : null;
  const runId = sample ? "sample" : (detail?.run.runId ?? effectiveRunId ?? "—");
  const request = sample ? SAMPLE_REQUEST : REQUEST_NOT_PERSISTED;
  const model = sample ? undefined : (detail?.run.model ?? undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {sample && (
        <HonestyBanner>
          No persisted runs for this agent yet — this trace is the demo fixture, not a live run.
        </HonestyBanner>
      )}
      {!sample && runs.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: T.fz.small, color: "var(--mute)" }}>Run</span>
          <select
            value={effectiveRunId ?? ""}
            onChange={(e) => setSelectedRunId(e.target.value)}
            style={{ ...inputStyle, minWidth: 260 }}
          >
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {shortId(r.runId)} · {r.toolCalls ?? 0}t · {relTime(r.tsStart)}
              </option>
            ))}
          </select>
        </div>
      )}
      {!sample && detailLoading && <AsyncState kind="loading" loading="Loading run trace…" />}
      {!sample && detailError && (
        <div style={{ fontSize: T.fz.small, color: "var(--err)" }}>{detailError}</div>
      )}
      {stats && (
        <RunStatStrip runId={runId} request={request} model={model} sample={sample} stats={stats} />
      )}
      {(sample || detail) && (
        <>
          <Segmented
            options={TRACE_LENS_OPTIONS}
            value={traceLens}
            onChange={setTraceLens}
            size="sm"
            aria-label="Trace lens"
          />
          <Card padded={false} style={{ padding: "14px 15px" }}>
            {traceLens === "waterfall" ? (
              <TraceWaterfall steps={steps} />
            ) : (
              <TraceLog steps={steps} />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
