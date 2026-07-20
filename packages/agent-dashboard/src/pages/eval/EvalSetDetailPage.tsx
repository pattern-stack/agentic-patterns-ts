/**
 * /eval/sets/:id — one eval set: its cases grouped by split, the runs that
 * targeted it, and a set-scoped split-aggregates panel (WI-3).
 *
 * Three independent GETs on mount (the `EvalRunsPage`/`ConversationDetailPage`
 * blend): `fetchEvalSet(id)` (404s the page when absent), `fetchEvalCases(id)`,
 * and `fetchEvalRuns` client-filtered to this set (`filterRuns`, the runs
 * page's own idiom). Cases are grouped into train / dev / test / untagged
 * sections; the held-out `test` section is marked but still viewable (viewing
 * ≠ running). Case add/edit/delete lands in WI-5.
 *
 * Family dispatch (slice 9): when `setFamilyOf(set)` resolves (answer-bank /
 * question-bundle), the registered family view REPLACES the body below the
 * header, and the CRUD affordances hide — family sets are frozen imports.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { EvalCaseRow, EvalRunRow, EvalSetSummary } from "../../api/types";
import { Badge, type BadgeTone } from "../../components/atoms/Badge";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { Chip } from "../../components/atoms/Chip";
import { Spinner } from "../../components/atoms/Spinner";
import { AlertIcon } from "../../components/atoms/icons";
import { DataTable } from "../../components/organisms/DataTable";
import {
  type EvalRunFilters,
  deleteEvalCase,
  fetchEvalCases,
  fetchEvalRuns,
  fetchEvalSet,
  filterRuns,
} from "../../lib/evalApi";
import { CaseEditModal } from "./CaseEditModal";
import { ConfirmModal } from "./ConfirmModal";
import { RunLaunchModal } from "./RunLaunchModal";
import { SetEditModal } from "./SetEditModal";
import { SplitAggregatesPanel } from "./SplitAggregatesPanel";
import { resolveSetFamilyComponents } from "./families";
import { readSetMeta } from "./families/types";

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
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Truncated one-line preview of an unknown JSON payload. */
function preview(value: unknown, max = 80): string {
  if (value === null || value === undefined) return "—";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
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

/** Split buckets in canonical order; `null` groups the untagged cases. */
const SPLIT_GROUPS: ReadonlyArray<{ key: EvalCaseRow["split"]; label: string; heldOut?: boolean }> =
  [
    { key: "train", label: "train" },
    { key: "dev", label: "dev" },
    { key: "test", label: "test", heldOut: true },
    { key: null, label: "untagged" },
  ];

type LoadState =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string }
  | { kind: "ok"; set: EvalSetSummary; cases: EvalCaseRow[]; runs: EvalRunRow[] };

/** Which editor modal is open, if any. */
type ModalState =
  | { kind: "none" }
  | { kind: "runEval" }
  | { kind: "editSet" }
  | { kind: "newCase" }
  | { kind: "editCase"; row: EvalCaseRow }
  | { kind: "deleteCase"; row: EvalCaseRow };

