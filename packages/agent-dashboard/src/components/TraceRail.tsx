/**
 * TraceRail — the Console's collapsible trace rail (port-map §4.2.3): the
 * current/selected turn's run trace, rendered through the shared
 * `TraceWaterfall`/`TraceLog` organisms (§5.1/§5.2) behind a small lens
 * toggle. Two feeds, ONE fold (`graph/trace-from-events.ts eventsToSteps` —
 * never forked, port-map §1.3):
 *
 *   - LIVE  — the current turn's raw event stream (`useChat`'s `traceEvents`,
 *     already `toEventLike`-flattened); folded with `terminal: !streaming` so
 *     a still-running turn reads "in progress" instead of fabricating a
 *     premature finish step.
 *   - REPLAY — a past session's turn, keyed by its `StoredMessage.runId` ->
 *     `GET /admin/runs/:id/events` -> `persistedToEventLike` -> the same fold.
 *     `runId: null` means the viewed exchange has no linked run (honest note,
 *     never a fabricated trace).
 *
 * Self-contained `<aside>` — same outer chrome as the existing `AgentUniverse`
 * rail — so `ChatPage` can swap between the two via a small tab strip that
 * sits above both, without either needing to know about the other.
 */
import { useEffect, useState } from "react";
import { buildToolIndex } from "../graph/composition";
import { type EventLike, eventsToSteps, persistedToEventLike } from "../graph/trace-from-events";
import type { TraceStep } from "../graph/types";
import { fetchRunEvents } from "../lib/runsApi";
import { Segmented } from "./kit/Segmented";
import { TraceLog } from "./organisms/TraceLog";
import { TraceWaterfall } from "./organisms/TraceWaterfall";

const TOOL_INDEX = buildToolIndex();

type LensMode = "waterfall" | "log";
const LENS_OPTIONS: { value: LensMode; label: string }[] = [
  { value: "waterfall", label: "Waterfall" },
  { value: "log", label: "Log" },
];

export type TraceRailSource =
  | { kind: "live"; events: EventLike[]; streaming: boolean }
  | { kind: "replay"; runId: string | null };

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "var(--fz-small)", color: "var(--mute)", lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

export function TraceRail({ source }: { source: TraceRailSource }) {
  const [lens, setLens] = useState<LensMode>("waterfall");
  const [replaySteps, setReplaySteps] = useState<TraceStep[] | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  const replayRunId = source.kind === "replay" ? source.runId : null;
  useEffect(() => {
    if (source.kind !== "replay") return;
    if (!replayRunId) {
      setReplaySteps(null);
      setReplayError(null);
      return;
    }
    let cancelled = false;
    setReplayLoading(true);
    setReplayError(null);
    fetchRunEvents(replayRunId)
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "unconfigured") {
          setReplayError("run history is not configured on this server");
          setReplaySteps(null);
          return;
        }
        if (res.kind === "not-found") {
          setReplayError("this run's trace is no longer available");
          setReplaySteps(null);
          return;
        }
        const events = res.data.events.map(persistedToEventLike);
        setReplaySteps(eventsToSteps(events, TOOL_INDEX, { terminal: true }));
      })
      .catch((e) => {
        if (!cancelled) setReplayError(e instanceof Error ? e.message : "Failed to load trace");
      })
      .finally(() => {
        if (!cancelled) setReplayLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source.kind, replayRunId]);

  const steps =
    source.kind === "live"
      ? eventsToSteps(source.events, TOOL_INDEX, { terminal: !source.streaming })
      : replaySteps;

  return (
    <aside
      style={{
        width: 320,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <span
          style={{
            fontSize: "var(--fz-tiny)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--mute)",
            flex: 1,
          }}
        >
          Trace{steps ? ` (${steps.length})` : ""}
        </span>
        <Segmented
          options={LENS_OPTIONS}
          value={lens}
          onChange={setLens}
          size="sm"
          aria-label="Trace lens"
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 10px" }}>
        {source.kind === "replay" && !source.runId && (
          <Hint>
            No run linked to this exchange — this turn predates run persistence, or the framework
            didn't capture one.
          </Hint>
        )}
        {replayLoading && <Hint>Loading trace…</Hint>}
        {replayError && (
          <div style={{ fontSize: "var(--fz-small)", color: "var(--err)" }}>{replayError}</div>
        )}
        {source.kind === "live" && steps && steps.length === 0 && (
          <Hint>No events yet — send a message to start this turn's trace.</Hint>
        )}
        {steps &&
          steps.length > 0 &&
          (lens === "waterfall" ? <TraceWaterfall steps={steps} /> : <TraceLog steps={steps} />)}
      </div>
    </aside>
  );
}
