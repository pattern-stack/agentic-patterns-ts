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

export function ToolsRail({ agentId }: { agentId: string | null }) {
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
            <span>
              <span className="k">in</span> {capability}
            </span>
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
