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

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  type AgentCapability,
  type AgentComposition,
  fetchAgentCapabilities,
} from "../api/chat-client";
import { foldToolParams } from "../lib/toolParams";
import "./tools-rail.css";

/**
 * The run scope ("deps") this agent/conversation carries — who it acts on
 * behalf of.
 *
 * - `available` — the agent can be scoped at all (has an `instantiate` hook).
 * - `committed` — a live conversation exists, so the scope is BOUND (even if it
 *   bound to nothing). Distinct from `bound != null`: a hook-bearing agent can
 *   bind to an empty/"(no scope)" context, where `bound` is null but the scope
 *   is still committed, not pending.
 * - `bound` — the server-echoed context of the live conversation (`null` once
 *   bound-but-empty, or before any send).
 * - `defaults` — the agent's declared seed scope, shown before the first send.
 * - `viewing` — a past session is being replayed; its run scope was not
 *   captured, so we must NOT guess it from the declared defaults.
 * - `restored` — a persisted session was CONTINUED (#480): live, but its scope
 *   was bound server-side before this client existed, so the same "never
 *   guess" rule applies (optional; absent → false).
 */
export interface ToolsScope {
  available: boolean;
  committed: boolean;
  viewing: boolean;
  restored?: boolean;
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
            parameters={t.parameters}
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
  parameters,
  capability,
  toolbox,
  open,
  onToggle,
}: {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  capability: string;
  toolbox?: string;
  open: boolean;
  onToggle: () => void;
}) {
  const params = useMemo(() => foldToolParams(parameters), [parameters]);

  return (
    <div className={`tool${open ? " open" : ""}`}>
      <button type="button" className="tool__row" aria-expanded={open} onClick={onToggle}>
        <span className="tool__head">
          <span className="tool__dot" aria-hidden />
          <span className="tool__name">{name}</span>
          {params.length > 0 && (
            <span
              className="tool__pcount"
              title={`${params.length} input parameter${params.length === 1 ? "" : "s"}`}
            >
              {params.length}p
            </span>
          )}
          <span className="tool__chev" aria-hidden>
            ▸
          </span>
        </span>
        {/* Description lives inside the button so name + description hover and
            click as one unit — no click needed to read it. */}
        {description && <span className="tool__desc">{description}</span>}
      </button>
      {open && (
        <div className="tool__detail">
          {params.length > 0 ? (
            <dl className="tool__params">
              {params.map((p) => (
                <div className="tool__param" key={p.name}>
                  <dt className="tool__param-sig">
                    <span className="tool__param-name">{p.name}</span>
                    <span className="tool__param-type">{p.type}</span>
                    {!p.required && <span className="tool__param-opt">optional</span>}
                  </dt>
                  {p.description && <dd className="tool__param-desc">{p.description}</dd>}
                </div>
              ))}
            </dl>
          ) : (
            <div className="tool__noparams">No input parameters.</div>
          )}
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
  // Replaying a past session: its run scope wasn't captured, so never guess it
  // from the declared defaults (that would assert an operator identity the
  // session may not have had). The header chip + panel both hide here, so this
  // is the only honest signal left in the rail.
  // A CONTINUED session (#480) is live rather than replayed, but its scope was
  // bound server-side before this client existed — same rule, its own sentence.
  if (scope.viewing || scope.restored) {
    return (
      <div className="scope scope--muted">
        <div className="scope__head">
          <span className="scope__title">Scope</span>
          <span className="scope__tag">
            {scope.viewing ? "not recorded for replays" : "not echoed for restored sessions"}
          </span>
        </div>
        <div className="scope__none">
          {scope.viewing
            ? "This session's run scope wasn't captured for replay."
            : "This session's run scope was bound when it was created — the server owns it."}
        </div>
      </div>
    );
  }

  // No instantiate hook → this agent is ALWAYS unscoped: it can never bind a
  // per-user scope, whether or not a conversation exists. (Guarding on
  // `committed` too would flip this to a misleading "bound to nothing" after the
  // first send.)
  if (!scope.available) {
    return (
      <div className="scope scope--muted">
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

  // Bound (a live conversation exists) shows the server's echo — even if that
  // echo was empty ("(no scope)"). Otherwise show the declared defaults, which
  // will bind on the first send.
  const source = scope.committed ? scope.bound : scope.defaults;
  const entries = source ? Object.entries(source) : [];

  return (
    <div className="scope">
      <div className="scope__head">
        <span className="scope__title">Scope</span>
        <span className="scope__tag">
          {scope.committed ? "this conversation" : "default · binds on send"}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="scope__none">
          {scope.committed ? "(no scope — bound to nothing)" : "(no default scope)"}
        </div>
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
                    title={isRedacted ? "redacted by the server" : fmtScopeTitle(v)}
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

/** Hover title — for objects/arrays, a truncated JSON dump so the compact
 *  `{…}`/`[N items]` cell still reveals its contents on hover. */
function fmtScopeTitle(v: unknown): string {
  if (v !== null && typeof v === "object") {
    try {
      const json = JSON.stringify(v);
      return json.length > 200 ? `${json.slice(0, 200)}…` : json;
    } catch {
      return fmtScopeVal(v);
    }
  }
  return fmtScopeVal(v);
}
