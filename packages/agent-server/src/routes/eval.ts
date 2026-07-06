/**
 * Eval REST endpoints — read routes (#136) + the write route + live stream
 * (#139, E5c) + capture-from-session (#140, E5d).
 *
 * Reads serve #132's `EvalStore` query surface straight through — no
 * parallel DTOs (the `routes/events.ts` precedent). `POST /eval/runs`
 * validates + starts a suite via the server's `evalExecution` seam and
 * `runEval`'s exact CLI persistence (the extracted `createEvalResultRecorder`
 * — #139's Decision 4, store-parity by construction). `GET
 * /eval/runs/:id/stream` is an attachable SSE view over an in-process live-run
 * registry (fire-and-poll — Decision 2): the persisted rows are the source of
 * truth, the stream is a convenience any client can attach to at any time.
 * `POST /eval/cases/from-session` reads one exchange out of a live
 * conversation in the in-process registry `app.ts` already hands to
 * `conversationRoutes`, and upserts it into the case bank — #140's Decision
 * 1-5.
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
  setMembership,
} from "@agentic-patterns/runtime";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentRegistration, EvalExecutionConfig } from "../config.js";
import type { ConversationEntry } from "./conversations.js";

export interface EvalRoutesOptions {
  readonly evalStore: EvalStore | undefined;
  readonly agents: AgentRegistration[];
  readonly eventBus: AgentEventBus;
  readonly evalExecution?: EvalExecutionConfig;
  /** The live in-process conversation registry `app.ts` hands `conversationRoutes`
   *  too — absent (older embedders) means capture-from-session 404s every request. */
  readonly conversations?: ReadonlyMap<string, ConversationEntry>;
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
  /**
   * Named scorer choice (PR: eval-run scorer seam). Absent → "exact-match" —
   * the back-compatible pre-seam behavior (POST /eval/runs used to hardcode the
   * expected-gated exact-match). Resolved against `SCORER_REGISTRY`; unknown →
   * 400. The resolved id rides the 202 response; it is NOT persisted on the
   * eval_run row (no schema change — see the registry's follow-up note).
   */
  scorer?: string;
}

// ---------------------------------------------------------------------------
// Set / case write routes — request shapes
// ---------------------------------------------------------------------------

interface SetWriteBody {
  id: string;
  name?: string | null;
  description?: string | null;
}

interface CaseWriteBody {
  input: unknown;
  expected?: unknown;
  tags?: string[];
  split?: EvalSplit;
}

// ---------------------------------------------------------------------------
// POST /eval/cases/from-session (#140) — request / response shapes
// ---------------------------------------------------------------------------

interface CaptureFromSessionBody {
  conversationId: string;
  setId: string;
  exchange?: number;
  expected?: string;
  split?: EvalSplit;
  tags?: string[];
  caseId?: string;
  createSet?: { name?: string; description?: string };
}

interface CaptureFromSessionResponse {
  setId: string;
  caseId: string;
  created: boolean;
  input: string;
  expected: string;
  tags: string[];
  split: EvalSplit;
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
  const { evalStore, agents, eventBus, evalExecution, conversations } = opts;
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
    const filters = {
      setId: c.req.query("set"),
      targetId: c.req.query("target"),
      variant: c.req.query("variant"),
      split: split.value,
    };
    const runs = evalStore.listEvalRuns({ ...filters, limit });
    // Per-run pass rollup for the list view — one grouped aggregate over
    // eval_result (not N detail fetches). Additive: a run with no results has
    // no entry here and keeps the pre-existing (summary-less) row shape.
    const summaryById = new Map(evalStore.evalRunSummaries(filters).map((s) => [s.evalRunId, s]));
    const withSummary = runs.map((run) => {
      const s = summaryById.get(run.id);
      return s
        ? {
            ...run,
            summary: {
              cases: s.cases,
              passed: s.passed,
              failed: s.failed,
              ungated: s.ungated,
              passRate: s.passRate,
            },
          }
        : run;
    });
    return c.json({ runs: withSummary });
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
  // GET /eval/scorers (PR: eval-run scorer seam) — the named scorer registry
  // (id + description), in the SAME order the launch form presents. Static (it
  // does not touch the store), so it answers even when persistence/execution
  // are unconfigured — the form needs the option list before a run is
  // launchable, and the choice only matters at POST /eval/runs time.
  // ---------------------------------------------------------------------------

  app.get("/eval/scorers", (c) => {
    return c.json({
      scorers: SCORER_REGISTRY.map((s) => ({ id: s.id, description: s.description })),
    });
  });

