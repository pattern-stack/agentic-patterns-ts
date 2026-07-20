/**
 * CurationHomeTable — the curation-family section table on `/eval` (slice 5).
 *
 * One row per curation sweep, headline numbers off `readRunMeta(run)?.summary`
 * (list grain rides `meta.summary` — no per-case fetch). Curation has no judge
 * lens (contract: "curation uses survival, not a judge lens") — the headline
 * is survivalBest @ tokensAtBest, plus the Pareto count and a frontier-source
 * chip: "declared" when the run carries `meta.curation.frontier` (the bench's
 * canonical front, declared-wins), else "computed" (client dominance
 * recompute). Fixture count is derived: result rows are `configId#fixtureId`
 * composites, so fixtures = cases / configCount. Missing summary fields render
 * "—", never 0/NaN. The id cell links to the run detail (URL-encoded id) and
 * the row itself navigates there too.
 */

import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { EvalRunRow } from "../../../../api/types";
import { Badge } from "../../../../components/atoms/Badge";
import { DataTable } from "../../../../components/organisms/DataTable";
import type { FamilyHomeTableProps } from "../index";
import { type RunMeta, readRunMeta } from "../types";

// pages never share code (playground-redesign.md) — small local formatters.
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
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

function tokText(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k tok` : `${Math.round(v)} tok`;
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

/**
 * Fixtures per config — derivable because curation result rows are
 * `configId#fixtureId` composites (cases = configs × fixtures). Null when the
 * counts are missing or don't divide evenly.
 */
function fixtureCount(run: EvalRunRow, meta: RunMeta | null): number | null {
  const cases = run.summary?.cases;
  const configs = meta?.summary?.configCount;
  if (cases === undefined || configs === undefined || configs <= 0) return null;
  const fixtures = cases / configs;
  return Number.isInteger(fixtures) ? fixtures : null;
}

/** "declared" when the run ships a canonical frontier; else "computed". */
function frontierSource(meta: RunMeta | null): "declared" | "computed" {
  const front = meta?.curation?.frontier;
  return Array.isArray(front) && front.length > 0 ? "declared" : "computed";
}

interface Row {
  run: EvalRunRow;
  meta: RunMeta | null;
}

export function CurationHomeTable({ runs }: FamilyHomeTableProps) {
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
              title={run.id}
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
          key: "configs",
          header: "Configs",
          render: ({ meta }) => {
            const configs = meta?.summary?.configCount;
            return cell(configs === undefined ? null : String(configs), "Swept configs");
          },
        },
        {
          key: "fixtures",
          header: "Fixtures",
          render: ({ run, meta }) => {
            const fixtures = fixtureCount(run, meta);
            return cell(fixtures === null ? null : String(fixtures), "Fixtures per config");
          },
        },
        {
          key: "survival",
          header: "Survival @ tokens",
          render: ({ meta }) => {
            const survival = meta?.summary?.survivalBest;
            if (survival === undefined) return cell(null);
            const tokens = meta?.summary?.tokensAtBest;
            const pct = `${Math.round(survival * 100)}%`;
            return cell(
              tokens === undefined ? pct : `${pct} @ ${tokText(tokens)}`,
              "Best expectation survival · outbound tokens at that config",
            );
          },
        },
        {
          key: "compression",
          header: "Compression",
          render: ({ meta }) => {
            const v = meta?.summary?.compressionPct;
            if (v === undefined) return cell(null);
            return cell(`${Number.isInteger(v) ? v : v.toFixed(1)}%`, "Compression at best config");
          },
        },
        {
          key: "pareto",
          header: "Pareto",
          render: ({ meta }) => {
            const pareto = meta?.summary?.paretoCount;
            const configs = meta?.summary?.configCount;
            if (pareto === undefined || configs === undefined) return cell(null);
            return cell(`${pareto}/${configs}`, "Configs on the survival-vs-tokens frontier");
          },
        },
        {
          key: "frontier",
          header: "Frontier",
          render: ({ meta }) => {
            const source = frontierSource(meta);
            return (
              <Badge
                tone={source === "declared" ? "purple" : "muted"}
                title={
                  source === "declared"
                    ? "Frontier declared by the bench (meta.curation.frontier)"
                    : "Frontier recomputed client-side (dominance)"
                }
              >
                {source}
              </Badge>
            );
          },
        },
      ]}
      data={rows}
      rowKey={(r) => r.run.id}
      onRowClick={(r) => navigate(`/eval/runs/${encodeURIComponent(r.run.id)}`)}
    />
  );
}
