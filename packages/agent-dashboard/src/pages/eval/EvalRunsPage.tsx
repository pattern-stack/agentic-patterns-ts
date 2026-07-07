/**
 * /eval — Eval run history (E5a, #137).
 *
 * One-shot mount fetch (`fetchEvalRuns({ limit: 200 })`) + a ghost Refresh
 * button (the `LivePage` Clear-button idiom) — no polling, since eval data is
 * CLI-driven and reviewed after the fact. Filters are client-side (pure
 * `filterRuns`) over the fetched window; facet options are the distinct
 * values across the *unfiltered* window so picking one facet never collapses
 * the others' options. Row click navigates into the detail page.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { EvalRunRow, EvalSplit } from "../../api/types";
import { Badge, type BadgeTone } from "../../components/atoms/Badge";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { AsyncState } from "../../components/kit/AsyncState";
import { Field, inputStyle } from "../../components/kit/Field";
import { PageHeader } from "../../components/kit/PageHeader";
import { DataTable } from "../../components/organisms/DataTable";
import { useSortedRows } from "../../hooks/useSortedRows";
import { type EvalRunFilters, fetchEvalRuns, filterRuns } from "../../lib/evalApi";
import { relTime, shortId, statusTone } from "../../lib/format";
import { RunLauncher } from "./RunLauncher";
import { SplitAggregatesPanel } from "./SplitAggregatesPanel";

function passRateTone(rate: number): BadgeTone {
  if (rate >= 0.999) return "ok";
  if (rate >= 0.5) return "warn";
  return "err";
}

/** Runs-list pass cell: "9/12" + a pass-rate badge; ungated (or summary-less) runs show "—". */
function PassCell({ summary }: { summary: EvalRunRow["summary"] }) {
  if (!summary || summary.passRate === null) {
    return <span style={{ color: "var(--ink-3)" }}>—</span>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
        {summary.passed}/{summary.cases}
      </span>
      <Badge tone={passRateTone(summary.passRate)}>{Math.round(summary.passRate * 100)}%</Badge>
    </span>
  );
}

const SPLIT_OPTIONS: Array<EvalSplit | "untagged"> = ["train", "dev", "test", "untagged"];

type LoadState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string }
  | { kind: "ok"; runs: EvalRunRow[] };