  // ---------------------------------------------------------------------------
  // GET /eval/sets/:id/cases/:caseId — one case + its cross-run history
  // ---------------------------------------------------------------------------

  app.get("/eval/sets/:id/cases/:caseId", (c) => {
    if (!evalStore) {
      return notConfigured(c);
    }
    const id = c.req.param("id");
    const caseId = c.req.param("caseId");
    if (!evalStore.listEvalSets().some((s) => s.id === id)) {
      return c.json({ error: `eval set "${id}" not found` }, 404);
    }
    const caseRow = evalStore.listEvalCases(id).find((r) => r.caseId === caseId);
    if (!caseRow) {
      return c.json({ error: `case "${caseId}" not found in set "${id}"` }, 404);
    }
    const history = evalStore.caseResultHistory(id, caseId);
    return c.json({ case: caseRow, history });
  });

  // ---------------------------------------------------------------------------
  // Set / case write routes — create/edit/delete (hand-validated, the
  // POST /eval/runs precedent — no zod in routes). `upsertEvalSet` /
  // `upsertEvalCase` already exist on the store; only delete is new (#WI-1).
  // ---------------------------------------------------------------------------

  app.post("/eval/sets", async (c) => {
    if (!evalStore) {
      return notConfigured(c);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const body = (raw ?? {}) as Partial<SetWriteBody> & Record<string, unknown>;

    if (typeof body.id !== "string" || body.id.length === 0) {
      return c.json({ error: "id is required" }, 400);
    }
    if (body.name !== undefined && body.name !== null && typeof body.name !== "string") {
      return c.json({ error: "name must be a string" }, 400);
    }
    if (
      body.description !== undefined &&
      body.description !== null &&
      typeof body.description !== "string"
    ) {
      return c.json({ error: "description must be a string" }, 400);
    }

    const existed = evalStore.listEvalSets().some((s) => s.id === body.id);
    evalStore.upsertEvalSet({
      id: body.id,
      name: body.name ?? undefined,
      description: body.description ?? undefined,
    });
    const set = evalStore.listEvalSets().find((s) => s.id === body.id);
    return c.json({ set }, existed ? 200 : 201);
  });

  app.patch("/eval/sets/:id", async (c) => {
    if (!evalStore) {
      return notConfigured(c);
    }
    const id = c.req.param("id");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const body = (raw ?? {}) as Partial<SetWriteBody> & Record<string, unknown>;

    if (body.name !== undefined && body.name !== null && typeof body.name !== "string") {
      return c.json({ error: "name must be a string" }, 400);
    }
    if (
      body.description !== undefined &&
      body.description !== null &&
      typeof body.description !== "string"
    ) {
      return c.json({ error: "description must be a string" }, 400);
    }

    const current = evalStore.listEvalSets().find((s) => s.id === id);
    if (!current) {
      return c.json({ error: `eval set "${id}" not found` }, 404);
    }

    // Overlay only the keys present in the body; absent keys keep the current
    // value (upsert's ON CONFLICT preserves created_ts).
    const name = body.name !== undefined ? (body.name ?? undefined) : (current.name ?? undefined);
    const description =
      body.description !== undefined
        ? (body.description ?? undefined)
        : (current.description ?? undefined);
    evalStore.upsertEvalSet({ id, name, description });
    const set = evalStore.listEvalSets().find((s) => s.id === id);
    return c.json({ set }, 200);
  });

  app.put("/eval/sets/:id/cases/:caseId", async (c) => {
    if (!evalStore) {
      return notConfigured(c);
    }
    const id = c.req.param("id");
    const caseId = c.req.param("caseId");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const body = (raw ?? {}) as Partial<CaseWriteBody> & Record<string, unknown>;

    if (!Object.hasOwn(body, "input")) {
      return c.json({ error: '"input" is required' }, 400);
    }
    if (body.tags !== undefined && !isStringArray(body.tags)) {
      return c.json({ error: "tags must be an array of strings" }, 400);
    }
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

    if (!evalStore.listEvalSets().some((s) => s.id === id)) {
      return c.json({ error: `eval set "${id}" not found` }, 404);
    }

    const created = !evalStore.listEvalCases(id).some((r) => r.caseId === caseId);
    evalStore.upsertEvalCase(id, {
      caseId,
      input: body.input,
      expected: body.expected,
      tags: body.tags,
      split: splitResult.value,
    });
    const caseRow = evalStore.listEvalCases(id).find((r) => r.caseId === caseId);
    return c.json({ case: caseRow }, created ? 201 : 200);
  });

  app.delete("/eval/sets/:id/cases/:caseId", (c) => {
    if (!evalStore) {
      return notConfigured(c);
    }
    const id = c.req.param("id");
    const caseId = c.req.param("caseId");
    if (!evalStore.listEvalSets().some((s) => s.id === id)) {
      return c.json({ error: `eval set "${id}" not found` }, 404);
    }
    const deleted = evalStore.deleteEvalCase(id, caseId);
    if (!deleted) {
      return c.json({ error: `case "${caseId}" not found in set "${id}"` }, 404);
    }
    return c.json({ deleted: true, caseId }, 200);
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

    // ---- resolve scorer choice (PR: eval-run scorer seam) -------------------
    // Optional; default "exact-match" (the pre-seam hardcoded scorer, so an
    // older client that omits the field is unchanged). Unknown or non-string →
    // 400 with the available list (the unknown-target 404 hint grammar). A
    // non-string collapses into the same "unknown scorer" 400 path per spec.
    const rawScorer = body.scorer;
    const chosenScorer =
      typeof rawScorer === "string" || rawScorer === undefined
        ? resolveScorer(rawScorer)
        : undefined;
    if (!chosenScorer) {
      return c.json(
        {
          error: `unknown scorer "${String(rawScorer)}"`,
          hint: `available: ${SCORER_REGISTRY.map((s) => s.id).join(", ")}`,
        },
        400,
      );
    }

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

    // ---- honest model stamp (PR: eval-run scorer seam) ----------------------
    // Stamp the TARGET agent's declared model when it has one, not the server's
    // ambient `evalExecution.model` (which mislabels e.g. a Gemini agent
    // "sonnet"). `getModel` may legally return undefined since core 0.7.0, so
    // fall back to the ambient value. Guarded `typeof` for older AgentLike
    // shapes without the method (the agents.ts / composition.ts precedent).
    const declaredModel =
      typeof reg.agent.getModel === "function" ? reg.agent.getModel() : undefined;
    const stampModel = declaredModel ?? evalExecution.model;

    // ---- start the suite row synchronously (better-sqlite3 is sync) --------
    const evalRunId = evalStore.startEvalRun({
      setId,
      targetId,
      variant,
      split,
      model: stampModel,
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
      model: stampModel,
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
            scorers: [chosenScorer.scorer],
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

    return c.json({ runId: evalRunId, total: cases.length, scorer: chosenScorer.id }, 202);
  });

  // ---------------------------------------------------------------------------
  // POST /eval/cases/from-session (#140, E5d) — capture a live exchange as a case
  // ---------------------------------------------------------------------------

  app.post("/eval/cases/from-session", async (c) => {
    // ---- parse body ---------------------------------------------------------
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const body = (raw ?? {}) as Partial<CaptureFromSessionBody> & Record<string, unknown>;

    if (typeof body.conversationId !== "string" || body.conversationId.length === 0) {
      return c.json({ error: "conversationId is required" }, 400);
    }
    if (typeof body.setId !== "string" || body.setId.length === 0) {
      return c.json({ error: "setId is required" }, 400);
    }

    const rawExchange = body.exchange;
    if (
      rawExchange !== undefined &&
      (typeof rawExchange !== "number" || !Number.isInteger(rawExchange) || rawExchange < 1)
    ) {
      return c.json({ error: "invalid exchange — expected a 1-based exchange number" }, 400);
    }

    if (body.expected !== undefined && typeof body.expected !== "string") {
      return c.json({ error: "expected must be a string" }, 400);
    }

    if (body.tags !== undefined && !isStringArray(body.tags)) {
      return c.json({ error: "tags must be an array of strings" }, 400);
    }

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

    if (
      body.caseId !== undefined &&
      (typeof body.caseId !== "string" || body.caseId.length === 0)
    ) {
      return c.json({ error: "caseId must be a non-empty string" }, 400);
    }

    // ---- persistence presence ------------------------------------------------
    if (!evalStore) {
      return notConfigured(c);
    }

    // ---- resolve the live conversation (Decision 1) ---------------------------
    const conversationId = body.conversationId;
    const entry = conversations?.get(conversationId);
    if (!entry) {
      return c.json(
        {
          error: `conversation "${conversationId}" not found`,
          hint: "capture reads live conversations in this server process — start one in Chat",
        },
        404,
      );
    }

    const history = entry.conversation.history;
    if (history.length === 0) {
      return c.json({ error: "conversation has no completed exchanges yet" }, 400);
    }

    // ---- resolve the exchange (Decision 2 — default: the first) ----------------
    const exchange =
      rawExchange === undefined ? history[0] : history.find((e) => e.number === rawExchange);
    if (!exchange) {
      return c.json(
        {
          error: `exchange ${rawExchange} not found in conversation "${conversationId}" (has ${history.length})`,
        },
        404,
      );
    }

    // ---- resolve the set (Decision 4 — explicit createSet opt-in) --------------
    const setId = body.setId;
    const setExists = evalStore.listEvalSets().some((s) => s.id === setId);
    if (!setExists) {
      const createSet = body.createSet;
      if (createSet === undefined || createSet === null) {
        return c.json(
          {
            error: `eval set "${setId}" not found`,
            hint: 'retry with "createSet": {"name": …} to create it',
          },
          404,
        );
      }
      evalStore.upsertEvalSet({
        id: setId,
        name: typeof createSet === "object" ? createSet.name : undefined,
        description: typeof createSet === "object" ? createSet.description : undefined,
      });
    }

    // ---- map the exchange -> StoredEvalCase (Decision 2/3/5) --------------------
    const caseId =
      typeof body.caseId === "string" && body.caseId.length > 0
        ? body.caseId
        : deriveCaseId(conversationId, exchange.number);
    const expected = body.expected ?? exchange.assistant;
    const split = splitResult.value ?? "train";
    const tags = body.tags ?? ["captured", `agent:${entry.agentId}`];

    const created = !evalStore.listEvalCases(setId).some((r) => r.caseId === caseId);
    evalStore.upsertEvalCase(setId, {
      caseId,
      input: exchange.user,
      expected,
      tags,
      split,
    });

    const response: CaptureFromSessionResponse = {
      setId,
      caseId,
      created,
      input: exchange.user,
      expected,
      tags,
      split,
    };
    return c.json(response, created ? 201 : 200);
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

/** Deterministic caseId — capturing the same exchange twice targets the same
 *  `(setId, caseId)` row (#140 Decision 3, upsert idempotence). */
function deriveCaseId(conversationId: string, exchangeNumber: number): string {
  return `session-${conversationId}-${exchangeNumber}`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
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

/**
 * The "none" scorer — always UNSCORED (returns `[]`). Execute + inspect only:
 * `derivePass([])` is null, so cases render ungraded rather than falsely red.
 * The escape hatch for a set whose `expected` is a grading rubric neither
 * exact-match nor set-membership can read.
 */
const noneScorer: Scorer<unknown, unknown, unknown> = () => [];

interface NamedScorer {
  readonly id: string;
  readonly description: string;
  readonly scorer: Scorer<unknown, unknown, unknown>;
}

/**
 * The named scorer registry (PR: eval-run scorer seam). POST /eval/runs used to
 * hardcode `[defaultScorer]`, so a dashboard-launched run against a set whose
 * `expected` is a rubric (not a literal output copy) reds 100% of cases. This
 * registry lets the caller pick one by id via the optional `scorer` body param.
 *
 * Array ORDER is the display order — GET /eval/scorers and the dashboard select
 * present these in exactly this sequence, "exact-match" first (the default).
 *
 * Route-local by construction: the store never learns the scorer id (no schema
 * change; the id rides the 202 response only).
 *   FOLLOW-UP: persist scorer id on the `eval_run` row so historical runs record
 *   how they were graded (needs an EvalStore column + migration).
 */
const SCORER_REGISTRY: readonly NamedScorer[] = [
  {
    id: "exact-match",
    description:
      "Expected-gated deep equality — an expected-less case is UNSCORED (not auto-failed). The pre-seam default.",
    scorer: defaultScorer,
  },
  {
    id: "set-membership",
    description:
      "Deterministic cited-id precision/recall/F1. Reads `expected` as a string[] of ids (or `expected.citedIds`); any other `expected` shape is UNSCORED.",
    scorer: setMembership(),
  },
  {
    id: "none",
    description: "Execute + inspect only — always UNSCORED (cases render ungraded, never red).",
    scorer: noneScorer,
  },
];

const DEFAULT_SCORER_ID = "exact-match";

/** Resolve a scorer id against the registry; `undefined` → the default. Returns
 *  `undefined` for an unknown id (the caller 400s with the available list). */
function resolveScorer(id: string | undefined): NamedScorer | undefined {
  return SCORER_REGISTRY.find((s) => s.id === (id ?? DEFAULT_SCORER_ID));
}

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
