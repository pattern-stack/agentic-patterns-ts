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
import { Spinner } from "../../components/atoms/Spinner";
import { AlertIcon } from "../../components/atoms/icons";
import { DataTable } from "../../components/organisms/DataTable";
import { type EvalRunFilters, fetchEvalRuns, filterRuns } from "../../lib/evalApi";
import { RunLauncher } from "./RunLauncher";
import { SplitAggregatesPanel } from "./SplitAggregatesPanel";
import { RUN_FAMILY_ORDER, resolveRunFamilyComponents } from "./families";
import { type RunFamily, familyOf } from "./families/types";

// pages never share code (playground-redesign.md) — lifted from ConversationsPage as-is.
function relative(dateStr: string | undefined | null): string {
  if (!dateStr) return "—";
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return String(dateStr);
  const diffSec = Math.round((Date.now() - then) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return `${diffSec}s ago`;
  if (abs < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (abs < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

function statusTone(status: EvalRunRow["status"]): BadgeTone {
  switch (status) {
    case "ok":
      return "green";
    case "error":
      return "red";
    case "running":
      return "emerald";
    default:
      return "neutral";
  }
}

function passRateTone(rate: number): BadgeTone {
  if (rate >= 0.999) return "green";
  if (rate >= 0.5) return "yellow";
  return "red";
}

/** Runs-list pass cell: "9/12" + a pass-rate badge; ungated (or summary-less) runs show "—". */
function PassCell({ summary }: { summary: EvalRunRow["summary"] }) {
  if (!summary || summary.passRate === null) {
    return <span style={{ color: "var(--fg-subtle)" }}>—</span>;
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

function getField(row: EvalRunRow, key: string): string {
  return String((row as unknown as Record<string, unknown>)[key] ?? "");
}

const SPLIT_OPTIONS: Array<EvalSplit | "untagged"> = ["train", "dev", "test", "untagged"];

/** Section chrome for the stacked family sections (order = RUN_FAMILY_ORDER). */
const FAMILY_SECTION_COPY: Record<RunFamily, { label: string; hint: string }> = {
  renderer: {
    label: "Renderer runs",
    hint: "Render-grade grid benchmarks — deterministic gates + judge lenses per variant.",
  },
  sdc: {
    label: "SDC runs",
    hint: "Single-deal-context answer benchmarks — axis score-maps + judge verdicts per fixture.",
  },
  curation: {
    label: "Curation runs",
    hint: "Curation sweeps — expectation survival vs outbound tokens across configs.",
  },
};

type LoadState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string }
  | { kind: "ok"; runs: EvalRunRow[] };

export function EvalRunsPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [sortKey, setSortKey] = useState("tsStart");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
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

  // Family partition: family runs render in their own stacked sections; the
  // generic (no-family) runs keep the entire pre-family page body verbatim.
  const { runsByFamily, genericRuns } = useMemo(() => {
    const byFamily = new Map<RunFamily, EvalRunRow[]>();
    const generic: EvalRunRow[] = [];
    for (const r of runs) {
      const family = familyOf(r);
      if (family === null) {
        generic.push(r);
      } else {
        const list = byFamily.get(family);
        if (list) {
          list.push(r);
        } else {
          byFamily.set(family, [r]);
        }
      }
    }
    return { runsByFamily: byFamily, genericRuns: generic };
  }, [runs]);

  const hasFamilySections = runsByFamily.size > 0;

  const facets = useMemo(() => {
    const sets = new Set<string>();
    const targets = new Set<string>();
    const variants = new Set<string>();
    for (const r of genericRuns) {
      if (r.setId) sets.add(r.setId);
      if (r.targetId) targets.add(r.targetId);
      if (r.variant) variants.add(r.variant);
    }
    return {
      sets: [...sets].sort(),
      targets: [...targets].sort(),
      variants: [...variants].sort(),
    };
  }, [genericRuns]);

  const hasActiveFilter = Boolean(
    filters.set || filters.target || filters.variant || filters.split,
  );
  const filtered = filterRuns(genericRuns, filters);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sorted = [...filtered].sort((a, b) => {
    const cmp = getField(a, sortKey).localeCompare(getField(b, sortKey), undefined, {
      numeric: true,
    });
    return sortDir === "asc" ? cmp : -cmp;
  });

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
    const [runA, runB] = genericRuns
      .filter((r) => selected.has(r.id))
      .sort((a, b) => new Date(a.tsStart).getTime() - new Date(b.tsStart).getTime());
    if (runA && runB) {
      navigate(`/eval/compare/${runA.id}/${runB.id}`);
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Eval Runs</h1>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <RunLauncher />
          <Button variant="ghost" size="sm" onClick={load}>
            Refresh
          </Button>
        </div>
      </div>

      {state.kind === "loading" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: "48px 0",
            color: "var(--fg-muted)",
          }}
        >
          <Spinner />
          <span>Loading eval runs...</span>
        </div>
      )}

      {state.kind === "error" && (
        <Card
          style={{ borderColor: "var(--red)", display: "flex", alignItems: "flex-start", gap: 12 }}
        >
          <span style={{ color: "var(--red)", display: "inline-flex", flexShrink: 0 }}>
            <AlertIcon size={18} />
          </span>
          <div>
            <div style={{ fontWeight: 600, color: "var(--red)", marginBottom: 4 }}>
              Failed to load eval runs
            </div>
            <div style={{ color: "var(--fg-muted)", fontSize: 14 }}>{state.message}</div>
          </div>
        </Card>
      )}

      {state.kind === "unconfigured" && (
        <Card style={{ textAlign: "center", padding: 40, color: "var(--fg-muted)" }}>
          <div style={{ fontWeight: 600, color: "var(--fg-default)", marginBottom: 6 }}>
            Eval persistence is not configured
          </div>
          <div style={{ fontSize: 14 }}>
            Start <code>ap playground</code> with <code>AP_PERSISTENCE != 0</code> to enable eval
            queries.
          </div>
        </Card>
      )}

      {state.kind === "ok" && runs.length === 0 && (
        <Card style={{ textAlign: "center", padding: 40, color: "var(--fg-muted)" }}>
          <div style={{ fontWeight: 600, color: "var(--fg-default)", marginBottom: 6 }}>
            No eval runs yet
          </div>
          <div style={{ fontSize: 14 }}>
            Run <code>ap eval</code> against a case bank to populate this list.
          </div>
        </Card>
      )}

      {state.kind === "ok" && runs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {RUN_FAMILY_ORDER.map((family) => {
            const familyRuns = runsByFamily.get(family);
            const components = resolveRunFamilyComponents(family);
            if (!familyRuns || familyRuns.length === 0 || components === null) return null;
            const copy = FAMILY_SECTION_COPY[family];
            return (
              <section key={family} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div>
                  <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{copy.label}</h2>
                  <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 2 }}>
                    {copy.hint}
                  </div>
                </div>
                <components.HomeTable runs={familyRuns} />
              </section>
            );
          })}

          {genericRuns.length > 0 && (
            <>
              {hasFamilySections && (
                <div>
                  <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Other runs</h2>
                  <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 2 }}>
                    Generic eval runs without a family — filter, aggregate, and compare as before.
                  </div>
                </div>
              )}
              <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
                <FilterSelect
                  id="eval-filter-set"
                  label="Set"
                  value={filters.set ?? ""}
                  options={facets.sets}
                  onChange={(v) => setFilters((f) => ({ ...f, set: v || undefined }))}
                />
                <FilterSelect
                  id="eval-filter-target"
                  label="Target"
                  value={filters.target ?? ""}
                  options={facets.targets}
                  onChange={(v) => setFilters((f) => ({ ...f, target: v || undefined }))}
                />
                <FilterSelect
                  id="eval-filter-variant"
                  label="Variant"
                  value={filters.variant ?? ""}
                  options={facets.variants}
                  onChange={(v) => setFilters((f) => ({ ...f, variant: v || undefined }))}
                />
                <FilterSelect
                  id="eval-filter-split"
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
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--fg-muted)" }}>
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
                <Card style={{ textAlign: "center", padding: 32, color: "var(--fg-muted)" }}>
                  No runs match the current filters.
                </Card>
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
                          <span
                            title={row.id}
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 12,
                              display: "inline-block",
                              maxWidth: 180,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              verticalAlign: "bottom",
                            }}
                          >
                            {row.id}
                          </span>
                        ),
                      },
                      { key: "setId", header: "Set", render: (row) => row.setId ?? "—" },
                      { key: "targetId", header: "Target", render: (row) => row.targetId ?? "—" },
                      { key: "variant", header: "Variant", render: (row) => row.variant ?? "—" },
                      {
                        key: "split",
                        header: "Split",
                        render: (row) => <Badge tone="muted">{row.split ?? "untagged"}</Badge>,
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
                        render: (row) => relative(row.tsStart),
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
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label
        htmlFor={id}
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--fg-muted)",
        }}
      >
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "6px 10px",
          fontSize: 13,
          fontFamily: "inherit",
          background: "var(--bg-surface)",
          color: "var(--fg-default)",
          border: "1px solid var(--border)",
          borderRadius: 6,
        }}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
