/**
 * Split aggregates panel — the train-vs-test overfit read, mounted on
 * `EvalRunsPage` (E5b, #138). Wired to the page's existing set/target/variant
 * facet filters (the `split` facet is deliberately not passed — this panel
 * *groups by* split). Aggregates the whole store, not the runs-table window.
 *
 * No chart library — the pass-rate meter is two nested divs.
 */

import { useEffect, useState } from "react";
import type { EvalSplit, SplitAggregate } from "../../api/types";
import { Badge } from "../../components/atoms/Badge";
import { Card } from "../../components/atoms/Card";
import { Spinner } from "../../components/atoms/Spinner";
import { type SplitAggregateFilters, fetchSplitAggregates } from "../../lib/evalApi";
import { overfitGap } from "../../lib/evalCompare";

const SPLIT_ORDER: ReadonlyArray<EvalSplit | null> = ["train", "dev", "test", null];

function orderBuckets(aggregates: readonly SplitAggregate[]): SplitAggregate[] {
  const rank = (split: EvalSplit | null) => {
    const i = SPLIT_ORDER.indexOf(split);
    return i === -1 ? SPLIT_ORDER.length : i;
  };
  return [...aggregates].sort((a, b) => rank(a.split) - rank(b.split));
}

type PanelState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string }
  | { kind: "ok"; aggregates: SplitAggregate[] };

interface SplitAggregatesPanelProps {
  filters: SplitAggregateFilters;
}

export function SplitAggregatesPanel({ filters }: SplitAggregatesPanelProps) {
  const [state, setState] = useState<PanelState>({ kind: "loading" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: filters is an object literal from the caller; its fields (set/target/variant) are the real dependency, not the object's identity.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ kind: "loading" });
      try {
        const result = await fetchSplitAggregates(filters);
        if (cancelled) return;
        setState(
          result.kind === "unconfigured"
            ? { kind: "unconfigured" }
            : { kind: "ok", aggregates: result.data },
        );
      } catch (e) {
        if (!cancelled) {
          setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters.set, filters.target, filters.variant]);

  // The page's own "eval persistence is not configured" card already covers
  // this state — no duplicate message here.
  if (state.kind === "unconfigured") {
    return null;
  }

  const scoped = Boolean(filters.set || filters.target || filters.variant);
  const gap = state.kind === "ok" ? overfitGap(state.aggregates) : null;

  return (
    <Card>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>Split aggregates</div>
        <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
          {scoped ? "scoped to the active filters" : "all results"}
        </div>
      </div>

      {state.kind === "loading" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--ink-2)",
            fontSize: 13,
          }}
        >
          <Spinner size={12} />
          Loading split aggregates...
        </div>
      )}

      {state.kind === "error" && (
        <div style={{ color: "var(--err)", fontSize: 13 }}>
          Failed to load split aggregates: {state.message}
        </div>
      )}

      {state.kind === "ok" && state.aggregates.length === 0 && (
        <div style={{ color: "var(--ink-2)", fontSize: 13 }}>no scored results yet</div>
      )}

      {state.kind === "ok" && state.aggregates.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {orderBuckets(state.aggregates).map((bucket) => (
            <SplitBucketRow key={bucket.split ?? "untagged"} bucket={bucket} />
          ))}
        </div>
      )}

      {gap && (
        <div
          style={{
            marginTop: 16,
            paddingTop: 16,
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "baseline",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12, color: "var(--ink-2)" }}>Overfit gap (train − test)</div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: gap.gapPts > 0 ? "var(--err)" : "var(--ink)",
            }}
          >
            {gap.gapPts > 0 ? "+" : ""}
            {gap.gapPts.toFixed(1)} pts
          </div>
        </div>
      )}
    </Card>
  );
}

function SplitBucketRow({ bucket }: { bucket: SplitAggregate }) {
  const pct = bucket.passRate === null ? null : Math.round(bucket.passRate * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <Badge tone="mute" style={{ minWidth: 72, justifyContent: "center" }}>
        {bucket.split ?? "untagged"}
      </Badge>
      <div style={{ fontSize: 12, color: "var(--ink-2)", minWidth: 150 }}>
        {bucket.passed}/{bucket.results} passed · {bucket.failed} failed
      </div>
      <div
        style={{
          flex: 1,
          height: 8,
          background: "var(--background)",
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct ?? 0}%`,
            height: "100%",
            background: "var(--ok)",
          }}
        />
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, minWidth: 36, textAlign: "right" }}>
        {pct === null ? "—" : `${pct}%`}
      </div>
    </div>
  );
}
