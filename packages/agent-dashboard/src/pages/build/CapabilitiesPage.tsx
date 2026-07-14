/**
 * /capabilities — the Capabilities door (docs §3, the SUBSTRATE). The list is
 * the catalog of shared toolbox+manual+playbook bundles.
 *
 * /capabilities/:id — the CAPABILITY DETAIL page. Replaces the Tool Workbench
 * (a flat all-capabilities tree + single-tool pane, PR #196) with a full,
 * single-capability page: header (identity + used-by up-chain, restored from
 * the pre-workbench detail view) → Tools (this capability's own tools only,
 * each progressively expanding into Construction + an inline "Try it" run) →
 * Manual (TOC-at-rest for a sectioned manual, flattened text otherwise) → a
 * Progressive Disclosure demo simulating the `ManualToolbox` contract
 * (`listManualSections`/`readManualSection`) with this capability's REAL
 * manual data → Playbook (play cards with JSON-schema params) → the
 * shares-toolbox-with edge. `?tool=<name>` deep-links straight to an
 * expanded tool row (the only "deep link" the old Tool Workbench actually
 * supported, preserved here as a first-class URL param instead of internal
 * `{cap, tool}` selection state).
 */

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type {
  CapabilityDetail,
  CapabilitySummary,
  ManualSectionSummary,
  PlaybookPlay,
  ToolDef,
} from "../../api/composition";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { Chip, ProvenanceChip } from "../../components/atoms/Chip";
import { Spinner } from "../../components/atoms/Spinner";
import { AsyncState } from "../../components/kit/AsyncState";
import { JsonBlock } from "../../components/kit/JsonBlock";
import { Markdown } from "../../components/kit/Markdown";
import { SectionHeading } from "../../components/kit/SectionHeading";
import { Segmented } from "../../components/kit/Segmented";
import { FamilyTabs } from "../../components/molecules/FamilyTabs";
import { BlastChip, blastNote } from "../../components/molecules/blast";
import { DataTable } from "../../components/organisms/DataTable";
import { DetailPageShell, Labeled } from "../../components/organisms/DetailPageShell";
import { ToolRunner } from "../../components/organisms/ToolRunner";
import { useAdminData } from "../../hooks/useAdminData";
import { looksMarkdown } from "../../lib/markdown";
import { type ToolParam, foldToolParams } from "../../lib/toolParams";
import { T } from "../../ui/tokens";

// --------------------------------------------------------------------------
// List view — /capabilities (unchanged)
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
              color: "var(--ink-2)",
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
              <span style={{ fontSize: 13, color: "var(--ink-3)" }}>
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
                <div style={{ fontWeight: 600, color: "var(--ink)" }}>{c.name}</div>
                {c.description && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 14,
                      color: "var(--ink-2)",
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
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
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
// Detail view — /capabilities/:id
// --------------------------------------------------------------------------

function useToggleSet(initial: Iterable<string> = []) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initial));
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return { open, toggle, setOpen };
}

