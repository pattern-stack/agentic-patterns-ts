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
import { AsyncState } from "../../components/kit/AsyncState";
import { PageHeader } from "../../components/kit/PageHeader";
import { DataTable } from "../../components/organisms/DataTable";
import { fetchEvalSets } from "../../lib/evalApi";
import { relTime } from "../../lib/format";
import { SetEditModal } from "./SetEditModal";

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
  const [showNew, setShowNew] = useState(false);

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
      <PageHeader
        title="Eval Sets"
        actions={
          <>
            <Button size="sm" onClick={() => setShowNew(true)}>
              New set
            </Button>
            <Button variant="ghost" size="sm" onClick={load}>
              Refresh
            </Button>
          </>
        }
      />

      {showNew && (
        <SetEditModal
          mode="create"
          onClose={() => setShowNew(false)}
          onSaved={(set) => {
            setShowNew(false);
            navigate(`/eval/sets/${set.id}`);
          }}
        />
      )}

      {state.kind !== "ok" && (
        <AsyncState
          kind={state.kind}
          loading="Loading eval sets..."
          error={
            state.kind === "error"
              ? { title: "Failed to load eval sets", message: state.message }
              : undefined
          }
        />
      )}

      {state.kind === "ok" && state.sets.length === 0 && (
        <AsyncState
          kind="empty"
          empty={{
            title: "No eval sets yet",
            body: (
              <>
                Run <code>ap eval</code> against a case bank, or capture an exchange from Chat, to
                populate this list.
              </>
            ),
          }}
        />
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
              {
                key: "name",
                header: "Name",
                render: (row) => (
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 3, padding: "2px 0" }}
                    title={row.description ?? undefined}
                  >
                    <span style={{ fontWeight: 500, color: "var(--ink)" }}>{row.name ?? "—"}</span>
                    {row.description && (
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--mute)",
                          lineHeight: 1.4,
                          maxWidth: 440,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {row.description}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                key: "caseCount",
                header: "Cases",
                align: "right",
                render: (row) => row.caseCount,
              },
              {
                key: "splits",
                header: "Splits",
                hideBelow: "sm",
                render: (row) => <SplitCounts counts={row.splitCounts} />,
              },
              {
                key: "createdTs",
                header: "Created",
                hideBelow: "md",
                render: (row) => relTime(row.createdTs),
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
  if (present.length === 0) return <span style={{ color: "var(--ink-3)" }}>—</span>;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6 }}>
      {present.map((b) => (
        <Badge key={b.key || "untagged"} tone={b.key === "test" ? "warn" : "mute"}>
          {b.label} {counts[b.key]}
        </Badge>
      ))}
    </span>
  );
}
