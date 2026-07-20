/**
 * Renderer-family run-detail body (slice 6, plan §4.2a) — REPLACES the generic
 * stat row + RunPanels + results table entirely (the ONE UI LAW: a renderer
 * run has no runs-table rows, so the generic stat row would show "Tokens In:
 * 0"). Top to bottom:
 *
 * 1. Stat tiles from `meta.summary` (client-recomputed fallback from the
 *    `render-grade` details when a field is absent).
 * 2. Grid-args provenance line + ordering-check chips (`meta.renderer`).
 * 3. Variant scoreboard via `rendererVariantScoreboard(results)`.
 * 4. Charts row (len-ratio + judge-readability histograms, cost-vs-latency
 *    scatter) over the per-render details.
 * 5. Paginated render list (PAGE_SIZE 25 + "Show N more") with variant /
 *    status / failing-only / fid filters; row expand = `RendererRowDetail`;
 *    `?render=<caseId>` deep-links an auto-expanded row (and expanding keeps
 *    the param in sync, replace-style).
 */

import { type ReactNode, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "../../../../components/atoms/Badge";
import { Button } from "../../../../components/atoms/Button";
import { Card } from "../../../../components/atoms/Card";
import { DataTable } from "../../../../components/organisms/DataTable";
import {
  type RendererVariant,
  p50,
  rendererVariantScoreboard,
} from "../../../../lib/evalAggregates";
import { Histogram } from "../../charts/Histogram";
import { MeterCell } from "../../charts/MeterCell";
import { ScatterPlot } from "../../charts/ScatterPlot";
import { isRecord, numOrNull, strList } from "../../renderers/shared";
import type { FamilyRunDetailProps } from "../index";
import { RendererRowDetail } from "./RendererRowDetail";
import { type RenderGradeRow, readRenderGradeRows } from "./renderGrade";

const PAGE_SIZE = 25;

const sectionStyle = { display: "flex", flexDirection: "column" as const, gap: 8 };
const h2Style = { fontSize: 15, fontWeight: 600, margin: 0 };
const monoMuted = { fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" };
const monoCell = { fontFamily: "var(--font-mono)", fontSize: 12 };

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}
function usd(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `$${v.toFixed(4)}`;
}
function fmt2(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toFixed(2);
}
function fmtMs(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v)}ms`;
}
function meanOf(values: readonly (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function rateOf(hits: number, total: number): number | null {
  return total > 0 ? hits / total : null;
}

export function RendererRunDetail({ run, results, casesById, meta }: FamilyRunDetailProps) {
  const rows = useMemo(() => readRenderGradeRows(results), [results]);
  const scoreboard = useMemo(() => rendererVariantScoreboard(results), [results]);

  // Deep link: ?render=<caseId> auto-expands (and widens the page window to
  // reach it — default filters show everything, so the unfiltered index holds).
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLink = searchParams.get("render");
  const [expandedKey, setExpandedKey] = useState<string | undefined>(deepLink ?? undefined);
  const [visible, setVisible] = useState<number>(() => {
    if (deepLink === null) return PAGE_SIZE;
    const idx = rows.findIndex((r) => r.caseId === deepLink);
    return idx >= PAGE_SIZE ? idx + 1 : PAGE_SIZE;
  });

  const [variantFilter, setVariantFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [failingOnly, setFailingOnly] = useState(false);
  const [fidFilter, setFidFilter] = useState("");

  const variantOptions = useMemo(
    () => [...new Set(rows.map((r) => r.variantKey).filter((v): v is string => v !== null))].sort(),
    [rows],
  );
  const statusOptions = useMemo(
    () => [...new Set(rows.map((r) => r.status).filter((v): v is string => v !== null))].sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = fidFilter.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (variantFilter === "" || r.variantKey === variantFilter) &&
        (statusFilter === "" || r.status === statusFilter) &&
        (!failingOnly || r.detPass !== true) &&
        (q === "" || r.caseId.toLowerCase().includes(q)),
    );
  }, [rows, variantFilter, statusFilter, failingOnly, fidFilter]);

  const paged = useMemo(() => filtered.slice(0, visible), [filtered, visible]);

  const toggleExpand = (key: string) => {
    const next = expandedKey === key ? undefined : key;
    setExpandedKey(next);
    const q = new URLSearchParams(searchParams);
    if (next !== undefined) q.set("render", next);
    else q.delete("render");
    setSearchParams(q, { replace: true });
  };

  // Stat tiles — meta.summary is authoritative; each field falls back to a
  // client recompute from the render-grade rows so a thin blob still renders.
  const sm = meta.summary;
  const graded = rows.filter((r) => r.detPass !== null);
  const detPassRate =
    sm?.detPassRate ?? rateOf(graded.filter((r) => r.detPass === true).length, graded.length);
  const judgeMean = sm?.judgeLens?.value ?? meanOf(rows.map((r) => r.judgeReadability));
  const crashed = sm?.crashedCount ?? rows.filter((r) => r.status === "crashed").length;
  const flagsRate =
    sm?.flagsRate ??
    rateOf(
      rows.filter(
        (r) => r.fidelityFailure || r.status === "presentation_fallback" || r.status === "crashed",
      ).length,
      rows.length,
    );
  const fallbackRate =
    sm?.fallbackRate ??
    rateOf(rows.filter((r) => r.status === "presentation_fallback").length, rows.length);
  const retriesRate =
    sm?.retriesRate ?? rateOf(rows.filter((r) => r.retriedForLength).length, rows.length);
  const renderCost =
    sm?.costUsd ??
    (rows.some((r) => r.costUsd !== null)
      ? rows.reduce((acc, r) => acc + (r.costUsd ?? 0), 0)
      : null);
  const judgeCost = sm?.judgeCostUsd ?? null;
  const latencyP50 = sm?.latencyP50 ?? p50(rows.map((r) => r.latencyMs));

  // Provenance (meta.renderer): gridArgs line + ordering-check chips.
  const rendererBlob = meta.renderer ?? {};
  const gridArgs = isRecord(rendererBlob.gridArgs) ? rendererBlob.gridArgs : null;
  const gridStates = gridArgs !== null ? numOrNull(gridArgs.states) : null;
  const gridJudgeMode =
    gridArgs !== null && typeof gridArgs.judgeMode === "string" ? gridArgs.judgeMode : null;
  const gridModels = gridArgs !== null ? strList(gridArgs.models) : [];
  const orderingChecks = strList(rendererBlob.orderingChecks);

  const provParts: string[] = [];
  if (gridStates !== null) provParts.push(`states ${gridStates}`);
  if (gridJudgeMode !== null) provParts.push(`judge ${gridJudgeMode}`);
  if (gridModels.length > 0) provParts.push(`models ${gridModels.join(", ")}`);
  if (meta.judgeModel !== undefined) provParts.push(`judge model ${meta.judgeModel}`);

  const provenanceCard =
    provParts.length > 0 || orderingChecks.length > 0 ? (
      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          {provParts.length > 0 && <span style={monoMuted}>grid · {provParts.join(" · ")}</span>}
          {orderingChecks.map((check) => (
            <Badge key={check} tone="purple" title="ordering check">
              {check} ✓
            </Badge>
          ))}
        </div>
      </Card>
    ) : null;

  if (rows.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {provenanceCard}
        <Card style={{ textAlign: "center", padding: 40, color: "var(--fg-muted)" }}>
          <div style={{ fontWeight: 600, color: "var(--fg-default)", marginBottom: 6 }}>
            No render-grade results
          </div>
          <div style={{ fontSize: 14 }}>
            This renderer run has no cases carrying a <code>render-grade</code> score detail.
          </div>
        </Card>
      </div>
    );
  }

  // Charts data — pulled from the per-render details.
  const lenRatios = rows.flatMap((r) => (r.lenRatio === null ? [] : [r.lenRatio]));
  const readabilities = rows.flatMap((r) =>
    r.judgeReadability === null ? [] : [r.judgeReadability],
  );
  const costLatencyPoints = rows.flatMap((r) =>
    r.latencyMs === null || r.costUsd === null
      ? []
      : [{ x: r.latencyMs, y: r.costUsd, label: r.caseId }],
  );
  const hasCharts =
    lenRatios.length > 0 || readabilities.length > 0 || costLatencyPoints.length > 0;

  const remaining = filtered.length - paged.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: 16,
          }}
        >
          <Stat label="Renders" value={rows.length} />
          <Stat label="Crashed" value={crashed} color={crashed > 0 ? "var(--red)" : undefined} />
          <Stat label="Det pass" value={pct(detPassRate)} color="var(--green)" />
          <Stat label="Judge mean" value={fmt2(judgeMean)} />
          <Stat label="Flags" value={pct(flagsRate)} />
          <Stat label="Fallbacks" value={pct(fallbackRate)} />
          <Stat label="Retries" value={pct(retriesRate)} />
          <Stat label="Latency p50" value={fmtMs(latencyP50)} />
          <Stat label="Render $" value={usd(renderCost)} />
          <Stat label="Judge $" value={usd(judgeCost)} />
        </div>
      </Card>

      {provenanceCard}

      <section style={sectionStyle}>
        <h2 style={h2Style}>Variant scoreboard</h2>
        <Card padded={false}>
          <DataTable<RendererVariant>
            columns={[
              {
                key: "variant",
                header: "Variant",
                render: (v) => (
                  <div>
                    <div style={{ ...monoCell, fontWeight: 600 }}>{v.variantKey}</div>
                    <div style={{ ...monoMuted, fontSize: 11 }}>
                      {[
                        v.variant.shape,
                        v.variant.verbosity,
                        v.variant.tone,
                        v.variant.citationMode,
                        v.variant.model,
                      ]
                        .filter((x): x is string => x !== undefined)
                        .join(" · ")}
                    </div>
                  </div>
                ),
              },
              { key: "n", header: "N", align: "right", render: (v) => v.n },
              {
                key: "detPassRate",
                header: "Det pass",
                render: (v) => (
                  <MeterCell value={v.detPassRate} format={(x) => `${Math.round(x * 100)}%`} />
                ),
              },
              {
                key: "gateFailures",
                header: "Gate failures",
                render: (v) =>
                  v.gateFailures !== "" ? (
                    <span style={{ ...monoCell, color: "var(--red)" }}>{v.gateFailures}</span>
                  ) : (
                    <span style={{ color: "var(--fg-subtle)" }}>—</span>
                  ),
              },
              {
                key: "coverageHonestRate",
                header: "Coverage",
                align: "right",
                render: (v) => pct(v.coverageHonestRate),
              },
              {
                key: "judge",
                header: "Judge R·F·T",
                render: (v) => (
                  <span style={monoCell}>
                    {fmt2(v.judgeReadability)} / {fmt2(v.judgeFaithful)} / {fmt2(v.judgeToneDiff)}
                  </span>
                ),
              },
              {
                key: "lenRatioP50",
                header: "Len p50",
                align: "right",
                render: (v) => (v.lenRatioP50 === null ? "—" : `${v.lenRatioP50.toFixed(2)}×`),
              },
              {
                key: "flagsRetries",
                header: "Flags · Retry",
                align: "right",
                render: (v) => `${pct(v.flagsRate)} · ${pct(v.retriesRate)}`,
              },
              {
                key: "latencyMsP50",
                header: "Lat p50",
                align: "right",
                render: (v) => fmtMs(v.latencyMsP50),
              },
              {
                key: "costUsdMean",
                header: "$/render",
                align: "right",
                render: (v) => usd(v.costUsdMean),
              },
            ]}
            data={scoreboard}
            rowKey={(v) => v.variantKey}
          />
        </Card>
      </section>

      {hasCharts && (
        <section style={sectionStyle}>
          <h2 style={h2Style}>Distributions</h2>
          <Card>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 28 }}>
              <ChartBlock title="Length ratio">
                <Histogram values={lenRatios} label="Length ratio" width={320} height={150} />
              </ChartBlock>
              <ChartBlock title="Judge readability">
                <Histogram
                  values={readabilities}
                  label="Judge readability"
                  width={320}
                  height={150}
                />
              </ChartBlock>
              <ChartBlock title="Cost vs latency">
                <ScatterPlot
                  points={costLatencyPoints}
                  xLabel="latency ms"
                  yLabel="cost $"
                  width={340}
                  height={200}
                  formatY={(v) => v.toFixed(3)}
                />
              </ChartBlock>
            </div>
          </Card>
        </section>
      )}

      <section style={sectionStyle}>
        <h2 style={h2Style}>
          Renders ({filtered.length}
          {filtered.length !== rows.length ? ` of ${rows.length}` : ""})
        </h2>

        <Card>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
            <SelectFilter
              id="renderer-variant-filter"
              label="Variant"
              value={variantFilter}
              options={variantOptions}
              onChange={(v) => {
                setVariantFilter(v);
                setVisible(PAGE_SIZE);
              }}
            />
            <SelectFilter
              id="renderer-status-filter"
              label="Status"
              value={statusFilter}
              options={statusOptions}
              onChange={(v) => {
                setStatusFilter(v);
                setVisible(PAGE_SIZE);
              }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label htmlFor="renderer-fid-filter" style={filterLabelStyle}>
                Case filter
              </label>
              <input
                id="renderer-fid-filter"
                type="text"
                value={fidFilter}
                placeholder="fid…"
                onChange={(e) => {
                  setFidFilter(e.target.value);
                  setVisible(PAGE_SIZE);
                }}
                style={{
                  padding: "6px 10px",
                  fontSize: 13,
                  fontFamily: "var(--font-mono)",
                  background: "var(--bg-surface)",
                  color: "var(--fg-default)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                }}
              />
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                color: "var(--fg-default)",
                paddingBottom: 7,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={failingOnly}
                onChange={(e) => {
                  setFailingOnly(e.target.checked);
                  setVisible(PAGE_SIZE);
                }}
              />
              Failing only
            </label>
          </div>
        </Card>

        <Card padded={false}>
          <DataTable<RenderGradeRow>
            columns={[
              {
                key: "caseId",
                header: "Case",
                render: (r) => <span style={monoCell}>{r.caseId}</span>,
              },
              {
                key: "status",
                header: "Status",
                render: (r) =>
                  r.status === null ? (
                    <span style={{ color: "var(--fg-subtle)" }}>—</span>
                  ) : (
                    <Badge
                      tone={r.status === "crashed" ? "red" : r.status === "ok" ? "muted" : "yellow"}
                    >
                      {r.status}
                    </Badge>
                  ),
              },
              {
                key: "detPass",
                header: "Grade",
                render: (r) =>
                  r.detPass === null ? (
                    <Badge tone="muted">ungated</Badge>
                  ) : (
                    <Badge tone={r.detPass ? "green" : "red"}>{r.detPass ? "pass" : "fail"}</Badge>
                  ),
              },
              {
                key: "gates",
                header: "Gates",
                render: (r) =>
                  r.failedGates.length > 0 ? (
                    <span style={{ ...monoCell, color: "var(--red)" }}>
                      {r.failedGates.join(" ")}
                    </span>
                  ) : (
                    <span style={{ color: "var(--fg-subtle)" }}>—</span>
                  ),
              },
              {
                key: "judgeReadability",
                header: "Judge",
                align: "right",
                render: (r) => fmt2(r.judgeReadability),
              },
              {
                key: "lenRatio",
                header: "Len",
                align: "right",
                render: (r) => (r.lenRatio === null ? "—" : `${r.lenRatio.toFixed(2)}×`),
              },
              {
                key: "costUsd",
                header: "Cost",
                align: "right",
                render: (r) => usd(r.costUsd),
              },
              {
                key: "latencyMs",
                header: "Latency",
                align: "right",
                render: (r) => fmtMs(r.latencyMs),
              },
            ]}
            data={paged}
            rowKey={(r) => r.caseId}
            expandedKey={expandedKey}
            onToggleExpand={toggleExpand}
            renderExpanded={(r) => (
              <RendererRowDetail
                row={r}
                bankCase={r.fid !== null ? casesById.get(r.fid) : undefined}
                setId={run.setId}
              />
            )}
          />
        </Card>

        {remaining > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Button variant="ghost" size="sm" onClick={() => setVisible((v) => v + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, remaining)} more
            </Button>
            <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>
              {paged.length} of {filtered.length} shown
            </span>
          </div>
        )}
      </section>
    </div>
  );
}

const filterLabelStyle = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
  color: "var(--fg-muted)",
};

function SelectFilter({
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
      <label htmlFor={id} style={filterLabelStyle}>
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

function ChartBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 260 }}>
      <div style={filterLabelStyle}>{title}</div>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: color ?? "var(--fg-default)" }}>
        {value}
      </div>
    </div>
  );
}
