/**
 * Curation-family run-detail body (slice 8, plan §4.2c) — REPLACES the generic
 * stat row + RunPanels + results table entirely (the one UI law).
 *
 * - Header tiles from `meta.summary` (best survival @ tokens, compression,
 *   pareto k/n, config/fixture counts).
 * - Pareto frontier via the declared-wins rule: `meta.curation.frontier`
 *   (when present, non-empty) authoritatively sets the on-front flags via
 *   `curationFrontierDeclared`; otherwise dominance is recomputed client-side.
 *   A chip states which source is in effect.
 * - Survival + outbound-token distributions (Histogram atoms).
 * - Per-config table (`curationConfigTable`, sorted survival↓ then tokens↑)
 *   with pareto highlight + pill, knob abbreviations, and metric columns —
 *   values the aggregate doesn't expose render as "—".
 * - Config expand = per-fixture card grid embedding the pure-presentational
 *   `CurationFactsDetail` renderer; fixture cross-links to
 *   `/eval/sets/<meta.curation.sourceSetId>/cases/<fixtureId>` live HERE at
 *   the wrapper level (contract: leaf renderers never route).
 * - `meta.curation.scoreboardMd` rendered via the existing Markdown atom.
 */

import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { EvalScoreLike, JoinedEvalResultRow } from "../../../../api/types";
import { Markdown } from "../../../../chat/atoms";
import { Badge } from "../../../../components/atoms/Badge";
import { Card } from "../../../../components/atoms/Card";
import { DataTable } from "../../../../components/organisms/DataTable";
import {
  type CurationConfigRow,
  curationConfigTable,
  curationFrontierDeclared,
} from "../../../../lib/evalAggregates";
import { FrontierScatter } from "../../charts/FrontierScatter";
import { Histogram } from "../../charts/Histogram";
import { MeterCell } from "../../charts/MeterCell";
import { BarCell } from "../../components/BarCell";
import { CurationFactsDetail } from "../../renderers/CurationFactsDetail";
import type { FamilyRunDetailProps } from "../index";

// ---- helpers ---------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}
/** Formats a value already on a 0–100 percent scale (e.g. `compressionPct`). */
function pct100(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v)}%`;
}
function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** One curation-facts case, unpacked for the drill-in + distributions. */
interface CaseFacts {
  caseId: string;
  configId: string;
  fixtureId: string;
  detail: Record<string, unknown>;
  score: EvalScoreLike;
  pass: boolean | null;
  survivalRate: number | null;
  outboundTokens: number | null;
}

function extractFacts(results: readonly JoinedEvalResultRow[]): CaseFacts[] {
  const out: CaseFacts[] = [];
  for (const r of results) {
    const score = (r.scores ?? []).find(
      (s) => isRecord(s.detail) && s.detail.kind === "curation-facts",
    );
    if (!score || !isRecord(score.detail)) continue;
    const d = score.detail;
    const configId = typeof d.configId === "string" ? d.configId : "";
    // Composite case id `<configId>#<fixtureId>` (eval-family-contract.md).
    const hash = r.caseId.indexOf("#");
    const fixtureId = hash >= 0 ? r.caseId.slice(hash + 1) : r.caseId;
    out.push({
      caseId: r.caseId,
      configId,
      fixtureId,
      detail: d,
      score,
      pass: r.pass,
      survivalRate: isRecord(d.survival) ? num(d.survival.rate) : null,
      outboundTokens: num(d.outboundTokens),
    });
  }
  return out;
}