export function EvalRunsPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [filters, setFilters] = useState<EvalRunFilters>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    setSelected(new Set());
    try {
      const result = await fetchEvalRuns({ limit: 200 });
      setState(
        result.kind === "unconfigured"
          ? { kind: "unconfigured" }
          : { kind: "ok", runs: result.data },
      );
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runs = state.kind === "ok" ? state.runs : [];

  const facets = useMemo(() => {
    const sets = new Set<string>();
    const targets = new Set<string>();
    const variants = new Set<string>();
    for (const r of runs) {
      if (r.setId) sets.add(r.setId);
      if (r.targetId) targets.add(r.targetId);
      if (r.variant) variants.add(r.variant);
    }
    return {
      sets: [...sets].sort(),
      targets: [...targets].sort(),
      variants: [...variants].sort(),
    };
  }, [runs]);

  const hasActiveFilter = Boolean(
    filters.set || filters.target || filters.variant || filters.split,
  );
  const filtered = filterRuns(runs, filters);
  const { sorted, sortKey, sortDir, handleSort } = useSortedRows(filtered, "tsStart", "desc");

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 2) {
        next.add(id);
      }
      return next;
    });
  };

  const handleCompare = () => {
    // A = the older run by tsStart — the default read is A = baseline,
    // B = candidate, so "regressions" means what it says.
    const [runA, runB] = runs
      .filter((r) => selected.has(r.id))
      .sort((a, b) => new Date(a.tsStart).getTime() - new Date(b.tsStart).getTime());
    if (runA && runB) {
      navigate(`/eval/compare/${runA.id}/${runB.id}`);
    }
  };

  return (
    <div>
      <PageHeader
        title="Eval Runs"
        actions={
          <>
            <RunLauncher />
            <Button variant="ghost" size="sm" onClick={load}>
              Refresh
            </Button>
          </>
        }
      />

      {state.kind !== "ok" && (
        <AsyncState
          kind={state.kind}
          loading="Loading eval runs..."
          unconfigured={{
            title: "Eval persistence is not configured",
            body: (
              <>
                Start <code>ap playground</code> with <code>AP_PERSISTENCE != 0</code> to enable
                eval queries.
              </>
            ),
          }}
          error={
            state.kind === "error"
              ? { title: "Failed to load eval runs", message: state.message }
              : undefined
          }
        />
      )}

      {state.kind === "ok" && runs.length === 0 && (
        <AsyncState
          kind="empty"
          empty={{
            title: "No eval runs yet",
            body: (
              <>
                Run <code>ap eval</code> against a case bank to populate this list.
              </>
            ),
          }}
        />
      )}

      {state.kind === "ok" && runs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
            <FilterSelect
              label="Set"
              value={filters.set ?? ""}
              options={facets.sets}
              onChange={(v) => setFilters((f) => ({ ...f, set: v || undefined }))}
            />
            <FilterSelect
              label="Target"
              value={filters.target ?? ""}
              options={facets.targets}
              onChange={(v) => setFilters((f) => ({ ...f, target: v || undefined }))}
            />
            <FilterSelect
              label="Variant"
              value={filters.variant ?? ""}
              options={facets.variants}
              onChange={(v) => setFilters((f) => ({ ...f, variant: v || undefined }))}
            />
            <FilterSelect
              label="Split"
              value={filters.split ?? ""}
              options={SPLIT_OPTIONS}
              onChange={(v) =>
                setFilters((f) => ({
                  ...f,
                  split: (v || undefined) as EvalSplit | "untagged" | undefined,
                }))
              }
            />
            {hasActiveFilter && (
              <Button variant="ghost" size="sm" onClick={() => setFilters({})}>
                Clear filters
              </Button>
            )}
          </div>

          <SplitAggregatesPanel
            filters={{ set: filters.set, target: filters.target, variant: filters.variant }}
          />

          {selected.size > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 14px",
                background: "var(--paper)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-lg)",
              }}
            >
              <span style={{ fontSize: 13, color: "var(--mute)" }}>
                {selected.size} of 2 selected
              </span>
              <Button size="sm" disabled={selected.size !== 2} onClick={handleCompare}>
                Compare
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          {filtered.length === 0 ? (
            <AsyncState kind="empty" empty={{ title: "No runs match the current filters." }} />
          ) : (
            <Card padded={false}>
              <DataTable<EvalRunRow>
                columns={[
                  {
                    key: "select",
                    header: "",
                    render: (row) => {
                      const isSelected = selected.has(row.id);
                      return (
                        <input
                          type="checkbox"
                          aria-label={`select run ${row.id} for compare`}
                          checked={isSelected}
                          disabled={!isSelected && selected.size >= 2}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleSelect(row.id)}
                        />
                      );
                    },
                  },
                  {
                    key: "id",
                    header: "Run",
                    render: (row) => (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                        {shortId(row.id)}
                      </span>
                    ),
                  },
                  { key: "setId", header: "Set", render: (row) => row.setId ?? "—" },
                  { key: "targetId", header: "Target", render: (row) => row.targetId ?? "—" },
                  { key: "variant", header: "Variant", render: (row) => row.variant ?? "—" },
                  {
                    key: "split",
                    header: "Split",
                    render: (row) => <Badge tone="mute">{row.split ?? "untagged"}</Badge>,
                  },
                  {
                    key: "status",
                    header: "Status",
                    render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
                  },
                  {
                    key: "passed",
                    header: "Passed",
                    render: (row) => <PassCell summary={row.summary} />,
                  },
                  { key: "model", header: "Model", render: (row) => row.model ?? "—" },
                  {
                    key: "tsStart",
                    header: "Started",
                    render: (row) => relTime(row.tsStart),
                  },
                ]}
                data={sorted}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={handleSort}
                rowKey={(row) => row.id}
                onRowClick={(row) => navigate(`/eval/runs/${row.id}`)}
              />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </Field>
  );
}
