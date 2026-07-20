/**
 * Answer-bank set view — the fixtures explorer over frozen markdown deal
 * states + goldens, replacing the generic raw input/expected split-grouped
 * case tables (THE ONE UI LAW: replace, never decorate).
 *
 * Every column is computed CLIENT-SIDE from the case input (the bank case
 * shape: `input` = deal-state markdown, `expected` = golden markdown):
 * words/chars, distinct `[evidence-N]` refs, the `(opp-NNNN)` provenance id in
 * the state heading, and the regime (grounded when the state carries evidence
 * markers). `bankStatsOf` is exported so `BankCaseView`'s stat tiles read the
 * same derivation.
 */

import { useNavigate } from "react-router-dom";
import type { EvalCaseRow, EvalRunRow } from "../../../../api/types";
import { Badge, type BadgeTone } from "../../../../components/atoms/Badge";
import { Card } from "../../../../components/atoms/Card";
import { Chip } from "../../../../components/atoms/Chip";
import { DataTable } from "../../../../components/organisms/DataTable";
import type { FamilySetViewProps } from "../index";

export interface BankCaseStats {
  fid: string;
  /** Heading title with the "Deal state — " prefix and provenance suffix stripped. */
  title: string;
  words: number;
  /** Distinct `[evidence-N]` markers in the state. */
  refs: number;
  chars: number;
  /** The `opp-NNNN` id in the state heading, when present. */
  provenance: string | null;
  regime: "grounded" | "unreferenced";
}

const EVIDENCE_RE = /\[evidence-(\d+)\]/g;

/** Client-side stats for a bank case; tolerates a non-string input (all zeros). */
export function bankStatsOf(row: EvalCaseRow): BankCaseStats {
  const state = typeof row.input === "string" ? row.input : "";
  const refs = new Set<string>();
  EVIDENCE_RE.lastIndex = 0;
  for (let m = EVIDENCE_RE.exec(state); m; m = EVIDENCE_RE.exec(state)) {
    refs.add(m[1] ?? "");
  }
  const heading = state.match(/^#+\s+(.+)$/m)?.[1] ?? "";
  const provenance = heading.match(/\bopp-\d+\b/)?.[0] ?? null;
  const title =
    heading
      .replace(/^Deal state\s*—\s*/, "")
      .replace(/\s*\(opp-\d+\)\s*$/, "")
      .trim() || row.caseId;
  return {
    fid: row.caseId,
    title,
    words: state.trim() === "" ? 0 : state.trim().split(/\s+/).length,
    refs: refs.size,
    chars: state.length,
    provenance,
    regime: refs.size > 0 ? "grounded" : "unreferenced",
  };
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

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
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

interface StatRow extends BankCaseStats {
  row: EvalCaseRow;
}

export function BankSetView({ set, cases, runs }: FamilySetViewProps) {
  const navigate = useNavigate();
  const rows: StatRow[] = cases.map((row) => ({ ...bankStatsOf(row), row }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <Badge tone="purple">answer-bank</Badge>
          <Badge tone="muted">states · {cases.length}</Badge>
          <Badge tone="muted">created · {relative(set.createdTs)}</Badge>
        </div>
        {set.description && (
          <div style={{ marginTop: 10, fontSize: 14, color: "var(--fg-muted)" }}>
            {set.description}
          </div>
        )}
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Deal states</h2>
        {rows.length === 0 ? (
          <Card style={{ textAlign: "center", padding: 32, color: "var(--fg-muted)" }}>
            No deal states loaded for this bank.
          </Card>
        ) : (
          <Card padded={false}>
            <DataTable<StatRow>
              columns={[
                {
                  key: "fid",
                  header: "Fid",
                  render: (r) => (
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{r.fid}</span>
                  ),
                },
                { key: "title", header: "Title", render: (r) => r.title },
                {
                  key: "regime",
                  header: "Regime",
                  render: (r) => (
                    <Badge tone={r.regime === "grounded" ? "green" : "muted"}>{r.regime}</Badge>
                  ),
                },
                { key: "words", header: "Words", align: "right", render: (r) => r.words },
                { key: "refs", header: "Refs", align: "right", render: (r) => r.refs },
                { key: "chars", header: "Chars", align: "right", render: (r) => r.chars },
                {
                  key: "provenance",
                  header: "Provenance",
                  render: (r) =>
                    r.provenance ? (
                      <Chip tone="mono">{r.provenance}</Chip>
                    ) : (
                      <span style={{ color: "var(--fg-subtle)" }}>—</span>
                    ),
                },
              ]}
              data={rows}
              rowKey={(r) => r.fid}
              onRowClick={(r) =>
                navigate(
                  `/eval/sets/${encodeURIComponent(set.id)}/cases/${encodeURIComponent(r.fid)}`,
                )
              }
            />
          </Card>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Runs against this set</h2>
        {runs.length === 0 ? (
          <Card style={{ textAlign: "center", padding: 32, color: "var(--fg-muted)" }}>
            No runs against this set yet.
          </Card>
        ) : (
          <Card padded={false}>
            <DataTable<EvalRunRow>
              columns={[
                {
                  key: "id",
                  header: "Run",
                  render: (row) => (
                    <span title={row.id} style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {shortId(row.id)}
                    </span>
                  ),
                },
                { key: "targetId", header: "Target", render: (row) => row.targetId ?? "—" },
                {
                  key: "status",
                  header: "Status",
                  render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
                },
                { key: "tsStart", header: "Started", render: (row) => relative(row.tsStart) },
              ]}
              data={[...runs]}
              rowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/eval/runs/${encodeURIComponent(row.id)}`)}
            />
          </Card>
        )}
      </div>
    </div>
  );
}
