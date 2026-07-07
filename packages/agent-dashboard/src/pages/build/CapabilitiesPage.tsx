/**
 * /capabilities — the Capabilities door (docs §3, the SUBSTRATE). The list is
 * the catalog of shared toolbox+manual+playbook bundles.
 *
 * /capabilities/:id — the Tool Workbench (port-map.md §2, ported from
 * swe-brain's `ToolWorkbenchSurface` + `CapabilityToolRunner`): a flat,
 * always-expanded tool tree on the left ({cap, tool} selection, deep-linked
 * to the route's :id), Construction | Run tabs on the right for the selected
 * tool. Construction reads the tool's real JSON schema (already served by
 * `GET /capabilities/:id`, flattened client-side by `lib/toolParams.ts`); Run
 * invokes it directly via `ToolRunner` (`POST …/tools/:tool/invoke`, S3) —
 * no model in the loop. Blast-radius presentation is honest-optional
 * (port-map §1.2): the framework declares no per-capability blast metadata
 * today, so every blast chip here renders the neutral "unknown" state.
 *
 * The capability-level "used by" / "shares toolbox with" edges the OLD detail
 * view showed stay visible one click up, on the list cards below — the
 * per-tool Workbench pane (faithful to swe-brain's layout) doesn't re-show
 * them, but Manual/Playbook/provenance chips survive in the tree's capability
 * header.
 */

import { Boxes, Hammer } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type CapabilityDetail,
  type CapabilitySummary,
  type ToolDef,
  compositionApi,
} from "../../api/composition";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { Chip, ProvenanceChip } from "../../components/atoms/Chip";
import { Spinner } from "../../components/atoms/Spinner";
import { SectionHeading } from "../../components/kit/SectionHeading";
import { Segmented } from "../../components/kit/Segmented";
import { FamilyTabs } from "../../components/molecules/FamilyTabs";
import { BlastChip, blastNote } from "../../components/molecules/blast";
import { DataTable } from "../../components/organisms/DataTable";
import { DetailPageShell } from "../../components/organisms/DetailPageShell";
import { ToolRunner } from "../../components/organisms/ToolRunner";
import { useAdminData } from "../../hooks/useAdminData";
import { type ToolParam, foldToolParams } from "../../lib/toolParams";
import { T } from "../../ui/tokens";

const TREE_WIDTH = "17rem";
const GLYPH_TILE = 34;

// --------------------------------------------------------------------------
// List view — /capabilities
// --------------------------------------------------------------------------

function CapabilitiesList() {
  const navigate = useNavigate();
  const { data, loading, error } = useAdminData<CapabilitySummary[]>("/capabilities", 0);

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <FamilyTabs />
      </div>
      {loading ? (
        <DetailPageShell breadcrumb={[{ label: "Capabilities" }]}>
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              color: "var(--fg-muted)",
              padding: 40,
            }}
          >
            <Spinner /> Loading capabilities…
          </div>
        </DetailPageShell>
      ) : error || !data ? (
        <DetailPageShell breadcrumb={[{ label: "Capabilities" }]}>
          <Card style={{ borderColor: "var(--err)", color: "var(--err)" }}>
            {error ?? "Capabilities not found."}
          </Card>
        </DetailPageShell>
      ) : (
        <DetailPageShell breadcrumb={[{ label: "Capabilities" }]}>
          {data.length === 0 ? (
            <Card>
              <span style={{ fontSize: 13, color: "var(--fg-subtle)" }}>
                No capabilities discovered.
              </span>
            </Card>
          ) : (
            data.map((c) => (
              <Card
                key={c.id}
                onClick={() => navigate(`/capabilities/${encodeURIComponent(c.id)}`)}
                style={{ cursor: "pointer" }}
              >
                <div style={{ fontWeight: 600, color: "var(--fg-default)" }}>{c.name}</div>
                {c.description && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 14,
                      color: "var(--fg-muted)",
                      lineHeight: 1.5,
                    }}
                  >
                    {c.description}
                  </div>
                )}
                <div
                  style={{
                    marginTop: 12,
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Chip tone="mono">{c.toolbox.name}</Chip>
                  <Chip tone="neutral">{c.toolbox.toolCount} tools</Chip>
                  {c.sharesToolboxWith.length > 0 && <Chip tone="neutral">shares toolbox</Chip>}
                  <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
                    used by {c.usedBy.roles.length} roles · {c.usedBy.agents.length} agents
                  </span>
                </div>
              </Card>
            ))
          )}
        </DetailPageShell>
      )}
    </>
  );
}

