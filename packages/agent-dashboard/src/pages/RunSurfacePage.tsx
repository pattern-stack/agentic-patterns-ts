/**
 * RunSurfacePage — the integrated Live Run surface.
 *
 * Phase 1 (this slice): a deterministic DEMO harness — plays `SAMPLE_EVENTS`
 * through the real constellation stack (GraphPanel → useRunReplay → computeFrame)
 * so the renderer can be developed and browser-pilot-verified without a live
 * model. Slice 6 grows this into the full surface: agent picker + live SSE
 * streaming + the LiveTracePanel scrubber + the declared/chain mode toggle.
 */
import { useMemo } from "react";
import { GraphPanel } from "../components/GraphPanel";
import type { GraphSource } from "../graph/composition";
import { SAMPLE_EVENTS, SAMPLE_REQUEST } from "../graph/sample-run-trace";
import { T } from "../ui/tokens";

export function RunSurfacePage() {
  const source = useMemo<GraphSource>(
    () => ({ mode: "chain", arm: "single", toolDefs: [], events: SAMPLE_EVENTS }),
    [],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Live Run</h1>
        <span
          style={{
            fontSize: T.fz.micro,
            fontFamily: T.font.mono,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--mute)",
            border: "1px solid var(--line)",
            borderRadius: T.radius.sm,
            padding: "2px 7px",
          }}
        >
          demo · sample trace
        </span>
      </div>
      <div style={{ fontSize: T.fz.small, color: "var(--mute)" }}>{SAMPLE_REQUEST}</div>
      <div style={{ height: 520 }}>
        <GraphPanel source={source} runKey="demo" />
      </div>
    </div>
  );
}
