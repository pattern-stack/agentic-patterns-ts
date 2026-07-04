/**
 * Read-only eval REST endpoints.
 *
 * Serves #132's `EvalStore` query surface straight through — no parallel DTOs
 * (the `routes/events.ts` precedent). Handed in via `ServerConfig.evalStore`;
 * returns 503 with a friendly hint if the store isn't configured, exactly
 * like the event routes.
 *
 * Write routes (`POST /eval/runs`, capture-from-session) and the SSE stream
 * are epic 2 — not here.
 */

import type { EvalStore, JoinedEvalResultRow } from "@agentic-patterns/runtime";
import { EvalSplitSchema } from "@agentic-patterns/runtime";
import { type Context, Hono } from "hono";

export function evalRoutes(evalStore: EvalStore | undefined): Hono {
  const app = new Hono();

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

type SplitParseResult =
  | { error?: undefined; value: "train" | "dev" | "test" | undefined }
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