function ParamTable({
  params,
  nameHeader = "Param",
}: {
  params: ToolParam[];
  nameHeader?: string;
}) {
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

const disclosureRowStyle: CSSProperties = {
  width: "100%",
  textAlign: "left",
  padding: "12px 16px",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 12,
};

/** One tool row — collapsed by default, `?tool=<name>` (or a click) expands
 *  it into Construction (params/returns, port-map §2.3's rendering) + a
 *  "Try it" that reveals the inline `ToolRunner`. */
function ToolRow({
  capId,
  tool,
  open,
  onToggle,
}: {
  capId: string;
  tool: ToolDef;
  open: boolean;
  onToggle: () => void;
}) {
  const [showRunner, setShowRunner] = useState(false);
  const params = foldToolParams(tool.parameters);
  const returnsParams = tool.returns ? foldToolParams(tool.returns) : null;

  return (
    <Card padded={false} style={{ overflow: "hidden" }}>
      <button type="button" onClick={onToggle} aria-expanded={open} style={disclosureRowStyle}>
        <span aria-hidden style={{ color: "var(--mute)", fontSize: T.fz.tiny, flex: "none" }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{ fontFamily: T.font.mono, fontWeight: 600, color: "var(--ink)" }}>
          {tool.name}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: T.fz.small,
            color: "var(--ink-2)",
          }}
        >
          {tool.description || "—"}
        </span>
      </button>

      {open && (
        <div
          style={{
            padding: "16px 16px 16px",
            borderTop: "1px solid var(--line)",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
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

          {!showRunner ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Button variant="primary" onClick={() => setShowRunner(true)}>
                Try it
              </Button>
              <span style={{ fontSize: T.fz.tiny, color: "var(--mute)" }}>
                invokes the tool directly — no model in the loop
              </span>
            </div>
          ) : (
            <div>
              <SectionHeading eyebrow="Run" blurb={blastNote(undefined)} />
              <div style={{ marginTop: 8 }}>
                <ToolRunner capId={capId} tool={tool} />
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** The Manual section: sectioned → a TOC (name + description rows) that each
 *  expand to the section's full `toPrompt()` content — the agent-at-rest view
 *  plus a peek behind it. Text (or absent) → flattened text / an honest empty
 *  note. */
function ManualView({ manual }: { manual: CapabilityDetail["manual"] }) {
  if (!manual) {
    return (
      <Card>
        <span style={{ fontSize: T.fz.small, color: "var(--mute)" }}>No manual attached.</span>
      </Card>
    );
  }

  if (manual.kind === "text") {
    return (
      <Card>
        {looksMarkdown(manual.text) ? (
          <div style={{ fontSize: T.fz.small, color: "var(--ink-2)", lineHeight: 1.6 }}>
            <Markdown content={manual.text} />
          </div>
        ) : (
          <JsonBlock value={manual.text} raw />
        )}
      </Card>
    );
  }

  return <ManualSections sections={manual.sections} />;
}

function ManualSections({ sections }: { sections: ManualSectionSummary[] }) {
  const { open, toggle } = useToggleSet();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {sections.map((s) => {
        const isOpen = open.has(s.name);
        return (
          <Card key={s.name} padded={false} style={{ overflow: "hidden" }}>
            <button
              type="button"
              onClick={() => toggle(s.name)}
              aria-expanded={isOpen}
              style={disclosureRowStyle}
            >
              <span aria-hidden style={{ color: "var(--mute)", fontSize: T.fz.tiny, flex: "none" }}>
                {isOpen ? "▾" : "▸"}
              </span>
              <span style={{ fontWeight: 600, color: "var(--ink)", flex: "none" }}>{s.name}</span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: T.fz.small,
                  color: "var(--ink-2)",
                }}
              >
                {s.description}
              </span>
              {s.itemCount !== undefined && <Chip tone="neutral">{s.itemCount}</Chip>}
            </button>
            {isOpen && (
              <div style={{ padding: "0 16px 16px", borderTop: "1px solid var(--line)" }}>
                <JsonBlock value={s.content} raw style={{ marginTop: 12 }} />
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function PlaybookView({ playbook }: { playbook: CapabilityDetail["playbook"] }) {
  if (!playbook || playbook.plays.length === 0) {
    return (
      <Card>
        <span style={{ fontSize: T.fz.small, color: "var(--mute)" }}>No playbook attached.</span>
      </Card>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {playbook.plays.map((p: PlaybookPlay) => (
        <Card key={p.name}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: T.font.mono, fontWeight: 600, color: "var(--ink)" }}>
              {p.name}
            </span>
            {p.description && (
              <span style={{ fontSize: T.fz.small, color: "var(--ink-2)" }}>{p.description}</span>
            )}
          </div>
          {p.paramsSchema !== undefined && (
            <div style={{ marginTop: 10 }}>
              <JsonBlock value={p.paramsSchema} />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

type DisclosureTier = "tier0" | "tier1" | "tier2";

/**
 * Progressive-disclosure demo — a compact, click-through SIMULATION of the
 * `ManualToolbox` contract (core `molecules/manual.ts`) using THIS
 * capability's real manual data. Labeled a simulation deliberately: the
 * capability's OWN toolbox doesn't carry `listManualSections`/
 * `readManualSection` — those live on a separate `ManualToolbox` a Role
 * mounts alongside it — so there's nothing to invoke here, only to
 * reconstruct byte-for-byte from the real section data the detail route
 * already served.
 */
function ProgressiveDisclosureDemo({ cap }: { cap: CapabilityDetail }) {
  const manual = cap.manual;
  const sectioned = manual && manual.kind === "sectioned" ? manual : null;
  const [tier, setTier] = useState<DisclosureTier>("tier0");
  const [sectionName, setSectionName] = useState<string | null>(null);

  if (!sectioned) {
    return (
      <Card>
        <span style={{ fontSize: T.fz.small, color: "var(--mute)" }}>
          {manual
            ? "This capability's manual has no sections — nothing to progressively disclose. The ManualToolbox contract needs a sectioned manual (a SimpleManual or ScopedManual)."
            : "No manual attached — nothing to progressively disclose."}
        </span>
      </Card>
    );
  }

  const tier0Text = [
    `# ${cap.name}`,
    "",
    cap.description || "(no description)",
    "",
    "## Tools",
    ...cap.toolbox.tools.map((t) => `- **${t.name}**: ${t.description}`),
    "",
    `## ${sectioned.name} — Table of Contents`,
    ...sectioned.sections.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");

  // Reconstructed VERBATIM in `ManualToolbox.listManualSections`'s own format
  // (core `molecules/manual.ts`): "# <name> — Sections" + "- **name**: description".
  const tier1Text = [
    `# ${sectioned.name} — Sections`,
    "",
    ...sectioned.sections.map((s) => `- **${s.name}**: ${s.description}`),
  ].join("\n");

  const selected = sectionName ? sectioned.sections.find((s) => s.name === sectionName) : undefined;

  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: T.fz.tiny, color: "var(--mute)", lineHeight: 1.5 }}>
        Simulation of the <code>ManualToolbox</code> contract, using this capability's real manual
        data — advance through the tiers to see exactly what the model receives at each step.
      </div>

      <Segmented<DisclosureTier>
        options={[
          { value: "tier0", label: "Tier 0 · at rest" },
          { value: "tier1", label: "Tier 1 · listManualSections()" },
          { value: "tier2", label: "Tier 2 · readManualSection()" },
        ]}
        value={tier}
        onChange={setTier}
        size="sm"
      />

      {tier === "tier0" && (
        <>
          <div style={{ fontSize: T.fz.tiny, color: "var(--mute)" }}>
            what the agent always sees, in its prompt:
          </div>
          <JsonBlock value={tier0Text} raw />
        </>
      )}

      {tier === "tier1" && (
        <>
          <div style={{ fontSize: T.fz.tiny, color: "var(--mute)" }}>
            call: <code>listManualSections()</code> — what the model receives:
          </div>
          <JsonBlock value={tier1Text} raw />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {sectioned.sections.map((s) => (
              <Button
                key={s.name}
                variant="default"
                size="sm"
                onClick={() => {
                  setSectionName(s.name);
                  setTier("tier2");
                }}
              >
                readManualSection("{s.name}")
              </Button>
            ))}
          </div>
        </>
      )}

      {tier === "tier2" && (
        <>
          <div style={{ fontSize: T.fz.tiny, color: "var(--mute)" }}>
            call: <code>readManualSection("{sectionName ?? "…"}")</code> — what the model receives:
          </div>
          {selected ? (
            <JsonBlock value={selected.content} raw />
          ) : (
            <span style={{ fontSize: T.fz.small, color: "var(--mute)" }}>
              Pick a section from Tier 1 first.
            </span>
          )}
        </>
      )}
    </Card>
  );
}

/** Roles/agents chip row — the used-by up-chain, restored from the
 *  pre-workbench detail view (dropped when the Tool Workbench replaced it). */
function UsedByRow({ usedBy }: { usedBy: CapabilityDetail["usedBy"] }) {
  return (
    <Card>
      <Labeled label="Used by">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Roles</span>
            {usedBy.roles.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>— none —</span>
            ) : (
              usedBy.roles.map((roleId) => (
                <Link
                  key={roleId}
                  to={`/roles/${encodeURIComponent(roleId)}`}
                  style={{ textDecoration: "none" }}
                >
                  <Chip tone="accent">{roleId}</Chip>
                </Link>
              ))
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Agents</span>
            {usedBy.agents.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>— none —</span>
            ) : (
              usedBy.agents.map((agentId) => (
                <Link
                  key={agentId}
                  to={`/agents/${encodeURIComponent(agentId)}`}
                  style={{ textDecoration: "none" }}
                >
                  <Chip tone="neutral">{agentId}</Chip>
                </Link>
              ))
            )}
          </div>
        </div>
      </Labeled>
    </Card>
  );
}

function CapabilityDetailView({ id }: { id: string }) {
  const { data, loading, error } = useAdminData<CapabilityDetail>(
    `/capabilities/${encodeURIComponent(id)}`,
    0,
  );
  const [searchParams] = useSearchParams();
  const deepLinkTool = searchParams.get("tool");
  const [expandedTools, setExpandedTools] = useState<Set<string>>(
    () => new Set(deepLinkTool ? [deepLinkTool] : []),
  );

  // Re-seed the expanded set whenever the `?tool=` deep link itself changes
  // (e.g. a `sharesToolboxWith` link with a different `?tool=`). A change of
  // `id` alone remounts this component (see the `key={id}` at the router
  // entry below), which already resets `expandedTools` via its initializer.
  useEffect(() => {
    setExpandedTools(new Set(deepLinkTool ? [deepLinkTool] : []));
  }, [deepLinkTool]);

  const toggleTool = (name: string) =>
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const breadcrumb = [{ label: "Capabilities", to: "/capabilities" }, { label: data?.name ?? id }];

  if (loading && !data) {
    return (
      <>
        <div style={{ marginBottom: 16 }}>
          <FamilyTabs />
        </div>
        <DetailPageShell breadcrumb={breadcrumb}>
          <AsyncState kind="loading" loading="Loading capability…" />
        </DetailPageShell>
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        <div style={{ marginBottom: 16 }}>
          <FamilyTabs />
        </div>
        <DetailPageShell breadcrumb={breadcrumb}>
          <AsyncState kind="error" error={{ message: error ?? "Capability not found." }} />
        </DetailPageShell>
      </>
    );
  }

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <FamilyTabs />
      </div>
      <DetailPageShell breadcrumb={breadcrumb} maxWidth={1080}>
        {/* header — identity + chips */}
        <Card>
          <div
            style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--ink)" }}
          >
            {data.name}
          </div>
          {data.description && (
            <div style={{ marginTop: 6, fontSize: 14, color: "var(--ink-2)", lineHeight: 1.5 }}>
              <Markdown content={data.description} gate />
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
            <Chip tone="mono">{data.toolbox.name}</Chip>
            <BlastChip radius={undefined} />
            {data.provenance && (
              <ProvenanceChip tier={data.provenance.tier} sourcePath={data.provenance.sourcePath} />
            )}
          </div>
        </Card>

        {/* used by — restored from the pre-workbench detail view */}
        <UsedByRow usedBy={data.usedBy} />

        {/* tools — this capability's own tools only */}
        <div>
          <SectionHeading
            eyebrow="Tools"
            rollup={`${data.toolbox.tools.length} tool${data.toolbox.tools.length === 1 ? "" : "s"}`}
          />
          {data.toolbox.tools.length === 0 ? (
            <span style={{ fontSize: T.fz.small, color: "var(--mute)" }}>No tools.</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
              {data.toolbox.tools.map((tool) => (
                <ToolRow
                  key={tool.name}
                  capId={data.id}
                  tool={tool}
                  open={expandedTools.has(tool.name)}
                  onToggle={() => toggleTool(tool.name)}
                />
              ))}
            </div>
          )}
        </div>

        {/* manual */}
        <div>
          <SectionHeading eyebrow="Manual" />
          <div style={{ marginTop: 12 }}>
            <ManualView manual={data.manual} />
          </div>
        </div>

        {/* progressive disclosure demo */}
        <div>
          <SectionHeading
            eyebrow="Progressive disclosure"
            blurb="ManualToolbox contract, simulated"
          />
          <div style={{ marginTop: 12 }}>
            <ProgressiveDisclosureDemo cap={data} />
          </div>
        </div>

        {/* playbook */}
        <div>
          <SectionHeading eyebrow="Playbook" />
          <div style={{ marginTop: 12 }}>
            <PlaybookView playbook={data.playbook} />
          </div>
        </div>

        {/* shares toolbox with */}
        {data.sharesToolboxWith.length > 0 && (
          <div>
            <SectionHeading eyebrow="Shares toolbox with" />
            <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
              {data.sharesToolboxWith.map((capId) => (
                <Link
                  key={capId}
                  to={`/capabilities/${encodeURIComponent(capId)}`}
                  style={{ textDecoration: "none" }}
                >
                  <Chip tone="mono">{capId}</Chip>
                </Link>
              ))}
            </div>
          </div>
        )}
      </DetailPageShell>
    </>
  );
}

// --------------------------------------------------------------------------
// Router entry — branch on :id
// --------------------------------------------------------------------------

export function CapabilitiesPage() {
  const { id } = useParams();
  // `key={id}` remounts the detail view on capability-to-capability
  // navigation (e.g. via a `sharesToolboxWith` link), resetting all local
  // disclosure state instead of carrying it over from the previous capability.
  return id ? <CapabilityDetailView key={id} id={id} /> : <CapabilitiesList />;
}
