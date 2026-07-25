/**
 * The node inspector slide-over. Opens on node click; four tabs — I/O · Tokens ·
 * Provenance · Lens. Escape / scrim close. Adapted from swe-brain's NodeInspector,
 * re-pointed at OUR algebra: the Provenance tab names which SLOT authored the
 * node — Agent = Role × Mission, Capability = Toolbox, tool ← its Toolbox — which
 * IS this framework's core composition algebra, so it reads truest here.
 *
 * Provenance degrades gracefully: it always shows the derived slot mapping, and
 * enriches with the real `/agents/:id/composition` chip when the surface passes
 * one (the live Run surface does; the demo does not).
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Segmented } from "../components/kit/Segmented";
import type { ConstNode } from "../graph/constellation-model";
import type { TraceStep } from "../graph/types";
import { T } from "../ui/tokens";

const PANEL_W = "min(344px, calc(100vw - 24px))";

type Tab = "io" | "tok" | "prov" | "lens";
const TABS: { value: Tab; label: string }[] = [
  { value: "io", label: "I/O" },
  { value: "tok", label: "Tokens" },
  { value: "prov", label: "Provenance" },
  { value: "lens", label: "Lens" },
];

/** Optional run framing for the agent-node I/O tab. */
export interface RunMeta {
  request?: string;
  answer?: string;
  systemPrompt?: string;
  /**
   * The effective (redacted) context this run executed under (#268) — from
   * `RunRow.metadata.context`. `undefined` when the row carries no stamp at
   * all (a hook-less agent, or a hook-bearing run whose server-side stamp was
   * skipped — see `conversations.ts`'s `entry.context !== undefined` guard);
   * the Context section renders only when this key is PRESENT, so it never
   * guesses at a run this dashboard genuinely has no record for. `null` means
   * the server confirmed "(no scope)", not "unknown".
   */
  context?: Record<string, unknown> | null;
  /** Top-level context keys the server redacted, when any were (#268). */
  contextRedacted?: string[];
}

/** Real provenance chip for a slot (from /composition), keyed by node id: the
 *  tier that authored the slot + its source file. */
export interface ProvenanceChip {
  tier?: string;
  sourcePath?: string;
}
export type ProvenanceMap = Record<string, ProvenanceChip>;

/** The subset of a `/composition` role the provenance map reads. */
export interface CompositionRole {
  persona?: { provenance?: ProvenanceChip };
  capabilities?: { name: string; provenance?: ProvenanceChip }[];
}

/**
 * Key the real per-slot provenance by graph node id: agent / sub-agent nodes
 * carry the role's (persona) chip; capability + tool nodes carry their
 * capability's chip. Empty for roles without slots (e.g. a promoted pipeline).
 */
export function buildProvenanceMap(nodes: ConstNode[], role?: CompositionRole): ProvenanceMap {
  if (!role) return {};
  const persona = role.persona?.provenance;
  const byCap = new Map((role.capabilities ?? []).map((c) => [c.name, c.provenance]));
  const map: ProvenanceMap = {};
  for (const n of nodes) {
    if (n.data.kind === "agent" || n.data.kind === "subagent") {
      if (persona) map[n.id] = persona;
    } else if (n.data.capabilityName) {
      const p = byCap.get(n.data.capabilityName);
      if (p) map[n.id] = p;
    }
  }
  return map;
}

