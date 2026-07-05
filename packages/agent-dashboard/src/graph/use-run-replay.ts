/**
 * The Live Run replay engine ("the trace IS the scrubber"). Owns a `cursor` into
 * the run's `TraceStep[]` and folds it into a `Frame` via `computeFrame`.
 *
 * TWO cursor sources, ONE engine — only who drives the cursor differs:
 *   • REPLAY (default): Play advances the cursor on a timer step-by-step;
 *     pause/seek freeze it (clicking a trace row seeks the constellation).
 *   • LIVE (`opts.live`): the engine OWNS the cursor and drains it toward the
 *     growing step frontier as SSE events append, re-arming as new steps arrive.
 *     The manual play/seek loop is suspended while live. An honesty clamp
 *     (cursor ≤ arrived) holds either way — the graph never shows a step the
 *     backend hasn't emitted.
 *
 * `runKey` identifies the run: when it changes the cursor resets to idle. Growing
 * `steps` within the SAME runKey (live streaming) does NOT reset.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Constellation, type Frame, computeFrame } from "./constellation-model";
import type { TraceStep } from "./types";

/** ms between auto-advanced steps during (manual) playback. */
const STEP_MS = 1100;
/** shorter beat for the initial idle → first step. */
const LEAD_MS = 280;
/** default live-drain cadence (ms/step) when `paceMs` is unset. */
const LIVE_STEP_MS = 550;

export interface ReplayApi {
  cursor: number;
  playing: boolean;
  frame: Frame;
  play: () => void;
  pause: () => void;
  reset: () => void;
  seek: (index: number) => void;
}

export interface ReplayOpts {
  /**
   * Live mode: the engine drives the cursor toward the growing step frontier as
   * SSE events append (rather than the manual play loop, which ends at the last
   * step). The manual play/seek loop is suspended while live.
   */
  live?: boolean;
  /**
   * Live cadence (ms/step). `> 0` walks one step at a time for a flowing,
   * just-in-time reveal (mode "A"). `0` snaps the cursor straight to the latest
   * arrived step — strict real-time, mirroring the backend 1:1 (mode "B"). The
   * honesty clamp (cursor ≤ arrived) holds either way. Default LIVE_STEP_MS.
   */
  paceMs?: number;
  /**
   * Declared-composition mode: show every tool faintly at rest (the full toolbox
   * ring) from frame one, lit just-in-time as used — rather than the chain
   * default of hiding unused tools. Forwarded to `computeFrame`.
   */
  restBase?: boolean;
}

export function useRunReplay(
  steps: TraceStep[],
  graph: Constellation,
  runKey: string,
  opts: ReplayOpts = {},
): ReplayApi {
  const { live = false, paceMs, restBase = false } = opts;
  const cadence = paceMs ?? LIVE_STEP_MS;
  const [cursor, setCursor] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStep = steps.length - 1;

  // New run → back to idle. Keyed on runKey (not `steps`) so live appends within
  // one run don't rewind the cursor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runKey is the intentional reset trigger — the body reads no captured value (only stable setters), so biome sees runKey as "unnecessary", but it must stay to re-run the reset on each new run.
  useEffect(() => {
    setCursor(-1);
    setPlaying(false);
  }, [runKey]);

  // Manual replay loop — suspended in live mode (the live drain owns the cursor).
  useEffect(() => {
    if (live || !playing) return;
    if (cursor >= lastStep) {
      setPlaying(false);
      return;
    }
    timer.current = setTimeout(
      () => setCursor((c) => Math.min(c + 1, lastStep)),
      cursor < 0 ? LEAD_MS : STEP_MS,
    );
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [live, playing, cursor, lastStep]);

  // Live drain — walk the cursor toward the growing frontier at `cadence`,
  // re-arming as `lastStep` grows (new SSE steps). Parks when caught up so the
  // node sits in its "thinking" pulse until the next event lands. `cadence <= 0`
  // snaps to the frontier (strict real-time). Clamp keeps cursor ≤ arrived.
  useEffect(() => {
    if (!live || cursor >= lastStep) return; // not live, or caught up → park
    if (cadence <= 0) {
      setCursor(lastStep); // real-time: snap to the latest arrived step
      return;
    }
    timer.current = setTimeout(
      () => setCursor((c) => Math.min(c + 1, lastStep)),
      cursor < 0 ? LEAD_MS : cadence,
    );
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [live, cursor, lastStep, cadence]);

  const play = useCallback(() => {
    setCursor((c) => (c >= lastStep ? -1 : c)); // restart from idle if at the end
    setPlaying(true);
  }, [lastStep]);
  const pause = useCallback(() => setPlaying(false), []);
  const reset = useCallback(() => {
    setPlaying(false);
    setCursor(-1);
  }, []);
  const seek = useCallback((index: number) => {
    setPlaying(false);
    setCursor(index);
  }, []);

  const frame = useMemo(
    () => computeFrame(steps, cursor, graph, restBase),
    [steps, cursor, graph, restBase],
  );

  return { cursor, playing, frame, play, pause, reset, seek };
}
