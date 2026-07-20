/**
 * Question-bundle set view — the fixtures explorer (question / scope / as_of
 * from the case input, gold-expectation counts from
 * `expected.ground_truth.expectations` via `parseExpectations`), replacing the
 * generic raw input/expected split-grouped case tables.
 *
 * Filters are client-side facets over the loaded cases: split (the bank
 * split) and request family (the scope's `deal:`/`portfolio:` prefix — the
 * kind of retrieval request the fixture exercises). The review chip reads an
 * optional `input.review` string; absent (the cache-sourced seed shape) shows
 * "—", never a fabricated state.
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { EvalCaseRow, EvalRunRow } from "../../../../api/types";
import { Badge, type BadgeTone } from "../../../../components/atoms/Badge";
import { Card } from "../../../../components/atoms/Card";
import { Chip } from "../../../../components/atoms/Chip";
import { DataTable } from "../../../../components/organisms/DataTable";
import type { FamilySetViewProps } from "../index";
import { parseExpectations } from "./ExpectationCards";

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

interface FixtureRow {
  row: EvalCaseRow;
  fixtureId: string;
  question: string | null;
  scope: string | null;
  asOf: string | null;
  review: string | null;
  /** The scope's kind prefix (`deal` / `portfolio` / …); "unscoped" when absent. */
  requestFamily: string;
  requiredCount: number;
  totalCount: number;
}

function fixtureRowOf(row: EvalCaseRow): FixtureRow {
  const input = isRecord(row.input) ? row.input : {};
  const scope = typeof input.scope === "string" ? input.scope : null;
  const expectations = parseExpectations(row.expected);
  return {
    row,
    fixtureId: row.caseId,
    question: typeof input.question === "string" ? input.question : null,
    scope,
    asOf: typeof input.as_of === "string" ? input.as_of : null,
    review: typeof input.review === "string" ? input.review : null,
    requestFamily: scope?.includes(":") ? (scope.split(":")[0] ?? "unscoped") : "unscoped",
    requiredCount: expectations.filter((e) => e.required).length,
    totalCount: expectations.length,
  };
}

function truncate(s: string, max = 88): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        padding: "2px 9px",
        borderRadius: 999,
        fontSize: 12,
        cursor: "pointer",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "rgba(88, 166, 255, 0.12)" : "var(--bg-inset)",
        color: active ? "var(--accent)" : "var(--fg-muted)",
      }}
    >
      {label}
    </button>
  );
}

export function BundleSetView({ set, cases, runs, meta }: FamilySetViewProps) {
  const navigate = useNavigate();
  const [splitFilter, setSplitFilter] = useState<string | null>(null);
  const [familyFilter, setFamilyFilter] = useState<string | null>(null);

  const fixtures = useMemo(() => cases.map(fixtureRowOf), [cases]);
  const splits = useMemo(
    () => [...new Set(fixtures.map((f) => f.row.split ?? "untagged"))],
    [fixtures],
  );
  const requestFamilies = useMemo(
    () => [...new Set(fixtures.map((f) => f.requestFamily))],
    [fixtures],
  );

  const shown = fixtures.filter(
    (f) =>
      (splitFilter === null || (f.row.split ?? "untagged") === splitFilter) &&
      (familyFilter === null || f.requestFamily === familyFilter),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Badge tone="accent">question-bundle</Badge>
          {meta.source && (
            <Chip tone={meta.source === "authoring" ? "accent" : "mono"}>{meta.source}</Chip>
          )}
          {meta.benchmark && (
            <span
              style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}
            >
              {meta.benchmark}
              {meta.version ? `@${meta.version}` : ""}
            </span>
          )}
          {meta.dataset && <Chip tone="neutral">{meta.dataset}</Chip>}
          {meta.families?.map((f) => (
            <Chip key={f} tone="mono">
              {f}
            </Chip>
          ))}
          <Badge tone="muted">fixtures · {cases.length}</Badge>
          <Badge tone="muted">created · {relative(meta.createdAt ?? set.createdTs)}</Badge>
        </div>
        {set.description && (
          <div style={{ marginTop: 10, fontSize: 14, color: "var(--fg-muted)" }}>
            {set.description}
          </div>
        )}
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Fixtures</h2>
        {(splits.length > 1 || requestFamilies.length > 1) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
            {splits.length > 1 && (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>split</span>
                <FilterChip
                  label="all"
                  active={splitFilter === null}
                  onClick={() => setSplitFilter(null)}
                />
                {splits.map((s) => (
                  <FilterChip
                    key={s}
                    label={s}
                    active={splitFilter === s}
                    onClick={() => setSplitFilter((prev) => (prev === s ? null : s))}
                  />
                ))}
              </span>
            )}
            {requestFamilies.length > 1 && (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>request family</span>
                <FilterChip
                  label="all"
                  active={familyFilter === null}
                  onClick={() => setFamilyFilter(null)}
                />
                {requestFamilies.map((f) => (
                  <FilterChip
                    key={f}
                    label={f}
                    active={familyFilter === f}
                    onClick={() => setFamilyFilter((prev) => (prev === f ? null : f))}
                  />
                ))}
              </span>
            )}
          </div>
        )}
        {shown.length === 0 ? (
          <Card style={{ textAlign: "center", padding: 32, color: "var(--fg-muted)" }}>
            {cases.length === 0
              ? "No fixtures loaded for this bundle."
              : "No fixtures match the current filters."}
          </Card>
        ) : (
          <Card padded={false}>
            <DataTable<FixtureRow>
              columns={[
                {
                  key: "fixtureId",
                  header: "Fixture",
                  render: (r) => (
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {r.fixtureId}
                    </span>
                  ),
                },
                {
                  key: "question",
                  header: "Question",
                  render: (r) =>
                    r.question ? (
                      <span title={r.question}>{truncate(r.question)}</span>
                    ) : (
                      <span style={{ color: "var(--fg-subtle)" }}>—</span>
                    ),
                },
                {
                  key: "scope",
                  header: "Scope",
                  render: (r) =>
                    r.scope ? (
                      <Chip tone="mono">{r.scope}</Chip>
                    ) : (
                      <span style={{ color: "var(--fg-subtle)" }}>—</span>
                    ),
                },
                { key: "asOf", header: "As of", render: (r) => r.asOf ?? "—" },
                {
                  key: "split",
                  header: "Split",
                  render: (r) => (
                    <Badge tone={r.row.split === "test" ? "yellow" : "muted"}>
                      {r.row.split ?? "untagged"}
                    </Badge>
                  ),
                },
                {
                  key: "gold",
                  header: "Gold",
                  align: "right",
                  render: (r) =>
                    r.totalCount > 0 ? (
                      `${r.requiredCount} req / ${r.totalCount}`
                    ) : (
                      <span style={{ color: "var(--fg-subtle)" }}>—</span>
                    ),
                },
                {
                  key: "review",
                  header: "Review",
                  render: (r) =>
                    r.review ? (
                      <Chip tone="accent">{r.review}</Chip>
                    ) : (
                      <span style={{ color: "var(--fg-subtle)" }}>—</span>
                    ),
                },
              ]}
              data={shown}
              rowKey={(r) => r.fixtureId}
              onRowClick={(r) =>
                navigate(
                  `/eval/sets/${encodeURIComponent(set.id)}/cases/${encodeURIComponent(
                    r.fixtureId,
                  )}`,
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
