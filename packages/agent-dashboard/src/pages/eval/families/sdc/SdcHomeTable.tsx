/**
 * SdcHomeTable — the SDC-family section table on `/eval` (slice 5).
 *
 * One row per single-deal-context bench run, headline numbers off
 * `readRunMeta(run)?.summary` (list grain rides `meta.summary` — no per-case
 * fetch). The two-lens cell pairs the deterministic fixture pass-rate with the
 * judge verdict ratio (`judgeLens.kind:"ratio"` ⇒ k/n); the hybrid meter reads
 * the run's DECLARED axis map (`meta.sdc.scores.hybrid` — canonical
 * scores.json, contract "declared-wins"); latency p50 is a magnitude bar
 * normalized against the section's slowest run. Missing summary fields render
 * "—", never 0/NaN. The id cell links to the run detail (URL-encoded id) and
 * the row itself navigates there too.
 */

import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { EvalRunRow } from "../../../../api/types";
import { DataTable } from "../../../../components/organisms/DataTable";
import { MeterCell } from "../../charts/MeterCell";
import { BarCell } from "../../components/BarCell";
import { TwoLensCell } from "../../components/TwoLensCell";
import type { FamilyHomeTableProps } from "../index";
import { type RunMeta, readRunMeta } from "../types";

// pages never share code (playground-redesign.md) — small local formatters.
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

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

function usdText(v: number | undefined): string | null {
  if (v === undefined || !Number.isFinite(v)) return null;
  return `$${v.toFixed(v < 0.1 ? 4 : 2)}`;
}

function msText(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

/** Mono cell text, or the muted em-dash for a missing summary field. */
function cell(text: string | null, title?: string): ReactNode {
  if (text === null) return <span style={{ color: "var(--fg-subtle)" }}>—</span>;
  return (
    <span title={title} style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
      {text}
    </span>
  );
}

/** The declared run-level hybrid score (`meta.sdc.scores.hybrid`), or null. */
function declaredHybrid(meta: RunMeta | null): number | null {
  const scores = meta?.sdc?.scores;
  if (typeof scores !== "object" || scores === null) return null;
  const v = (scores as Record<string, unknown>).hybrid;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface Row {
  run: EvalRunRow;
  meta: RunMeta | null;
}

export function SdcHomeTable({ runs }: FamilyHomeTableProps) {
  const navigate = useNavigate();
  const rows: Row[] = runs.map((run) => ({ run, meta: readRunMeta(run) }));
  // Normalize the latency bars against the section's slowest run so bar
  // lengths are comparable across rows.
  const latencyMax = rows.reduce((m, r) => Math.max(m, r.meta?.summary?.latencyP50 ?? 0), 0);

  return (
    <DataTable<Row>
      columns={[
        {
          key: "id",
          header: "Run",
          render: ({ run }) => (
            <Link
              to={`/eval/runs/${encodeURIComponent(run.id)}`}
              onClick={(e) => e.stopPropagation()}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--accent)",
                textDecoration: "none",
              }}
            >
              {shortId(run.id)}
            </Link>
          ),
        },
        { key: "started", header: "Started", render: ({ run }) => relative(run.tsStart) },
        { key: "model", header: "Model", render: ({ run }) => cell(run.model) },
        {
          key: "cases",
          header: "Fixtures",
          render: ({ run, meta }) => {
            const crashed = meta?.summary?.crashedCount;
            const title =
              crashed !== undefined && crashed > 0
                ? `Graded fixtures — plus ${crashed} crashed (meta.sdc.failures)`
                : "Graded fixtures";
            return cell(run.summary ? String(run.summary.cases) : null, title);
          },
        },
        {
          key: "lenses",
          header: "Det / Judge",
          render: ({ run, meta }) => (
            <TwoLensCell summary={meta?.summary} detPassRate={run.summary?.passRate} />
          ),
        },
        {
          key: "hybrid",
          header: "Hybrid",
          render: ({ meta }) => <MeterCell value={declaredHybrid(meta)} />,
        },
        {
          key: "cost",
          header: "Cost",
          render: ({ meta }) => cell(usdText(meta?.summary?.costUsd), "Answer cost (excl. judge)"),
        },
        {
          key: "latency",
          header: "Latency p50",
          render: ({ meta }) => (
            <BarCell
              value={meta?.summary?.latencyP50 ?? null}
              max={latencyMax > 0 ? latencyMax : 1}
              format={msText}
            />
          ),
        },
      ]}
      data={rows}
      rowKey={(r) => r.run.id}
      onRowClick={(r) => navigate(`/eval/runs/${encodeURIComponent(r.run.id)}`)}
    />
  );
}