// --------------------------------------------------------------------------
// Workbench — /capabilities/:id (port-map §2.4)
// --------------------------------------------------------------------------

type WorkbenchTab = "construction" | "run";
type RunMode = "call" | "ask";

/** Fetch every capability's FULL detail (tool schemas + manual/playbook) — the
 *  tree needs all of them at once, but `GET /capabilities` only serves
 *  summaries (toolCount, no schemas). Accepted N+1 (small, in-memory registry
 *  reads — same acceptance as the S7 conversation-parts N+1). */
function useAllCapabilityDetails(): {
  details: CapabilityDetail[] | null;
  loading: boolean;
  error: string | null;
} {
  const [details, setDetails] = useState<CapabilityDetail[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const summaries = await compositionApi.capabilities();
        const full = await Promise.all(summaries.map((s) => compositionApi.capability(s.id)));
        if (alive) {
          setDetails(full);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return { details, loading, error };
}

function ToolWorkbench({ id }: { id: string }) {
  const navigate = useNavigate();
  const { details, loading, error } = useAllCapabilityDetails();
  const [sel, setSel] = useState<{ cap: string; tool: string } | null>(null);
  const [tab, setTab] = useState<WorkbenchTab>("construction");

  // Default selection: the deep-linked capability's first tool, else the
  // first capability that has any tools at all.
  useEffect(() => {
    if (sel || !details) return;
    const preferred = details.find((c) => c.id === id);
    const cap =
      preferred && preferred.toolbox.tools.length > 0
        ? preferred
        : details.find((c) => c.toolbox.tools.length > 0);
    const firstTool = cap?.toolbox.tools[0];
    if (cap && firstTool) setSel({ cap: cap.id, tool: firstTool.name });
  }, [details, sel, id]);

  const cap = sel ? details?.find((c) => c.id === sel.cap) : undefined;
  const tool = cap?.toolbox.tools.find((t) => t.name === sel?.tool);

  const selectTool = (capId: string, toolName: string) => {
    setSel({ cap: capId, tool: toolName });
    setTab("construction");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 48px)" }}>
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 14,
          marginBottom: 12,
          flex: "none",
        }}
      >
        <Link to="/capabilities" style={{ color: "var(--fg-muted)", textDecoration: "none" }}>
          Capabilities
        </Link>
        <span style={{ color: "var(--fg-subtle)" }}>/</span>
        <span style={{ color: "var(--fg-default)", fontWeight: 600 }}>{cap?.name ?? id}</span>
      </nav>
      <div style={{ marginBottom: 12, flex: "none" }}>
        <FamilyTabs />
      </div>

      {error ? (
        <Card style={{ borderColor: "var(--err)", color: "var(--err)" }}>{error}</Card>
      ) : (
        <div
          style={{
            display: "flex",
            flex: 1,
            minHeight: 0,
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-lg)",
            overflow: "hidden",
            background: "var(--paper)",
          }}
        >
          {/* left: toolbox tree — flat, always-expanded */}
          <aside
            style={{
              width: TREE_WIDTH,
              flex: "none",
              borderRight: "1px solid var(--line)",
              overflowY: "auto",
              padding: 16,
              background: "var(--paper)",
            }}
          >
            <SectionHeading eyebrow="Toolboxes" />
            {loading && !details ? (
              <div style={{ marginTop: 12, fontSize: T.fz.small, color: "var(--mute)" }}>
                Loading…
              </div>
            ) : (details ?? []).length === 0 ? (
              <div style={{ marginTop: 12, fontSize: T.fz.small, color: "var(--mute)" }}>
                No capabilities discovered.
              </div>
            ) : (
              (details ?? []).map((c) => (
                <div key={c.id} style={{ marginTop: 16 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <Boxes size={14} aria-hidden style={{ color: "var(--mute)", flex: "none" }} />
                    <span
                      style={{ fontFamily: T.font.mono, fontSize: T.fz.small, color: "var(--ink)" }}
                    >
                      {c.name}
                    </span>
                    <Chip tone="mono">Toolbox</Chip>
                    {c.manual && <Chip tone="neutral">Manual</Chip>}
                    {c.playbook && c.playbook.plays.length > 0 && (
                      <Chip tone="neutral">{c.playbook.plays.length} plays</Chip>
                    )}
                    {c.provenance && (
                      <ProvenanceChip
                        tier={c.provenance.tier}
                        sourcePath={c.provenance.sourcePath}
                      />
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {c.toolbox.tools.length === 0 ? (
                      <span
                        style={{ fontSize: T.fz.tiny, color: "var(--mute)", padding: "2px 8px" }}
                      >
                        no tools
                      </span>
                    ) : (
                      c.toolbox.tools.map((t) => {
                        const isSel = sel?.cap === c.id && sel?.tool === t.name;
                        return (
                          <button
                            key={t.name}
                            type="button"
                            onClick={() => selectTool(c.id, t.name)}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              width: "100%",
                              textAlign: "left",
                              padding: "4px 8px",
                              borderRadius: "var(--radius-sm)",
                              border: "none",
                              background: isSel ? "var(--accent-soft)" : "transparent",
                              color: isSel ? "var(--accent-ink)" : "var(--ink-2)",
                              fontFamily: T.font.mono,
                              fontSize: T.fz.tiny,
                              cursor: "pointer",
                            }}
                          >
                            <span style={{ flex: 1, minWidth: 0 }}>{t.name}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ))
            )}
          </aside>

          {/* right: the selected tool */}
          <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            {!tool || !cap ? (
              <div style={{ padding: 32, fontSize: T.fz.small, color: "var(--mute)" }}>
                {loading ? "Loading…" : "Select a tool from the left to inspect and run it."}
              </div>
            ) : (
              <>
                <div style={{ padding: "16px 20px 0", borderBottom: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span
                      aria-hidden
                      style={{
                        width: GLYPH_TILE,
                        height: GLYPH_TILE,
                        borderRadius: "var(--radius-md)",
                        display: "grid",
                        placeItems: "center",
                        flex: "none",
                        background: "var(--fill)",
                        color: "var(--ink-2)",
                      }}
                    >
                      <Hammer size={18} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: T.font.mono,
                          fontSize: T.fz.md,
                          fontWeight: 600,
                          color: "var(--ink)",
                        }}
                      >
                        {tool.name}(args)
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          marginTop: 3,
                          fontSize: T.fz.tiny,
                          color: "var(--mute)",
                        }}
                      >
                        <BlastChip radius={undefined} />
                        <span style={{ fontFamily: T.font.mono }}>{cap.name}</span>
                        <span>Toolbox</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ marginTop: 16, marginBottom: 12 }}>
                    <Segmented
                      options={[
                        { value: "construction", label: "Construction" },
                        { value: "run", label: "Run" },
                      ]}
                      value={tab}
                      onChange={setTab}
                      size="sm"
                    />
                  </div>
                </div>

                <div style={{ flex: 1, overflowY: "auto", padding: 20, minHeight: 0 }}>
                  {tab === "construction" ? (
                    <ConstructionTab tool={tool} onTry={() => setTab("run")} />
                  ) : (
                    <RunTab capId={cap.id} tool={tool} navigate={navigate} />
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/** Construction tab — read-only spec: what-it-does · params table · returns · try-it. */
function ConstructionTab({ tool, onTry }: { tool: ToolDef; onTry: () => void }) {
  const params = foldToolParams(tool.parameters);
  const returnsParams = tool.returns ? foldToolParams(tool.returns) : null;

  return (
    <div style={{ maxWidth: "46rem", display: "flex", flexDirection: "column", gap: 20 }}>
      <SectionHeading eyebrow="What it does" blurb={tool.description || "—"} />

      <div>
        <SectionHeading eyebrow="Parameters" />
        <div style={{ marginTop: 8 }}>
          {params.length > 0 ? (
            <ParamTable params={params} />
          ) : (
            <span style={{ fontSize: T.fz.small, color: "var(--mute)" }}>No parameters.</span>
          )}
        </div>
      </div>

      {/* Returns — forward-compatible: renders once a tool declares a
          `returns` schema (the playground already serves it, S3). */}
      {returnsParams && (
        <div>
          <SectionHeading eyebrow="Returns" />
          <div style={{ marginTop: 8 }}>
            {returnsParams.length > 0 ? (
              <ParamTable params={returnsParams} nameHeader="Field" />
            ) : (
              <span style={{ fontSize: T.fz.small, color: "var(--mute)" }}>
                {JSON.stringify(tool.returns)}
              </span>
            )}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Button variant="primary" onClick={onTry}>
          Try it
        </Button>
        <span style={{ fontSize: T.fz.tiny, color: "var(--mute)" }}>
          invokes the tool directly — no model in the loop
        </span>
      </div>
    </div>
  );
}

function ParamTable({
  params,
  nameHeader = "Param",
}: { params: ToolParam[]; nameHeader?: string }) {
  return (
    <DataTable<ToolParam>
      columns={[
        {
          key: "name",
          header: nameHeader,
          render: (p) => (
            <span style={{ fontFamily: T.font.mono, color: "var(--ink)" }}>{p.name}</span>
          ),
        },
        {
          key: "type",
          header: "Type",
          render: (p) => (
            <span style={{ fontFamily: T.font.mono, color: "var(--accent-ink)" }}>{p.type}</span>
          ),
        },
        {
          key: "required",
          header: "Req",
          render: (p) => (
            <span style={{ color: p.required ? "var(--err-ink)" : "var(--mute)" }}>
              {p.required ? "required" : "optional"}
            </span>
          ),
        },
        {
          key: "description",
          header: "Description",
          render: (p) => <span style={{ color: "var(--ink-2)" }}>{p.description ?? "—"}</span>,
        },
      ]}
      data={params}
      rowKey={(p) => p.name}
    />
  );
}

/** Run tab — Call tool (the live ToolRunner) | Ask agent (navigates to /chat —
 *  a REAL chat exists here, so this is never a dead stub, port-map §1.5). */
function RunTab({
  capId,
  tool,
  navigate,
}: {
  capId: string;
  tool: ToolDef;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [mode, setMode] = useState<RunMode>("call");

  return (
    <div style={{ maxWidth: "46rem", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Segmented
          options={[
            { value: "call", label: "Call tool" },
            { value: "ask", label: "Ask agent" },
          ]}
          value={mode}
          onChange={(next: RunMode) => {
            if (next === "ask") {
              navigate("/chat");
              return;
            }
            setMode(next);
          }}
          size="sm"
        />
        <span style={{ marginLeft: "auto", fontSize: T.fz.micro, color: "var(--mute)" }}>
          {blastNote(undefined)}
        </span>
      </div>

      <ToolRunner capId={capId} tool={tool} />
    </div>
  );
}

// --------------------------------------------------------------------------
// Router entry — branch on :id
// --------------------------------------------------------------------------

export function CapabilitiesPage() {
  const { id } = useParams();
  return id ? <ToolWorkbench id={id} /> : <CapabilitiesList />;
}
