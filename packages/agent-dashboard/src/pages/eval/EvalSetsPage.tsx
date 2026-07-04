/**
 * /eval/sets — the eval set (case-bank) browser (WI-3).
 *
 * One-shot mount fetch (`fetchEvalSets`) + a ghost Refresh, the `EvalRunsPage`
 * idiom. Each set shows its case count and a per-split badge row (train / dev /
 * test / untagged), and a row click drills into the set detail. Editing (New
 * set) lands in WI-5 — the header action is a stub here.
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { EvalSetSummary } from "../../api/types";
import { Badge } from "../../components/atoms/Badge";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { Spinner } from "../../components/atoms/Spinner";
import { AlertIcon } from "../../components/atoms/icons";
import { DataTable } from "../../components/organisms/DataTable";
import { fetchEvalSets } from "../../lib/evalApi";

// pages never share code (playground-redesign.md) — lifted local.
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

/** Split buckets in canonical order; `""` is the untagged bucket. */
const SPLIT_ORDER: ReadonlyArray<{ key: string; label: string }> = [
  { key: "train", label: "train" },
  { key: "dev", label: "dev" },
  { key: "test", label: "test" },
  { key: "", label: "untagged" },
];

type LoadState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string }
  | { kind: "ok"; sets: EvalSetSummary[] };

export function EvalSetsPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const result = await fetchEvalSets();
      setState(
        result.kind === "unconfigured"
          ? { kind: "unconfigured" }
          : { kind: "ok", sets: result.data },
      );
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Eval Sets</h1>
        <Button variant="ghost" size="sm" onClick={load}>
          Refresh
        </Button>
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
          <span>Loading eval sets...</span>
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
              Failed to load eval sets
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

      {state.kind === "ok" && state.sets.length === 0 && (
        <Card style={{ textAlign: "center", padding: 40, color: "var(--fg-muted)" }}>
          <div style={{ fontWeight: 600, color: "var(--fg-default)", marginBottom: 6 }}>
            No eval sets yet
          </div>
          <div style={{ fontSize: 14 }}>
            Run <code>ap eval</code> against a case bank, or capture an exchange from Chat, to
            populate this list.
          </div>
        </Card>
      )}

      {state.kind === "ok" && state.sets.length > 0 && (
        <Card padded={false}>
          <DataTable<EvalSetSummary>
            columns={[
              {
                key: "id",
                header: "Set",
                render: (row) => (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{row.id}</span>
                ),
              },
              { key: "name", header: "Name", render: (row) => row.name ?? "—" },
              {
                key: "caseCount",
                header: "Cases",
                align: "right",
                render: (row) => row.caseCount,
              },
              {
                key: "splits",
                header: "Splits",
                render: (row) => <SplitCounts counts={row.splitCounts} />,
              },
              {
                key: "createdTs",
                header: "Created",
                render: (row) => relative(row.createdTs),
              },
            ]}
            data={state.sets}
            rowKey={(row) => row.id}
            onRowClick={(row) => navigate(`/eval/sets/${row.id}`)}
          />
        </Card>
      )}
    </div>
  );
}

/** Per-split count badges — only non-zero buckets render; `test` is toned. */
function SplitCounts({ counts }: { counts: Record<string, number> }) {
  const present = SPLIT_ORDER.filter((b) => (counts[b.key] ?? 0) > 0);
  if (present.length === 0) return <span style={{ color: "var(--fg-subtle)" }}>—</span>;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6 }}>
      {present.map((b) => (
        <Badge key={b.key || "untagged"} tone={b.key === "test" ? "yellow" : "muted"}>
          {b.label} {counts[b.key]}
        </Badge>
      ))}
    </span>
  );
}
