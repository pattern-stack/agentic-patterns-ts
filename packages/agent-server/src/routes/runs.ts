/**
 * Run history REST endpoints (spec `.ai-docs/stacks/playground-upgrades/
 * port-map.md` § 3.1).
 *
 * Lets the dashboard list/replay persisted runs (handed in via
 * `ServerConfig.runStore` — falls back to `ServerConfig.evalStore`, since an
 * `EvalStore` IS a `RunStore` via extension, `app.ts`'s wiring). Read-only;
 * mirrors the `routes/events.ts` / `routes/eval.ts` 503 persistence-not-
 * configured grammar so the dashboard degrades gracefully when
 * `AP_PERSISTENCE=0`.
 *
 * `:id` accepts a unique run-id PREFIX everywhere (`RunStore.getRun`'s own
 * contract) — `/admin/runs/:id/events` resolves the prefix via `getRun` first
 * so it inherits prefix support without duplicating the matching logic.
 */

import type { RunStore } from "@pattern-stack/agentic-runtime";
import { type Context, Hono } from "hono";

const RUN_STATUSES = ["running", "ok", "error"] as const;
type RunStatus = (typeof RUN_STATUSES)[number];

export function runsRoutes(runStore: RunStore | undefined): Hono {
  const app = new Hono();

  app.get("/admin/runs", (c) => {
    if (!runStore) {
      return notConfigured(c);
    }

    const status = parseStatus(c.req.query("status"));
    if (status.error) {
      return c.json({ error: status.error }, 400);
    }

    const since = parseDate(c.req.query("since"));
    const limit = parseInt10(c.req.query("limit"), 50, 1, 500);
    // `?agent=` (empty string) means "no filter", same as omitting it entirely
    // — `||` (not `??`) so the empty string also falls through to `undefined`.
    const agentName = c.req.query("agent") || undefined;

    const runs = runStore.listRuns({ limit, status: status.value, agentName, since });
    return c.json({ runs });
  });

  app.get("/admin/runs/:id", (c) => {
    if (!runStore) {
      return notConfigured(c);
    }
    const id = c.req.param("id");
    const run = runStore.getRun(id);
    if (!run) {
      return c.json({ error: `run "${id}" not found` }, 404);
    }
    return c.json({ run });
  });

  app.get("/admin/runs/:id/events", (c) => {
    if (!runStore) {
      return notConfigured(c);
    }
    const id = c.req.param("id");
    const run = runStore.getRun(id);
    if (!run) {
      return c.json({ error: `run "${id}" not found` }, 404);
    }
    // Resolve via the full runId (prefix-safe) — `runEvents` filters the
    // `events` table's `run_id` column by exact match.
    const events = runStore.runEvents(run.runId);
    return c.json({ runId: run.runId, events });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers (file-local — small helpers are deliberately not shared across
// route files, the `routes/eval.ts` precedent)
// ---------------------------------------------------------------------------

function notConfigured(c: Context): Response {
  return c.json(
    {
      error: "persistence not configured",
      hint: "start `ap playground` with AP_PERSISTENCE != 0 to enable run history queries",
    },
    503,
  );
}

type StatusParseResult =
  | { error?: undefined; value: RunStatus | undefined }
  | { error: string; value?: undefined };

/** Absent -> no filter. Present-but-invalid -> a 400 with the allowed set. */
function parseStatus(raw: string | undefined): StatusParseResult {
  if (raw === undefined) {
    return { value: undefined };
  }
  if ((RUN_STATUSES as readonly string[]).includes(raw)) {
    return { value: raw as RunStatus };
  }
  return { error: `invalid status "${raw}" — expected ${RUN_STATUSES.join(" | ")}` };
}

function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseInt10(s: string | undefined, fallback: number, min: number, max: number): number {
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