function Eyebrow({ children }: { children: string }) {
  return (
    <div
      style={{
        fontSize: T.fz.micro,
        fontFamily: T.font.mono,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--mute)",
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

function MonoBlock({ value }: { value: unknown }) {
  const text =
    typeof value === "string" ? value : value == null ? "—" : JSON.stringify(value, null, 2);
  return (
    <pre
      style={{
        margin: 0,
        padding: 10,
        background: "var(--fill)",
        border: "1px solid var(--line)",
        borderRadius: T.radius.md,
        fontFamily: T.font.mono,
        fontSize: T.fz.micro,
        color: "var(--ink-2)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 220,
        overflow: "auto",
      }}
    >
      {text}
    </pre>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ fontSize: T.fz.small, color: "var(--mute)" }}>{label}</span>
      <span style={{ fontFamily: T.font.mono, fontSize: T.fz.small, color: "var(--ink)" }}>
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Eyebrow>{title}</Eyebrow>
      {children}
    </div>
  );
}

/** find this tool node's call + result steps (by tool name, owning agent if set). */
function toolSteps(
  steps: TraceStep[],
  d: ConstNode["data"],
): { call?: TraceStep; result?: TraceStep } {
  const owns = (s: TraceStep) =>
    s.tool === d.toolName && (d.agentLabel == null || s.agent === d.agentLabel);
  return {
    call: steps.find((s) => s.kind === "tool_call" && owns(s)),
    result: steps.find((s) => s.kind === "tool_result" && owns(s)),
  };
}

/** aggregate run totals from the trace (mirrors the HUD readout). */
function runTotals(steps: TraceStep[]) {
  const models = steps.filter((s) => s.kind === "model");
  const finish = [...steps].reverse().find((s) => s.kind === "finish");
  return {
    iterations: steps.reduce((m, s) => Math.max(m, s.iter), 0),
    toolCalls: steps.filter((s) => s.kind === "tool_call").length,
    inputTokens: [...models].reverse().find((s) => s.ctxTokens != null)?.ctxTokens ?? 0,
    outputTokens: models.reduce((sum, s) => sum + (s.outTokens ?? 0), 0),
    totalMs: steps.reduce((sum, s) => sum + (s.ms || 0), 0),
    finishReason: finish?.status === "error" ? "error" : "stop",
  };
}

function IOTab({
  node,
  steps,
  runMeta,
}: {
  node: ConstNode;
  steps: TraceStep[];
  runMeta?: RunMeta;
}) {
  const d = node.data;
  if (d.kind === "tool") {
    const { call, result } = toolSteps(steps, d);
    return (
      <>
        <Section title="Arguments">
          <MonoBlock value={call?.args ?? "—"} />
        </Section>
        <Section title="Result">
          <MonoBlock value={result?.output ?? "—"} />
        </Section>
      </>
    );
  }
  if (d.kind === "capability") {
    return (
      <Section title="Composition">
        <div style={{ fontSize: T.fz.small, color: "var(--ink-2)", lineHeight: 1.5 }}>
          <strong>{d.label}</strong> arms the run's {d.sub ?? "tools"}. In the algebra a Capability
          = Toolbox (+ optional Manual + Playbook).
        </div>
      </Section>
    );
  }
  // agent / sub-agent
  return (
    <>
      <Section title="System prompt">
        <MonoBlock value={runMeta?.systemPrompt ?? "—"} />
      </Section>
      <Section title="Request">
        <MonoBlock value={runMeta?.request ?? "—"} />
      </Section>
      <Section title="Final answer">
        <MonoBlock value={runMeta?.answer ?? "—"} />
      </Section>
      {/* #268 — only when the row actually carries a context key (see
          RunMeta.context's doc comment); a live/demo/no-stamp run shows
          nothing here rather than fabricating "(no scope)". */}
      {runMeta?.context !== undefined && (
        <Section title="Scope">
          {runMeta.context === null ? (
            <div style={{ fontSize: T.fz.small, color: "var(--mute)" }}>(no scope)</div>
          ) : (
            <>
              <MonoBlock value={runMeta.context} />
              {runMeta.contextRedacted && runMeta.contextRedacted.length > 0 && (
                <div style={{ fontSize: T.fz.micro, color: T.tone.warn.ink }}>
                  redacted: {runMeta.contextRedacted.join(", ")}
                </div>
              )}
            </>
          )}
        </Section>
      )}
    </>
  );
}

function TokensTab({ node, steps }: { node: ConstNode; steps: TraceStep[] }) {
  const d = node.data;
  if (d.kind === "tool") {
    const { result } = toolSteps(steps, d);
    return (
      <Section title="Latency">
        <KV label="duration" value={result ? `${result.ms}ms` : "—"} />
        <KV label="blast" value={d.blast ?? "—"} />
        <KV label="result" value={result?.note ?? "—"} />
      </Section>
    );
  }
  const t = runTotals(steps);
  return (
    <Section title="Run totals">
      <KV label="iterations" value={String(t.iterations)} />
      <KV label="tool calls" value={String(t.toolCalls)} />
      <KV label="input tokens" value={String(t.inputTokens)} />
      <KV label="output tokens" value={String(t.outputTokens)} />
      <KV label="total" value={`${(t.totalMs / 1000).toFixed(1)}s`} />
      <KV label="finish" value={t.finishReason} />
    </Section>
  );
}

function ProvenanceTab({ node, chip }: { node: ConstNode; chip?: ProvenanceChip }) {
  const d = node.data;
  const derived =
    d.kind === "agent"
      ? { slot: "Agent", what: "Role × Mission", via: "agent registration" }
      : d.kind === "capability"
        ? {
            slot: "Capability",
            what: `Toolbox · ${d.capabilityName ?? d.label}`,
            via: "role.capabilities[]",
          }
        : d.kind === "tool"
          ? {
              slot: "Tool",
              what: `armed by ${d.capabilityName ?? d.agentLabel ?? "a toolbox"}`,
              via: "Toolbox.getToolSchemas()",
            }
          : { slot: "Sub-agent", what: "hand-off target", via: "composition" };
  return (
    <Section title="Authored by slot">
      <div
        style={{
          border: "1px solid var(--line)",
          borderRadius: T.radius.md,
          padding: 12,
          background: "var(--paper)",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div style={{ fontSize: T.fz.md, fontWeight: 600, color: "var(--ink)" }}>
          {derived.slot}
        </div>
        <div style={{ fontSize: T.fz.small, color: "var(--ink-2)" }}>{derived.what}</div>
        <div style={{ fontFamily: T.font.mono, fontSize: T.fz.micro, color: "var(--mute)" }}>
          via {derived.via}
        </div>
        {chip && (chip.tier || chip.sourcePath) && (
          <div
            style={{
              marginTop: 8,
              paddingTop: 8,
              borderTop: "1px dashed var(--line)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <div
              style={{
                fontSize: T.fz.micro,
                fontFamily: T.font.mono,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--mute)",
              }}
            >
              resolved
            </div>
            {chip.tier && (
              <div style={{ fontFamily: T.font.mono, fontSize: T.fz.micro, color: "var(--ink-2)" }}>
                tier · {chip.tier}
              </div>
            )}
            {chip.sourcePath && (
              <div
                style={{
                  fontFamily: T.font.mono,
                  fontSize: T.fz.micro,
                  color: "var(--mute)",
                  wordBreak: "break-all",
                }}
              >
                {chip.sourcePath}
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

function LensTab() {
  return (
    <div
      style={{
        border: "1px dashed var(--line)",
        borderRadius: T.radius.md,
        padding: 14,
        background: "var(--fill)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: T.fz.small, fontWeight: 600, color: "var(--ink)" }}>
        Slot-discipline Lens
      </div>
      <div style={{ fontSize: T.fz.small, color: "var(--ink-2)", lineHeight: 1.5 }}>
        Per-slot discipline: <strong>CLEAN</strong> · <strong>IGNORED</strong> (carried but violated
        — a model signal) · <strong>ABSENT</strong> (never reached the model — a slot bug). Lands
        with the Runs · Audit slice.
      </div>
    </div>
  );
}

export function NodeInspector({
  node,
  steps,
  runMeta,
  provenance,
  onClose,
}: {
  node: ConstNode;
  steps: TraceStep[];
  runMeta?: RunMeta;
  provenance?: ProvenanceMap;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("io");
  const d = node.data;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 6, display: "flex" }}>
      {/* scrim — click to dismiss */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop; Escape closes (keydown above) + the header × is the keyboard path. */}
      <div
        onClick={onClose}
        style={{ flex: 1, background: "color-mix(in oklch, var(--ink) 8%, transparent)" }}
      />
      <aside
        style={{
          width: PANEL_W,
          flex: "none",
          background: "var(--paper)",
          borderLeft: "1px solid var(--line)",
          boxShadow: T.shadow.s3,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            padding: 16,
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <Eyebrow>{d.kind}</Eyebrow>
            <div
              style={{
                fontSize: T.fz.lg,
                fontWeight: 600,
                color: "var(--ink)",
                fontFamily: d.kind === "tool" ? T.font.mono : T.font.sans,
              }}
            >
              {d.label}
            </div>
            {d.blast && (
              <div style={{ marginTop: 6, fontSize: T.fz.micro, color: "var(--mute)" }}>
                blast · {d.blast}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
            style={{
              border: "1px solid var(--line)",
              background: "var(--paper)",
              borderRadius: T.radius.sm,
              padding: 4,
              cursor: "pointer",
              color: "var(--ink-2)",
              lineHeight: 1,
              fontSize: 14,
            }}
          >
            ✕
          </button>
        </div>

        {/* segmented tabs */}
        <div style={{ padding: "12px 16px 0" }}>
          <Segmented
            options={TABS}
            value={tab}
            onChange={setTab}
            size="sm"
            fullWidth
            aria-label="Inspector tab"
          />
        </div>

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            minHeight: 0,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {tab === "io" && <IOTab node={node} steps={steps} runMeta={runMeta} />}
          {tab === "tok" && <TokensTab node={node} steps={steps} />}
          {tab === "prov" && <ProvenanceTab node={node} chip={provenance?.[node.id]} />}
          {tab === "lens" && <LensTab />}
        </div>
      </aside>
    </div>
  );
}