export function EvalSetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [modal, setModal] = useState<ModalState>({ kind: "none" });

  const load = useCallback(async () => {
    if (!id) return;
    setState({ kind: "loading" });
    try {
      const setFetch = await fetchEvalSet(id);
      if (setFetch.kind === "unconfigured") {
        setState({ kind: "unconfigured" });
        return;
      }
      if (setFetch.data === null) {
        setState({ kind: "not-found" });
        return;
      }

      // Cases + runs degrade independently — a failed side leaves an empty
      // list rather than failing the whole page.
      let cases: EvalCaseRow[] = [];
      try {
        const caseFetch = await fetchEvalCases(id);
        if (caseFetch.kind === "ok") cases = caseFetch.data;
      } catch {
        // leave cases empty
      }

      let runs: EvalRunRow[] = [];
      try {
        const runFetch = await fetchEvalRuns({ limit: 200 });
        if (runFetch.kind === "ok") {
          runs = filterRuns(runFetch.data, { set: id } satisfies EvalRunFilters);
        }
      } catch {
        // leave runs empty
      }

      setState({ kind: "ok", set: setFetch.data, cases, runs });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const backLink = (
    <Link
      to="/eval/sets"
      style={{ color: "var(--fg-muted)", fontSize: 13, textDecoration: "none" }}
    >
      ← Eval sets
    </Link>
  );

  if (state.kind === "loading") {
    return (
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
        <span>Loading eval set...</span>
      </div>
    );
  }

  if (state.kind === "not-found") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {backLink}
        <Card style={{ textAlign: "center", padding: 40, color: "var(--fg-muted)" }}>
          <div style={{ fontWeight: 600, color: "var(--fg-default)", marginBottom: 6 }}>
            Eval set not found
          </div>
          <div style={{ fontSize: 14 }}>
            {id ? <>No eval set with id "{id}".</> : "No eval set id given."}
          </div>
        </Card>
      </div>
    );
  }

  if (state.kind === "unconfigured") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {backLink}
        <Card style={{ textAlign: "center", padding: 40, color: "var(--fg-muted)" }}>
          <div style={{ fontWeight: 600, color: "var(--fg-default)", marginBottom: 6 }}>
            Eval persistence is not configured
          </div>
          <div style={{ fontSize: 14 }}>
            Start <code>ap playground</code> with <code>AP_PERSISTENCE != 0</code> to enable eval
            queries.
          </div>
        </Card>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {backLink}
        <Card
          style={{ borderColor: "var(--red)", display: "flex", alignItems: "flex-start", gap: 12 }}
        >
          <span style={{ color: "var(--red)", display: "inline-flex", flexShrink: 0 }}>
            <AlertIcon size={18} />
          </span>
          <div>
            <div style={{ fontWeight: 600, color: "var(--red)", marginBottom: 4 }}>
              Failed to load eval set
            </div>
            <div style={{ color: "var(--fg-muted)", fontSize: 14 }}>{state.message}</div>
          </div>
        </Card>
      </div>
    );
  }

  const { set, cases, runs } = state;
  // Family dispatch (slice 9): a family set's body is REPLACED by its family
  // view, and the CRUD affordances (edit set / new case / per-case edit +
  // delete) are hidden — family sets are frozen imports; edits belong
  // upstream in the exporting bench. Generic sets render exactly as before.
  const setMeta = readSetMeta(set);
  const familyComponents = resolveSetFamilyComponents(setMeta?.family);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {backLink}
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>{set.name ?? set.id}</h1>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-muted)" }}>
            {set.id}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Button size="sm" onClick={() => setModal({ kind: "runEval" })}>
            Run eval
          </Button>
          {familyComponents ? (
            <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
              imported set — cases are frozen; edits belong upstream
            </span>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => setModal({ kind: "editSet" })}>
                Edit set
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setModal({ kind: "newCase" })}>
                New case
              </Button>
            </>
          )}
        </div>
      </div>

      {modal.kind === "runEval" && (
        <RunLaunchModal
          setId={set.id}
          setLabel={set.name ?? set.id}
          onClose={() => setModal({ kind: "none" })}
        />
      )}
      {modal.kind === "editSet" && (
        <SetEditModal
          mode="edit"
          initial={{ id: set.id, name: set.name, description: set.description }}
          onClose={() => setModal({ kind: "none" })}
          onSaved={() => {
            setModal({ kind: "none" });
            void load();
          }}
        />
      )}
      {(modal.kind === "newCase" || modal.kind === "editCase") && (
        <CaseEditModal
          setId={set.id}
          mode={modal.kind === "newCase" ? "create" : "edit"}
          initial={modal.kind === "editCase" ? modal.row : undefined}
          onClose={() => setModal({ kind: "none" })}
          onSaved={() => {
            setModal({ kind: "none" });
            void load();
          }}
        />
      )}
      {modal.kind === "deleteCase" && (
        <ConfirmModal
          title="Delete case"
          message={`Delete case "${modal.row.caseId}" from set "${set.id}"? This cannot be undone.`}
          onCancel={() => setModal({ kind: "none" })}
          onConfirm={async () => {
            const result = await deleteEvalCase(set.id, modal.row.caseId);
            if (result.kind === "unconfigured") {
              throw new Error("Eval persistence is not configured on this server.");
            }
            setModal({ kind: "none" });
            void load();
          }}
        />
      )}

      {familyComponents && setMeta ? (
        <familyComponents.SetView set={set} cases={cases} runs={runs} meta={setMeta} />
      ) : (
        <>
          <Card>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              <Badge tone="muted">cases · {set.caseCount}</Badge>
              {SPLIT_GROUPS.map((g) => {
                const n = set.splitCounts[g.key ?? ""] ?? 0;
                if (n === 0) return null;
                return (
                  <Badge key={g.label} tone={g.heldOut ? "yellow" : "muted"}>
                    {g.label} · {n}
                  </Badge>
                );
              })}
              <Badge tone="muted">created · {relative(set.createdTs)}</Badge>
            </div>
            {set.description && (
              <div style={{ marginTop: 10, fontSize: 14, color: "var(--fg-muted)" }}>
                {set.description}
              </div>
            )}
          </Card>

          <SplitAggregatesPanel filters={{ set: set.id }} />

          {/* Cases grouped by split */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Cases</h2>
            {cases.length === 0 ? (
              <Card style={{ textAlign: "center", padding: 32, color: "var(--fg-muted)" }}>
                This set has no cases yet.
              </Card>
            ) : (
              SPLIT_GROUPS.map((group) => {
                const groupCases = cases.filter((c) => c.split === group.key);
                if (groupCases.length === 0) return null;
                return (
                  <div
                    key={group.label}
                    style={{ display: "flex", flexDirection: "column", gap: 6 }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>
                        {group.label} ({groupCases.length})
                      </span>
                      {group.heldOut && <Badge tone="yellow">held-out</Badge>}
                    </div>
                    <Card padded={false}>
                      <DataTable<EvalCaseRow>
                        columns={[
                          {
                            key: "caseId",
                            header: "Case",
                            render: (row) => (
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                                {row.caseId}
                              </span>
                            ),
                          },
                          { key: "input", header: "Input", render: (row) => preview(row.input) },
                          {
                            key: "expected",
                            header: "Expected",
                            render: (row) =>
                              row.expected === null || row.expected === undefined ? (
                                <span style={{ color: "var(--fg-subtle)" }}>—</span>
                              ) : (
                                preview(row.expected, 48)
                              ),
                          },
                          {
                            key: "tags",
                            header: "Tags",
                            render: (row) =>
                              row.tags && row.tags.length > 0 ? (
                                <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
                                  {row.tags.map((t) => (
                                    <Chip key={t} tone="mono">
                                      {t}
                                    </Chip>
                                  ))}
                                </span>
                              ) : (
                                <span style={{ color: "var(--fg-subtle)" }}>—</span>
                              ),
                          },
                          {
                            key: "actions",
                            header: "",
                            align: "right",
                            render: (row) => (
                              <span style={{ display: "inline-flex", gap: 6 }}>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`edit ${row.caseId}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setModal({ kind: "editCase", row });
                                  }}
                                >
                                  Edit
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`delete ${row.caseId}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setModal({ kind: "deleteCase", row });
                                  }}
                                >
                                  Delete
                                </Button>
                              </span>
                            ),
                          },
                        ]}
                        data={groupCases}
                        rowKey={(row) => row.caseId}
                        onRowClick={(row) =>
                          navigate(`/eval/sets/${set.id}/cases/${encodeURIComponent(row.caseId)}`)
                        }
                      />
                    </Card>
                  </div>
                );
              })
            )}
          </div>

          {/* Runs that targeted this set */}
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
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                          {shortId(row.id)}
                        </span>
                      ),
                    },
                    { key: "targetId", header: "Target", render: (row) => row.targetId ?? "—" },
                    { key: "variant", header: "Variant", render: (row) => row.variant ?? "—" },
                    {
                      key: "split",
                      header: "Split",
                      render: (row) => <Badge tone="muted">{row.split ?? "untagged"}</Badge>,
                    },
                    {
                      key: "status",
                      header: "Status",
                      render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
                    },
                    { key: "tsStart", header: "Started", render: (row) => relative(row.tsStart) },
                  ]}
                  data={runs}
                  rowKey={(row) => row.id}
                  onRowClick={(row) => navigate(`/eval/runs/${row.id}`)}
                />
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}
