/**
 * Eval REST endpoints — read routes (#136) + the write route + live stream
 * (#139, E5c).
 *
 * Reads serve #132's `EvalStore` query surface straight through — no
 * parallel DTOs (the `routes/events.ts` precedent). `POST /eval/runs`
 * validates + starts a suite via the server's `evalExecution` seam and
 * `runEval`'s exact CLI persistence (the extracted `createEvalResultRecorder`
 * — #139's Decision 4, store-parity by construction). `GET
 * /eval/runs/:id/stream` is an attachable SSE view over an in-process live-run
 * registry (fire-and-poll — Decision 2): the persisted rows are the source of
 * truth, the stream is a convenience any client can attach to at any time.
 *
 * Handed in via `ServerConfig.evalStore`/`evalExecution`; both absent -> 503
 * with a friendly hint, exactly like the event routes.
 */

import type {
  AgentEventBus,
  EvalCase,
  EvalCaseRow,
  EvalSplit,
  EvalStore,
  JoinedEvalResultRow,
  Scorer,
} from "@agentic-patterns/runtime";
import {
  EvalSplitSchema,
  HeldOutSplitError,
  assertSplitSelectable,
  createEvalResultRecorder,
  derivePass,
  exactMatch,
  filterBySplit,
  runEval,
} from "@agentic-patterns/runtime";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentRegistration, EvalExecutionConfig } from "../config.js";

export interface EvalRoutesOptions {
  readonly evalStore: EvalStore | undefined;
  readonly agents: AgentRegistration[];
  readonly eventBus: AgentEventBus;
  readonly evalExecution?: EvalExecutionConfig;
}

// ---------------------------------------------------------------------------
// POST /eval/runs — request / response shapes
// ---------------------------------------------------------------------------

interface LaunchEvalRunBody {
  setId: string;
  targetId: string;
  variant?: string;
  split?: EvalSplit;
  allowTest?: boolean;
}

/** SSE broadcast message — mirrors Hono's `writeSSE()` argument shape. */
interface Broadcast {
  readonly event: string;
  readonly data: string;
}

/** In-process live-run handle — scoped to this `evalRoutes` closure. */
interface LiveEvalRun {
  readonly total: number;
  completed: number;
  done: boolean;
  status?: "ok" | "error";
  readonly listeners: Set<(msg: Broadcast) => void | Promise<void>>;
}

