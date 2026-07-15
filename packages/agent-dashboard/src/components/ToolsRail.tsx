/**
 * ToolsRail — the chat Console's "Tools" tab (formerly "Universe"). Fetches the
 * selected agent's declared composition (GET /agents/:id/capabilities) and
 * renders it as an INTERACTIVE catalog: capabilities → tools, where each tool
 * row expands in place to show its description, the capability + toolbox it
 * belongs to, and a deep link into the full Capabilities page. Sourced from
 * live discovery, not a static catalog.
 *
 * Borderless fill — the surrounding `ConsoleRail` owns the panel chrome; this
 * just fills the body slot and scrolls internally.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  type AgentCapability,
  type AgentComposition,
  fetchAgentCapabilities,
} from "../api/chat-client";
import "./tools-rail.css";

/**
 * The run scope ("deps") this agent/conversation carries — who it acts on
 * behalf of. `bound` is the live conversation's server-echoed context (once
 * sent); `defaults` is the agent's declared seed scope (shown before send);
 * `available` gates whether this agent can be scoped at all (has an
 * `instantiate` hook). All absent → the agent runs unscoped.
 */
export interface ToolsScope {
  available: boolean;
  defaults: Record<string, unknown> | null;
  bound: Record<string, unknown> | null;
  redacted: string[] | null;
}

export function ToolsRail({
  agentId,
  scope,
}: {
  agentId: string | null;
  scope?: ToolsScope;
}) {
  const [comp, setComp] = useState<AgentComposition | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which tool's detail is expanded, keyed `${capability}::${tool}` so the same
  // tool name under two capabilities can't collide.
  const [openTool, setOpenTool] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) {
      setComp(null);
      return;
    }
    let cancelled = false;
    setComp(null);
    setError(null);
    setOpenTool(null);
    fetchAgentCapabilities(agentId)
      .then((c) => {
        if (!cancelled) setComp(c);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load capabilities");
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const capCount = comp?.capabilities.length ?? 0;
  const toolCount = comp?.capabilities.reduce((n, c) => n + c.tools.length, 0) ?? 0;

  return (
    <div className="tools-rail">
      <div className="tools-rail__bar">
        {comp ? (
          <>
            <span>
              <b>{toolCount}</b> tool{toolCount === 1 ? "" : "s"}
            </span>
            <span>·</span>
            <span>
              <b>{capCount}</b> capabilit{capCount === 1 ? "y" : "ies"}
            </span>
          </>
        ) : (
          <span>tools &amp; capabilities</span>
        )}
      </div>

      <div className="tools-rail__scroll">
        {agentId && scope && <ScopeSection scope={scope} />}
        {!agentId && <div className="tools-rail__msg">Select an agent to see what it can do.</div>}
        {error && <div className="tools-rail__msg err">{error}</div>}
        {comp && comp.capabilities.length === 0 && (
          <div className="tools-rail__msg">This agent declares no capabilities.</div>
        )}
        {comp?.capabilities.map((cap) => (
          <CapabilityGroup key={cap.name} cap={cap} openTool={openTool} onToggle={setOpenTool} />
        ))}
      </div>
    </div>
  );
}

function CapabilityGroup({
  cap,
  openTool,
  onToggle,
}: {
  cap: AgentCapability;
  openTool: string | null;
  onToggle: (key: string | null) => void;
}) {
  return (
    <section className="cap">
      <div className="cap__head">
        <span className="cap__name">{cap.name}</span>
        {cap.toolbox && cap.toolbox !== cap.name && (
          <span className="cap__toolbox" title="Toolbox backing this capability">
            {cap.toolbox}
          </span>
        )}
        <span className="cap__count">
          {cap.tools.length} tool{cap.tools.length === 1 ? "" : "s"}
        </span>
      </div>
      {cap.description && <div className="cap__desc">{cap.description}</div>}
      {cap.plays.length > 0 && (
        <div className="cap__plays" title="Named plays this capability provides">
          {cap.plays.map((p) => (
            <span key={p} className="cap__play">
              {p}
            </span>
          ))}
        </div>
      )}
      {cap.tools.map((t) => {
        const key = `${cap.name}::${t.name}`;
        return (
          <ToolItem
            key={key}
            name={t.name}
            description={t.description}
            capability={cap.name}
            toolbox={cap.toolbox}
            open={openTool === key}
            onToggle={() => onToggle(openTool === key ? null : key)}
          />
        );
      })}
    </section>
  );
}

function ToolItem({
  name,
  description,
  capability,
  toolbox,
  open,
  onToggle,
}: {
  name: string;
  description: string;
  capability: string;
  toolbox?: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="tool">
      <button
        type="button"
        className="tool__row"
        aria-expanded={open}
        onClick={onToggle}
        title={description || undefined}
      >
        <span className="tool__dot" aria-hidden />
        <span className="tool__name">{name}</span>
        <span className="tool__chev" aria-hidden>
          ▸
        </span>
      </button>
      {open && (
        <div className="tool__detail">
          <div className={`tool__desc${description ? "" : " mute"}`}>
            {description || "No description provided."}
          </div>
          <div className="tool__meta">
            {toolbox && (
              <span>
                <span className="k">toolbox</span> {toolbox}
              </span>
            )}
            <Link
              className="tool__link"
              to={`/capabilities/${encodeURIComponent(capability)}`}
              title="Open this capability's full detail (manual, playbook, invoke)"
            >
              Full detail ↗
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * ScopeSection — the "deps" readout: the run scope this agent/conversation acts
 * under (who it's on behalf of). Shows the live bound context once a
 * conversation exists, else the agent's declared default scope, else an honest
 * "runs unscoped" note (no per-user deps). This is the framework's
 * dependency-injection scope surfaced where the old cockpit showed it.
 */
function ScopeSection({ scope }: { scope: ToolsScope }) {
  const bound = scope.bound;
  const usingBound = bound != null;
  const source = usingBound ? bound : scope.available ? scope.defaults : null;
  const entries = source ? Object.entries(source) : [];

  // No instantiate hook and nothing bound → this agent runs globally.
  if (!scope.available && !usingBound) {
    return (
      <div className="scope">
        <div className="scope__head">
          <span className="scope__title">Scope</span>
          <span className="scope__tag">unscoped</span>
        </div>
        <div className="scope__none">
          No per-user deps — this agent acts globally, not on behalf of a specific user.
        </div>
      </div>
    );
  }

  return (
    <div className="scope">
      <div className="scope__head">
        <span className="scope__title">Scope</span>
        <span className="scope__tag">
          {usingBound ? "this conversation" : "default · binds on send"}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="scope__none">(no scope)</div>
      ) : (
        <>
          <div className="scope__sub">acting on behalf of</div>
          <dl className="scope__list">
            {entries.map(([k, v]) => {
              // Server-redacted keys arrive with their value already replaced
              // (e.g. "[redacted]"); flag the row so it reads intentionally
              // hidden, not like real data.
              const isRedacted = scope.redacted?.includes(k) ?? false;
              return (
                <div className="scope__row" key={k}>
                  <dt className="scope__k">{k}</dt>
                  <dd
                    className={`scope__v${isRedacted ? " scope__v--redacted" : ""}`}
                    title={isRedacted ? "redacted by the server" : fmtScopeVal(v)}
                  >
                    {fmtScopeVal(v)}
                  </dd>
                </div>
              );
            })}
          </dl>
        </>
      )}
    </div>
  );
}

function fmtScopeVal(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "object") {
    return Array.isArray(v) ? `[${(v as unknown[]).length} items]` : "{…}";
  }
  return String(v);
}
