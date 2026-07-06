/**
 * AgentEvalsCard — the Agent lens's "graded by" panel. Renders the
 * registration-DECLARED eval sets (`AgentRegistration.evals`), each with its
 * latest run from the store and a Run button that opens the launch modal with
 * set + target pre-bound (and the declared scorer preselected).
 *
 * History is keyed by SET id, not `eval_run.target_id` — legacy rows carry
 * suite names / step labels in target_id, so a set-keyed join shows runs
 * launched by harnesses, `ap eval`, and this button alike.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AgentEvalRef } from "../../api/composition";
import type { EvalRunRow } from "../../api/types";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { Chip } from "../../components/atoms/Chip";
import { fetchEvalRuns } from "../../lib/evalApi";
import { RunLaunchModal } from "../eval/RunLaunchModal";

type LatestRunState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "none" }
  | { kind: "ok"; run: EvalRunRow };

function passRateLabel(run: EvalRunRow): string {
  const rate = run.summary?.passRate;
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

function statusTone(status: EvalRunRow["status"]): "neutral" | "accent" | "warn" {
  if (status === "error") return "warn";
  if (status === "running") return "accent";
  return "neutral";
}

function LatestRunLine({ state }: { state: LatestRunState }) {
  if (state.kind === "loading") {
    return <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>loading…</span>;
  }
  if (state.kind === "unconfigured") {
    return <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>store not configured</span>;
  }
  if (state.kind === "none") {
    return <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>no runs yet</span>;
  }
  const run = state.run;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12 }}>
      <Chip tone={statusTone(run.status)}>{run.status}</Chip>
      <span style={{ color: "var(--fg-default)", fontWeight: 600 }}>{passRateLabel(run)}</span>
      {run.summary && (
        <span style={{ color: "var(--fg-subtle)" }}>
          {run.summary.passed}/{run.summary.cases}
        </span>
      )}
      {run.model && <Chip tone="mono">{run.model}</Chip>}
      <Link
        to={`/eval/runs/${encodeURIComponent(run.id)}`}
        style={{ color: "var(--accent)", textDecoration: "none" }}
        title={run.tsStart}
      >
        {new Date(run.tsStart).toLocaleString()}
      </Link>
    </span>
  );
}

export function AgentEvalsCard({
  agentId,
  agentName,
  evals,
}: {
  agentId: string;
  agentName: string;
  evals: AgentEvalRef[];
}) {
  const [latest, setLatest] = useState<Record<string, LatestRunState>>({});
  const [launch, setLaunch] = useState<AgentEvalRef | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLatest(Object.fromEntries(evals.map((e) => [e.setId, { kind: "loading" as const }])));
    for (const ref of evals) {
      (async () => {
        let state: LatestRunState;
        try {
          const result = await fetchEvalRuns({ set: ref.setId, limit: 1 });
          if (result.kind === "unconfigured") {
            state = { kind: "unconfigured" };
          } else {
            const run = result.data[0];
            state = run === undefined ? { kind: "none" } : { kind: "ok", run };
          }
        } catch {
          state = { kind: "none" };
        }
        if (!cancelled) setLatest((prev) => ({ ...prev, [ref.setId]: state }));
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [evals]);

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, color: "var(--fg-default)", flex: 1 }}>Evals</span>
        <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>graded by · declared</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {evals.map((ref, i) => (
          <div
            key={ref.setId}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "10px 0",
              borderTop: i > 0 ? "1px solid var(--border)" : "none",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Link
                to={`/eval/sets/${encodeURIComponent(ref.setId)}`}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  color: "var(--accent)",
                  textDecoration: "none",
                  flex: 1,
                }}
              >
                {ref.setId}
              </Link>
              {ref.step && <Chip tone="neutral">step · {ref.step}</Chip>}
              <Button size="sm" variant="ghost" onClick={() => setLaunch(ref)}>
                Run
              </Button>
            </div>
            {ref.grades && (
              <div style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.5 }}>
                {ref.grades}
              </div>
            )}
            <LatestRunLine state={latest[ref.setId] ?? { kind: "loading" }} />
          </div>
        ))}
      </div>
      {launch && (
        <RunLaunchModal
          setId={launch.setId}
          targetId={agentId}
          targetLabel={agentName}
          initialScorer={launch.scorer}
          onClose={() => setLaunch(null)}
        />
      )}
    </Card>
  );
}
