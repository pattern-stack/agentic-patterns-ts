/**
 * The Live Run replay engine ("the trace IS the scrubber"). Owns a `cursor` into
 * the run's `TraceStep[]` and folds it into a `Frame` via `computeFrame`. Play
 * advances the cursor on a timer (node pulses light step by step); pause/seek
 * freeze it. A live SSE run reuses the same engine by appending steps and calling
 * `seek(last)` as events arrive — only the cursor source differs.
 *
 * `runKey` identifies the run: when it changes the cursor resets to idle. Growing
 * `steps` within the SAME runKey (live streaming) does NOT reset.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Constellation, type Frame, computeFrame } from './constellation-model';
import type { TraceStep } from './types';

/** ms between auto-advanced steps during playback. */
const STEP_MS = 1100;
/** shorter beat for the initial idle → first step. */
const LEAD_MS = 280;

export interface ReplayApi {
  cursor: number;
  playing: boolean;
  frame: Frame;
  play: () => void;
  pause: () => void;
  reset: () => void;
  seek: (index: number) => void;
}

export function useRunReplay(steps: TraceStep[], graph: Constellation, runKey: string): ReplayApi {
  const [cursor, setCursor] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStep = steps.length - 1;

  // New run → back to idle. Keyed on runKey (not `steps`) so live appends within
  // one run don't rewind the cursor.
  useEffect(() => {
    setCursor(-1);
    setPlaying(false);
  }, [runKey]);

  useEffect(() => {
    if (!playing) return;
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
  }, [playing, cursor, lastStep]);

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

  const frame = useMemo(() => computeFrame(steps, cursor, graph), [steps, cursor, graph]);

  return { cursor, playing, frame, play, pause, reset, seek };
}
