/**
 * `useEvalRunStream` — SSE hook for GET /eval/runs/:id/stream (#139, E5c).
 *
 * The `useEventStream` idiom (EventSource + exponential backoff + cleanup),
 * narrowed to the eval domain's 4-event vocabulary (`run.snapshot`,
 * `case.result`, `run.finished`, `run.detached`) instead of the 20-event
 * agent mapping — per-case eval progress is an eval-domain fact, not an
 * agent event. `runId: null` disables (the empty-path convention) — pages
 * that hydrate from REST first (mid-run reload recovery) pass `null` until
 * that fetch resolves.
 *
 * Results are keyed by `caseId` (a `Map`, upserted) — the `run.snapshot` +
 * `case.result` overlap at attach time can never double-count a case client-side.
 */

import { useEffect, useRef, useState } from "react";
import type { EvalScoreLike } from "../api/types";

export type EvalStreamStatus = "idle" | "connecting" | "live" | "finished" | "detached" | "error";

/** The `case.result` event payload — see spec § "GET /eval/runs/:id/stream". */
export interface StreamedCaseResult {
  caseId: string;
  pass: boolean | null;
  succeeded: boolean;
  error?: string;
  scores: EvalScoreLike[] | null;
  finalAnswer: string | null;
  inputTokens: number;
  outputTokens: number;
  traceId?: string;
  completed: number;
  total: number;
}

export interface UseEvalRunStreamResult {
  status: EvalStreamStatus;
  progress: { completed: number; total: number | null } | null;
  /** Keyed by caseId — dedupe by construction. */
  results: ReadonlyMap<string, StreamedCaseResult>;
  finishedStatus: "ok" | "error" | null;
}

const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

interface RunSnapshotPayload {
  runId: string;
  status: "running" | "ok" | "error";
  completed: number;
  total: number | null;
}

interface RunFinishedPayload {
  status: "ok" | "error";
}

export function useEvalRunStream(runId: string | null): UseEvalRunStreamResult {
  const [status, setStatus] = useState<EvalStreamStatus>("idle");
  const [progress, setProgress] = useState<{ completed: number; total: number | null } | null>(
    null,
  );
  const [results, setResults] = useState<Map<string, StreamedCaseResult>>(new Map());
  const [finishedStatus, setFinishedStatus] = useState<"ok" | "error" | null>(null);
  const retryDelayRef = useRef(INITIAL_RETRY_MS);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    // Fresh per-run state on every runId change (including null -> idle).
    setResults(new Map());
    setProgress(null);
    setFinishedStatus(null);

    if (!runId) {
      setStatus("idle");
      return;
    }

    setStatus("connecting");
    let cancelled = false;
    let source: EventSource | null = null;

    function connect(): void {
      if (cancelled) return;

      source = new EventSource(`/eval/runs/${runId}/stream`);

      source.addEventListener("run.snapshot", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as RunSnapshotPayload;
          setProgress({ completed: data.completed, total: data.total });
          setStatus("live");
        } catch {
          // ignore malformed frame
        }
      });

      source.addEventListener("case.result", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as StreamedCaseResult;
          setResults((prev) => {
            const next = new Map(prev);
            next.set(data.caseId, data);
            return next;
          });
          setProgress({ completed: data.completed, total: data.total });
        } catch {
          // ignore malformed frame
        }
      });

      source.addEventListener("run.finished", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as RunFinishedPayload;
          setFinishedStatus(data.status);
          setStatus("finished");
        } catch {
          // ignore malformed frame
        }
      });

      source.addEventListener("run.detached", () => {
        setStatus("detached");
      });

      source.addEventListener("done", () => {
        // Server-initiated clean close (terminal or detached) — stop here,
        // no reconnect attempt.
        source?.close();
        source = null;
      });

      source.onopen = () => {
        retryDelayRef.current = INITIAL_RETRY_MS;
      };

      source.onerror = () => {
        source?.close();
        source = null;
        if (cancelled) return;
        setStatus("error");
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, MAX_RETRY_MS);
        retryTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      source?.close();
      source = null;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, [runId]);

  return { status, progress, results, finishedStatus };
}
