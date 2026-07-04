/**
 * Run launcher — set / target / variant / split picker + `allowTest`
 * affordance for `POST /eval/runs` (#139, E5c). Mounted on `EvalRunsPage`'s
 * header row next to Refresh, expanding a form Card on click (the
 * `SplitAggregatesPanel` page-scoped-component idiom).
 */

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listAgents } from "../../api/chat-client";
import type { EvalSetSummary, EvalSplit } from "../../api/types";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { fetchEvalSets, launchEvalRun } from "../../lib/evalApi";

type SetsState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string }
  | { kind: "ok"; sets: EvalSetSummary[] };

type AgentsState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; agents: Array<{ id: string; name: string }> };

const SPLIT_OPTIONS: ReadonlyArray<{ value: "" | EvalSplit; label: string }> = [
  { value: "", label: "All" },
  { value: "train", label: "train" },
  { value: "dev", label: "dev" },
  { value: "test", label: "test" },
];

export function RunLauncher() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState<SetsState>({ kind: "loading" });
  const [agents, setAgents] = useState<AgentsState>({ kind: "loading" });
  const [setId, setSetId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [variant, setVariant] = useState("");
  const [split, setSplit] = useState<"" | EvalSplit>("");
  const [allowTest, setAllowTest] = useState(false);
  const [launchError, setLaunchError] = useState<string | undefined>(undefined);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setSets({ kind: "loading" });
      try {
        const result = await fetchEvalSets();
        if (cancelled) return;
        setSets(
          result.kind === "unconfigured"
            ? { kind: "unconfigured" }
            : { kind: "ok", sets: result.data },
        );
      } catch (e) {
        if (!cancelled) {
          setSets({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setAgents({ kind: "loading" });
      try {
        const list = await listAgents();
        if (!cancelled) setAgents({ kind: "ok", agents: list });
      } catch (e) {
        if (!cancelled) {
          setAgents({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Run eval
      </Button>
    );
  }

  const handleRun = async () => {
    setLaunchError(undefined);
    setLaunching(true);
    try {
      const result = await launchEvalRun({
        setId,
        targetId,
        variant: variant.trim() || undefined,
        split: split || undefined,
        allowTest: split === "test" ? allowTest : undefined,
      });
      if (result.kind === "ok") {
        navigate(`/eval/runs/${result.runId}`);
        return;
      }
      if (result.kind === "unconfigured") {
        setLaunchError("Eval execution is not configured — start `ap playground` to enable runs.");
        return;
      }
      setLaunchError(result.message);
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  };

  const canRun = setId.length > 0 && targetId.length > 0 && !launching;

  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 320 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Run eval</div>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      {sets.kind === "unconfigured" ? (
        <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          Eval persistence is not configured — start <code>ap playground</code> with{" "}
          <code>AP_PERSISTENCE != 0</code>.
        </div>
      ) : (
        <>
          <LauncherField label="Set">
            <select
              value={setId}
              onChange={(e) => setSetId(e.target.value)}
              style={selectStyle}
              aria-label="Set"
            >
              <option value="">Select a set…</option>
              {sets.kind === "ok" &&
                sets.sets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} ({s.caseCount})
                  </option>
                ))}
            </select>
            {sets.kind === "error" && (
              <div style={{ fontSize: 12, color: "var(--red)" }}>{sets.message}</div>
            )}
          </LauncherField>

          <LauncherField label="Target">
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              style={selectStyle}
              aria-label="Target"
            >
              <option value="">Select a target…</option>
              {agents.kind === "ok" &&
                agents.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
            {agents.kind === "error" && (
              <div style={{ fontSize: 12, color: "var(--red)" }}>{agents.message}</div>
            )}
          </LauncherField>

          <LauncherField label="Variant (optional)">
            <input
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
              style={selectStyle}
              aria-label="Variant"
              placeholder="e.g. candidate"
            />
          </LauncherField>

          <LauncherField label="Split">
            <select
              value={split}
              onChange={(e) => setSplit(e.target.value as "" | EvalSplit)}
              style={selectStyle}
              aria-label="Split"
            >
              {SPLIT_OPTIONS.map((o) => (
                <option key={o.value || "all"} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </LauncherField>

          {split === "test" && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={allowTest}
                onChange={(e) => setAllowTest(e.target.checked)}
              />
              Run the held-out test split
            </label>
          )}

          {launchError && <div style={{ fontSize: 13, color: "var(--red)" }}>{launchError}</div>}

          <Button disabled={!canRun} onClick={handleRun}>
            {launching ? "Starting…" : "Run"}
          </Button>
        </>
      )}
    </Card>
  );
}

function LauncherField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--fg-muted)",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

const selectStyle: CSSProperties = {
  padding: "6px 10px",
  fontSize: 13,
  fontFamily: "inherit",
  background: "var(--bg-surface)",
  color: "var(--fg-default)",
  border: "1px solid var(--border)",
  borderRadius: 6,
};