/** Compact knob readout: `rows≤250 · dedup · win:all · rel≥0.2`. */
function knobAbbrev(knobs: Record<string, unknown>): string {
  const parts: string[] = [];
  const rows = num(knobs.maxRows);
  if (rows !== null) parts.push(`rows≤${rows}`);
  if (typeof knobs.dedup === "boolean") parts.push(knobs.dedup ? "dedup" : "no-dedup");
  if (typeof knobs.temporalWindow === "string") parts.push(`win:${knobs.temporalWindow}`);
  const rel = num(knobs.minRelevance);
  if (rel !== null) parts.push(`rel≥${rel}`);
  const known = new Set(["maxRows", "dedup", "temporalWindow", "minRelevance"]);
  for (const [k, v] of Object.entries(knobs)) {
    if (!known.has(k)) parts.push(`${k}:${String(v)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

// ---- presentation ----------------------------------------------------------

const headingStyle = { fontSize: 15, fontWeight: 600, margin: 0 };
const monoCell = { fontFamily: "var(--font-mono)", fontSize: 12 };
const mutedStyle = { color: "var(--fg-muted)", fontSize: 13 };

function Tile({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  color?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: color ?? "var(--fg-default)" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: "var(--fg-subtle)" }}>{sub}</div>}
    </div>
  );
}

export function CurationRunDetail({ results, meta }: FamilyRunDetailProps) {
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined);

  const facts = useMemo(() => extractFacts(results), [results]);
  const tableRows = useMemo(() => curationConfigTable(results), [results]);

  const curation = meta.curation;
  const declaredRaw = curation?.frontier;
  // Non-empty declared list ⇒ authoritative (matches curationFrontierDeclared).
  const declared =
    Array.isArray(declaredRaw) && declaredRaw.length > 0
      ? (declaredRaw as readonly { configId?: unknown }[])
      : null;
  const points = useMemo(() => curationFrontierDeclared(results, declared), [results, declared]);
  const paretoIds = useMemo(
    () => new Set(points.filter((p) => p.onFrontier).map((p) => p.configId)),
    [points],
  );

  const sourceSetId =
    typeof curation?.sourceSetId === "string" && curation.sourceSetId.length > 0
      ? curation.sourceSetId
      : null;
  const scoreboardMd =
    typeof curation?.scoreboardMd === "string" && curation.scoreboardMd.trim().length > 0
      ? curation.scoreboardMd
      : null;

  const s = meta.summary;
  const fixtureCount = new Set(facts.map((f) => f.fixtureId)).size;
  const survivalValues = facts.map((f) => f.survivalRate).filter((v): v is number => v !== null);
  const tokenValues = facts.map((f) => f.outboundTokens).filter((v): v is number => v !== null);
  const maxTokens = tableRows.reduce(
    (m, r) => (r.outboundTokens !== null && r.outboundTokens > m ? r.outboundTokens : m),
    1,
  );

  return (
    <div
      data-testid="curation-run-detail"
      style={{ display: "flex", flexDirection: "column", gap: 20 }}
    >
      {/* Header tiles from meta.summary */}
      <Card>
        <div
          data-testid="curation-summary-tiles"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
            gap: 16,
          }}
        >
          <Tile
            label="Best survival"
            value={pct(s?.survivalBest)}
            sub={
              s?.tokensAtBest !== undefined ? `@ ${s.tokensAtBest.toLocaleString()} tok` : undefined
            }
            color={s?.survivalBest !== undefined ? "var(--green)" : undefined}
          />
          <Tile label="Compression" value={pct100(s?.compressionPct)} />
          <Tile
            label="Pareto"
            value={`${s?.paretoCount ?? paretoIds.size}/${s?.configCount ?? tableRows.length}`}
            sub="configs on front"
          />
          <Tile label="Configs" value={s?.configCount ?? tableRows.length} />
          <Tile label="Fixtures" value={fixtureCount > 0 ? fixtureCount : "—"} />
        </div>
      </Card>

      {/* Pareto frontier — declared-wins-else-compute */}
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <h2 style={headingStyle}>Pareto frontier · survival vs outbound tokens</h2>
          <Badge
            tone={declared ? "accent" : "muted"}
            title={
              declared
                ? "Front declared by the source bench (meta.curation.frontier) — authoritative over client recompute"
                : "No declared front on run meta — dominance recomputed client-side"
            }
          >
            frontier · {declared ? "declared" : "computed"}
          </Badge>
        </div>
        {points.length > 0 ? (
          <FrontierScatter points={points} />
        ) : (
          <div style={mutedStyle}>No curation-facts details on this run's results.</div>
        )}
      </Card>

      {/* Distributions */}
      {(survivalValues.length > 0 || tokenValues.length > 0) && (
        <Card>
          <h2 style={{ ...headingStyle, marginBottom: 10 }}>Per-fixture distributions</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
            <div style={{ flex: "1 1 300px", minWidth: 260 }}>
              <Histogram
                values={survivalValues}
                bins={8}
                height={150}
                label="Gold-fact survival distribution"
                formatValue={(v) => v.toFixed(2)}
              />
            </div>
            <div style={{ flex: "1 1 300px", minWidth: 260 }}>
              <Histogram
                values={tokenValues}
                bins={8}
                height={150}
                label="Outbound tokens distribution"
                formatValue={(v) => String(Math.round(v))}
              />
            </div>
          </div>
        </Card>
      )}

      {/* Config table (survival↓ then tokens↑ — the aggregate's ordering) */}
      <div>
        <h2 style={{ ...headingStyle, marginBottom: 8 }}>Configs · survival ↓ · tokens ↑</h2>
        <DataTable<CurationConfigRow>
          columns={[
            {
              key: "configId",
              header: "Config",
              render: (row) => {
                const onFront = paretoIds.has(row.configId);
                return (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span
                      data-testid="config-id"
                      style={{
                        ...monoCell,
                        color: onFront ? "var(--accent)" : undefined,
                        fontWeight: onFront ? 600 : 400,
                      }}
                    >
                      {row.configId}
                    </span>
                    {onFront && <Badge tone="accent">pareto</Badge>}
                  </span>
                );
              },
            },
            {
              key: "knobs",
              header: "Knobs",
              render: (row) => (
                <span
                  style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}
                >
                  {knobAbbrev(row.knobs)}
                </span>
              ),
            },
            { key: "n", header: "N", align: "right", render: (row) => String(row.n) },
            {
              key: "survival",
              header: "Survival",
              render: (row) => (
                <MeterCell value={row.survival} format={(v) => `${Math.round(v * 100)}%`} />
              ),
            },
            {
              key: "outboundTokens",
              header: "Tokens",
              render: (row) => (
                <BarCell
                  value={row.outboundTokens}
                  max={maxTokens}
                  format={(v) => Math.round(v).toLocaleString()}
                />
              ),
            },
            {
              key: "compressionPct",
              header: "Compr",
              render: (row) => (
                <BarCell
                  value={row.compressionPct}
                  max={100}
                  width={48}
                  format={(v) => `${Math.round(v)}%`}
                />
              ),
            },
            {
              key: "dealMinShare",
              header: "Min share",
              render: (row) => (
                <BarCell value={row.dealMinShare} width={48} format={(v) => v.toFixed(2)} />
              ),
            },
            {
              key: "zeroRowDeals",
              header: "Zero-row",
              align: "right",
              render: (row) => fmtNum(row.zeroRowDeals),
            },
            {
              key: "nearDupRate",
              header: "Near-dup",
              align: "right",
              render: (row) => pct(row.nearDupRate),
            },
            {
              key: "deadRowRate",
              header: "Dead-row",
              align: "right",
              render: (row) => pct(row.deadRowRate),
            },
            {
              key: "temporalSpreadDays",
              header: "Spread",
              align: "right",
              render: (row) =>
                row.temporalSpreadDays === null ? "—" : `${Math.round(row.temporalSpreadDays)}d`,
            },
            {
              key: "temporalAlignment",
              header: "T-align",
              align: "right",
              // Not exposed by curationConfigTable today — renders "—" until
              // the aggregate carries it (render-what-the-aggregate-exposes).
              render: (row) => pct(row.temporalAlignment),
            },
          ]}
          data={tableRows}
          rowKey={(row) => row.configId}
          expandedKey={expandedKey}
          onToggleExpand={(key) => setExpandedKey((prev) => (prev === key ? undefined : key))}
          renderExpanded={(row) => {
            const rowFacts = facts.filter((f) => f.configId === row.configId);
            if (rowFacts.length === 0) {
              return <div style={mutedStyle}>No per-fixture curation-facts details.</div>;
            }
            return (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                  gap: 12,
                }}
              >
                {rowFacts.map((f) => (
                  <Card key={f.caseId} inset style={{ padding: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {sourceSetId ? (
                        <Link
                          to={`/eval/sets/${encodeURIComponent(sourceSetId)}/cases/${encodeURIComponent(f.fixtureId)}`}
                          style={{ ...monoCell, color: "var(--accent)", textDecoration: "none" }}
                          title="View this bundle fixture"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {f.fixtureId} →
                        </Link>
                      ) : (
                        <span style={monoCell}>{f.fixtureId}</span>
                      )}
                      <Badge tone={f.pass === true ? "green" : f.pass === false ? "red" : "muted"}>
                        {f.pass === true ? "pass" : f.pass === false ? "fail" : "ungated"}
                      </Badge>
                    </div>
                    <CurationFactsDetail detail={f.detail} score={f.score} />
                  </Card>
                ))}
              </div>
            );
          }}
        />
      </div>

      {/* Bench scoreboard (markdown, verbatim from the source bench) */}
      {scoreboardMd && (
        <Card>
          <h2 style={{ ...headingStyle, marginBottom: 8 }}>Bench scoreboard</h2>
          <div data-testid="curation-scoreboard">
            <Markdown content={scoreboardMd} />
          </div>
        </Card>
      )}
    </div>
  );
}
