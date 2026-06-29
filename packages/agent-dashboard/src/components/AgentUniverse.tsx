/**
 * AgentUniverse — the "what it can do" rail. Fetches the selected agent's declared
 * composition (GET /agents/:id/capabilities) and renders capabilities → toolbox
 * tools (+ plays). Sourced from live discovery, not a static catalog — the cockpit
 * Universe rail, retargeted onto the framework's agent introspection.
 */

import { useEffect, useState } from "react";
import { type AgentComposition, fetchAgentCapabilities } from "../api/chat-client";

export function AgentUniverse({ agentId }: { agentId: string | null }) {
  const [comp, setComp] = useState<AgentComposition | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) {
      setComp(null);
      return;
    }
    let cancelled = false;
    setComp(null);
    setError(null);
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

  const toolCount = comp?.capabilities.reduce((n, c) => n + c.tools.length, 0) ?? 0;

  return (
    <aside
      style={{
        width: 280,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--bg-inset)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          padding: "10px 12px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--fg-muted)",
          }}
        >
          Universe
        </span>
        {comp && (
          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-subtle)" }}>
            {toolCount} tool{toolCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px" }}>
        {!agentId && <Hint>Select an agent to see what it can do.</Hint>}
        {error && <div style={{ fontSize: 12, color: "var(--red)" }}>{error}</div>}
        {comp && comp.capabilities.length === 0 && (
          <Hint>This agent declares no capabilities.</Hint>
        )}
        {comp?.capabilities.map((cap) => (
          <div key={cap.name} style={{ marginBottom: 14 }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 8,
                marginBottom: 5,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-default)" }}>
                {cap.name}
              </span>
              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--fg-subtle)" }}>
                {cap.tools.length} tool{cap.tools.length === 1 ? "" : "s"}
              </span>
            </div>
            {cap.tools.map((t) => (
              <div
                key={t.name}
                title={t.description}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "3px 6px",
                  borderRadius: 5,
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  color: "var(--fg-muted)",
                }}
              >
                <span
                  aria-hidden
                  style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--fg-subtle)", flex: "none" }}
                />
                {t.name}
              </div>
            ))}
            {cap.plays.length > 0 && (
              <div style={{ fontSize: 11, color: "var(--fg-subtle)", padding: "3px 6px" }}>
                plays: {cap.plays.join(", ")}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: "var(--fg-subtle)", lineHeight: 1.5 }}>{children}</div>;
}