export function evalRoutes(opts: EvalRoutesOptions): Hono {
  const { evalStore, agents, eventBus, evalExecution } = opts;
  const app = new Hono();

  // A run started in THIS process; a run seeded/being-written by another
  // process (a concurrent `ap eval`, or a server restarted mid-run) has no
  // entry here even though the store row says "running" — that's the
  // `run.detached` case below.
  const liveRuns = new Map<string, LiveEvalRun>();

  // ---------------------------------------------------------------------------
  // Read routes (#136 — unchanged)
  // ---------------------------------------------------------------------------

  app.get("/eval/sets", (c) => {
    if (!evalStore) {
      return notConfigured(c);
    }
    return c.json({ sets: evalStore.listEvalSets() });
  });

  app.get("/eval/sets/:id/cases", (c) => {
    if (!evalStore) {
      return notConfigured(c);
    }
    const id = c.req.param("id");
    const split = parseSplit(c.req.query("split"));
    if (split.error) {
      return c.json({ error: split.error }, 400);
    }
    const cases = evalStore.listEvalCases(id, { split: split.value });
    if (cases.length === 0) {
      const known = evalStore.listEvalSets().some((s) => s.id === id);
      if (!known) {
        return c.json({ error: `eval set "${id}" not found` }, 404);
      }
    }
    return c.json({ setId: id, cases });
  });

  app.get("/eval/runs", (c) => {
    if (!evalStore) {
      return notConfigured(c);
    }
    const split = parseSplit(c.req.query("split"));
    if (split.error) {
      return c.json({ error: split.error }, 400);
    }
    const limit = parseInt10(c.req.query("limit"), 50, 1, 500);
    const runs = evalStore.listEvalRuns({
      setId: c.req.query("set"),
      targetId: c.req.query("target"),
      variant: c.req.query("variant"),
      split: split.value,
      limit,
    });
    return c.json({ runs });
  });

  app.get("/eval/runs/:id", (c) => {
    if (!evalStore) {
      return notConfigured(c);
    }
    const id = c.req.param("id");
    const run = evalStore.getEvalRun(id);
    if (!run) {
      return c.json({ error: `eval run "${id}" not found` }, 404);
    }
    const results = evalStore.evalRunResults(id);
    return c.json({ run, results, summary: summarize(results) });
  });

  app.get("/eval/aggregates/splits", (c) => {
    if (!evalStore) {
      return notConfigured(c);
    }
    const aggregates = evalStore.splitAggregates({
      setId: c.req.query("set"),
      targetId: c.req.query("target"),
      variant: c.req.query("variant"),
    });
    return c.json({ aggregates });
  });

  // ---------------------------------------------------------------------------
  // POST /eval/runs (#139) — validate, start synchronously, run detached
  // ---------------------------------------------------------------------------

  app.post("/eval/runs", async (c) => {
    // ---- parse body ---------------------------------------------------------
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const body = (raw ?? {}) as Partial<LaunchEvalRunBody> & Record<string, unknown>;

    if (typeof body.setId !== "string" || body.setId.length === 0) {
      return c.json({ error: "setId is required" }, 400);
    }
    if (typeof body.targetId !== "string" || body.targetId.length === 0) {
      return c.json({ error: "targetId is required" }, 400);
    }
    const setId = body.setId;
    const targetId = body.targetId;
    const variant = typeof body.variant === "string" ? body.variant : undefined;
    const allowTest = body.allowTest === true;

    // ---- validate split value -----------------------------------------------
    const rawSplit = body.split;
    if (rawSplit !== undefined && typeof rawSplit !== "string") {
      return c.json(
        { error: `invalid split "${String(rawSplit)}" — expected train | dev | test` },
        400,
      );
    }
    const splitResult = parseSplit(rawSplit as string | undefined);
    if (splitResult.error) {
      return c.json({ error: splitResult.error }, 400);
    }
    const split = splitResult.value;

    // ---- held-out guard (Decision 5 — free, before any store/exec access) ---
    if (split !== undefined) {
      try {
        assertSplitSelectable(split, { allowTest });
      } catch (error) {
        if (error instanceof HeldOutSplitError) {
          return c.json({ error: error.message, hint: 'retry with "allowTest": true' }, 403);
        }
        throw error;
      }
    }

    // ---- persistence + execution presence -----------------------------------
    if (!evalStore) {
      return notConfigured(c);
    }
    if (!evalExecution) {
      return notExecutable(c);
    }

    // ---- resolve target -------------------------------------------------------
    const reg = agents.find((a) => a.id === targetId);
    if (!reg) {
      const available = agents.map((a) => a.id).join(", ") || "(none)";
      return c.json(
        { error: `agent "${targetId}" not found`, hint: `available: ${available}` },
        404,
      );
    }

    // ---- resolve set + load cases ---------------------------------------------
    const knownSets = evalStore.listEvalSets();
    if (!knownSets.some((s) => s.id === setId)) {
      return c.json({ error: `eval set "${setId}" not found` }, 404);
    }

    let cases: EvalCase<unknown, unknown>[] = evalStore
      .listEvalCases(setId)
      .map(storedCaseToEvalCase);
    if (split !== undefined) {
      cases = filterBySplit(cases, split, { allowTest });
      if (cases.length === 0) {
        return c.json({ error: `no cases in split "${split}" of set "${setId}"` }, 400);
      }
    }

    // ---- start the suite row synchronously (better-sqlite3 is sync) --------
    const evalRunId = evalStore.startEvalRun({
      setId,
      targetId,
      variant,
      split,
      model: evalExecution.model,
      gitSha: evalExecution.gitSha,
    });

    const live: LiveEvalRun = {
      total: cases.length,
      completed: 0,
      done: false,
      listeners: new Set(),
    };
    liveRuns.set(evalRunId, live);

    const recorder = createEvalResultRecorder(evalStore, {
      evalRunId,
      targetId,
      model: evalExecution.model,
      variant,
      split,
    });

    // ---- detach: the suite runs after the response is sent -------------------
    void runDetached({
      evalStore,
      liveRuns,
      evalRunId,
      run: () =>
        runEval(
          {
            target: reg.agent,
            cases,
            scorers: [defaultScorer],
            onResult: async (r) => {
              recorder(r);
              live.completed++;
              const finalAnswer = r.output === undefined ? "" : JSON.stringify(r.output);
              await broadcast(live, {
                event: "case.result",
                data: JSON.stringify({
                  caseId: r.case.id,
                  pass: derivePass(r.scores),
                  succeeded: r.succeeded,
                  error: r.error,
                  scores: r.scores,
                  finalAnswer,
                  inputTokens: r.inputTokens,
                  outputTokens: r.outputTokens,
                  traceId: r.traceId,
                  completed: live.completed,
                  total: live.total,
                }),
              });
            },
          },
          { runner: evalExecution.runner, eventBus, traceId: evalRunId },
        ),
    });

    return c.json({ runId: evalRunId, total: cases.length }, 202);
  });

  // ---------------------------------------------------------------------------
  // GET /eval/runs/:id/stream (#139) — attachable SSE view over the live registry
  // ---------------------------------------------------------------------------

  app.get("/eval/runs/:id/stream", (c) => {
    if (!evalStore) {
      return notConfigured(c);
    }
    const id = c.req.param("id");
    const run = evalStore.getEvalRun(id);
    if (!run) {
      return c.json({ error: `eval run "${id}" not found` }, 404);
    }

    return streamSSE(c, async (stream) => {
      const live = liveRuns.get(id);

      if (live?.done) {
        // Finished but not yet deregistered (a narrow race window) — answer
        // as if terminal-no-handle; no need to subscribe-and-wait.
        const results = evalStore.evalRunResults(id);
        await stream.writeSSE(
          snapshotMsg({
            runId: id,
            status: live.status ?? "ok",
            completed: results.length,
            total: live.total,
          }),
        );
        await stream.writeSSE(finishedMsg(live.status ?? "ok"));
        await stream.writeSSE(doneMsg());
        return;
      }

      if (live) {
        // Subscribe THEN read the store — both synchronous in one JS tick,
        // so no case can complete in the gap (Decision 2).
        let resolveFinished: () => void = () => {};
        const finished = new Promise<void>((resolve) => {
          resolveFinished = resolve;
        });

        const listener = async (msg: Broadcast): Promise<void> => {
          await stream.writeSSE(msg);
          if (msg.event === "run.finished") {
            resolveFinished();
          }
        };
        live.listeners.add(listener);
        stream.onAbort(() => {
          live.listeners.delete(listener);
        });

        const results = evalStore.evalRunResults(id);
        await stream.writeSSE(
          snapshotMsg({
            runId: id,
            status: "running",
            completed: results.length,
            total: live.total,
          }),
        );

        await finished;
        await stream.writeSSE(doneMsg());
        return;
      }

      // No live handle in this process.
      const results = evalStore.evalRunResults(id);

      if (run.status === "running") {
        // A concurrent `ap eval` writing the same db, or an orphaned row from
        // a server restart mid-run — either way, no runner in this process.
        await stream.writeSSE(
          snapshotMsg({ runId: id, status: "running", completed: results.length, total: null }),
        );
        await stream.writeSSE({
          event: "run.detached",
          data: JSON.stringify({ status: "running" }),
        });
        await stream.writeSSE(doneMsg());
        return;
      }

      // Terminal, no handle — reload-after-finish.
      await stream.writeSSE(
        snapshotMsg({ runId: id, status: run.status, completed: results.length, total: null }),
      );
      await stream.writeSSE(finishedMsg(run.status === "error" ? "error" : "ok"));
      await stream.writeSSE(doneMsg());
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers (file-local — the run-store.ts `generateId` / events.ts `parseInt10`
// precedent: small helpers are deliberately not shared across route files)
// ---------------------------------------------------------------------------

function notConfigured(c: Context): Response {
  return c.json(
    {
      error: "persistence not configured",
      hint: "start `ap playground` with AP_PERSISTENCE != 0 to enable eval queries",
    },
    503,
  );
}

/** Mirrors `notConfigured`'s shape — `ServerConfig.evalExecution` absent. */
function notExecutable(c: Context): Response {
  return c.json(
    {
      error: "eval execution not configured",
      hint: "start `ap playground` (it wires evalExecution automatically)",
    },
    503,
  );
}

type SplitParseResult =
  | { error?: undefined; value: EvalSplit | undefined }
  | { error: string; value?: undefined };

/** Absent -> no filter. Present-but-invalid -> the #135 CLI message shape. */
function parseSplit(raw: string | undefined): SplitParseResult {
  if (raw === undefined) {
    return { value: undefined };
  }
  const parsed = EvalSplitSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: `invalid split "${raw}" — expected train | dev | test` };
  }
  return { value: parsed.data };
}

function parseInt10(s: string | undefined, fallback: number, min: number, max: number): number {
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Handler-computed rollup for GET /eval/runs/:id — derivePass-consistent. */
interface EvalRunSummary {
  cases: number;
  passed: number;
  failed: number;
  ungated: number;
  errored: number;
  passRate: number | null;
  inputTokens: number;
  outputTokens: number;
}

function summarize(results: readonly JoinedEvalResultRow[]): EvalRunSummary {
  let passed = 0;
  let failed = 0;
  let ungated = 0;
  let errored = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const r of results) {
    if (r.pass === true) passed += 1;
    else if (r.pass === false) failed += 1;
    else ungated += 1;

    if (r.runStatus === "error") errored += 1;

    inputTokens += r.inputTokens ?? 0;
    outputTokens += r.outputTokens ?? 0;
  }

  const gated = passed + failed;

  return {
    cases: results.length,
    passed,
    failed,
    ungated,
    errored,
    passRate: gated > 0 ? passed / gated : null,
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// POST /eval/runs helpers
// ---------------------------------------------------------------------------

/** `EvalCaseRow` -> `EvalCase`, normalizing `null` -> `undefined` (the #135 CLI's
 *  `storedCaseToEvalCase`, `commands/eval.ts:387` — duplicated route-locally per
 *  this file's own precedent, "small helpers are deliberately not shared". An
 *  un-normalized `expected: null` would make the default scorer gate an
 *  expected-less case. */
function storedCaseToEvalCase(row: EvalCaseRow): EvalCase<unknown, unknown> {
  return {
    id: row.caseId,
    input: row.input,
    expected: row.expected === null ? undefined : row.expected,
    tags: row.tags === null ? undefined : row.tags,
    split: row.split === null ? undefined : row.split,
  };
}

/** The CLI's 3-line expected-gated exact-match default (`commands/eval.ts:264-266`). */
const exact = exactMatch<unknown>();
const defaultScorer: Scorer<unknown, unknown, unknown> = (args) =>
  args.expected === undefined ? [] : exact(args);

/** Serialize broadcast delivery per listener (await in order) — the writeSSE
 *  precedent every listener owns its own stream, so there's no shared-write race. */
async function broadcast(live: LiveEvalRun, msg: Broadcast): Promise<void> {
  for (const listener of live.listeners) {
    await listener(msg);
  }
}

interface RunDetachedOptions {
  readonly evalStore: EvalStore;
  readonly liveRuns: Map<string, LiveEvalRun>;
  readonly evalRunId: string;
  readonly run: () => Promise<unknown>;
}

/** Runs the suite after the 202 response has been sent; never throws into the
 *  request handler — a crash mid-suite finalizes the run row as `"error"`. */
async function runDetached(opts: RunDetachedOptions): Promise<void> {
  const { evalStore, liveRuns, evalRunId, run } = opts;
  try {
    await run();
    await finalizeRun(evalStore, liveRuns, evalRunId, "ok");
  } catch (error) {
    // The only surface for a detached-run crash — no request context to report it through.
    console.error(`[eval] run ${evalRunId} crashed:`, error);
    await finalizeRun(evalStore, liveRuns, evalRunId, "error");
  }
}

async function finalizeRun(
  evalStore: EvalStore,
  liveRuns: Map<string, LiveEvalRun>,
  evalRunId: string,
  status: "ok" | "error",
): Promise<void> {
  evalStore.finishEvalRun(evalRunId, { status });
  const live = liveRuns.get(evalRunId);
  if (live) {
    live.done = true;
    live.status = status;
    await broadcast(live, finishedMsg(status));
    liveRuns.delete(evalRunId);
  }
}

// ---------------------------------------------------------------------------
// GET /eval/runs/:id/stream helpers
// ---------------------------------------------------------------------------

interface Snapshot {
  readonly runId: string;
  readonly status: "running" | "ok" | "error";
  readonly completed: number;
  readonly total: number | null;
}

function snapshotMsg(snapshot: Snapshot): Broadcast {
  return { event: "run.snapshot", data: JSON.stringify(snapshot) };
}

function finishedMsg(status: "ok" | "error"): Broadcast {
  return { event: "run.finished", data: JSON.stringify({ status }) };
}

function doneMsg(): Broadcast {
  return { event: "done", data: "{}" };
}
