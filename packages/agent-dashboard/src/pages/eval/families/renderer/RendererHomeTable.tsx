/**
 * RendererHomeTable — the renderer-family section table on `/eval` (slice 5).
 *
 * One row per render-grid run, headline numbers read from `readRunMeta(run)
 * ?.summary` only (the contract's home-table rule: list grain rides
 * `meta.summary` — no per-case fetch). The two-lens cell pairs the
 * deterministic gate pass-rate with the judge readability mean
 * (`judgeLens.kind:"mean"`); missing summary fields render "—", never 0/NaN.
 * The id cell links to the run detail (URL-encoded id) and the row itself
 * navigates there too.
 */

import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { EvalRunRow } from "../../../../api/types";
import { DataTable } from "../../../../components/organisms/DataTable";
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

function pctText(v: number | undefined): string | null {
  return v === undefined ? null : `${Math.round(v * 100)}%`;
}

function usdText(v: number | undefined): string | null {
  if (v === undefined || !Number.isFinite(v)) return null;
  return `$${v.toFixed(v < 0.1 ? 4 : 2)}`;
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

interface Row {
  run: EvalRunRow;
  meta: RunMeta | null;
}

export function RendererHomeTable({ runs }: FamilyHomeTableProps) {
  const navigate = useNavigate();
  const rows: Row[] = runs.map((run) => ({ run, meta: readRunMeta(run) }));

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
        {
          key: "cases",
          header: "Renders",
          render: ({ run }) =>
            cell(run.summary ? String(run.summary.cases) : null, "Graded renders (grid cells)"),
        },
        {
          key: "lenses",
          header: "Det / Judge",
          render: ({ run, meta }) => (
            <TwoLensCell summary={meta?.summary} detPassRate={run.summary?.passRate} />
          ),
        },
        {
          key: "flags",
          header: "Flags",
          render: ({ meta }) => cell(pctText(meta?.summary?.flagsRate), "Flagged renders"),
        },
        {
          key: "fallback",
          header: "Fallback",
          render: ({ meta }) => cell(pctText(meta?.summary?.fallbackRate), "Fallback renders"),
        },
        {
          key: "retries",
          header: "Retries",
          render: ({ meta }) => cell(pctText(meta?.summary?.retriesRate), "Retried for length"),
        },
        {
          key: "perRender",
          header: "$ / render",
          render: ({ run, meta }) => {
            const cost = meta?.summary?.costUsd;
            const n = run.summary?.cases;
            const per = cost !== undefined && n !== undefined && n > 0 ? cost / n : undefined;
            return cell(usdText(per), "Render cost / graded renders");
          },
        },
        {
          key: "runCost",
          header: "Run $",
          render: ({ meta }) => {
            const cost = meta?.summary?.costUsd;
            if (cost === undefined) return cell(null);
            const judge = meta?.summary?.judgeCostUsd ?? 0;
            return cell(usdText(cost + judge), "Render + judge cost");
          },
        },
      ]}
      data={rows}
      rowKey={(r) => r.run.id}
      onRowClick={(r) => navigate(`/eval/runs/${encodeURIComponent(r.run.id)}`)}
    />
  );
}
