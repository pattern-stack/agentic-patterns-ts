/**
 * pipeline2 — an `asAgent`-promoted `Sequential` pipeline, launchable via
 * `ap playground examples`.
 *
 * Usage:
 *   ap playground examples                # default: deterministic, no API key
 *   AP_EXAMPLE_LIVE=1 ap playground examples   # live: curate is a real AgentStep
 *
 * Hierarchy this example demonstrates end to end (see README.md for the
 * primitive-by-primitive map). Built INSIDE OUT — read bottom-up, the
 * direction construction actually happens in:
 *
 *   Role (Persona+Judgment+Responsibility, subagents/curator.ts)
 *     built into -> Subagent (curatorAgent, wrapped as an AgentStep leaf, live mode only)
 *       nested in -> SequentialAgent (this file: fetch -> curate -> respond)
 *         promoted to -> Agent (asAgent() below promotes the pipeline itself, so
 *            `ap` discovers and chats with it exactly like a hand-written agent)
 *
 * i.e. the OUTERMOST thing `ap` sees is the promoted Agent; the Role is the
 * INNERMOST primitive it's built from — not the other way around.
 *
 * This is the "shop window": pipeline wiring + promotion only. The domain
 * data + DI key live in `deps.ts`; the one LLM leaf lives in
 * `subagents/curator.ts`.
 */

import {
  FunctionStep,
  Sequential,
  asAgent,
  provideDeps,
  retry,
  slot,
} from "@pattern-stack/agentic-runtime";
import { CATALOG, type Tip, catalogKey } from "./deps.js";
import { curateStep } from "./subagents/curator.js";

// ---------------------------------------------------------------------------
// Scratchpad slot — run-scoped counter for the flaky fetch (demonstrates
// `slot`/Scratchpad: state resets every chat turn, unlike a dep-held counter,
// which would bleed across turns).
// ---------------------------------------------------------------------------

const attemptSlot = slot<number>({ key: "pipeline2.fetchAttempt", scope: "run", init: () => 0 });

// ---------------------------------------------------------------------------
// fetchTips — deterministic leaf that reads BOTH `ctx.deps` (the injected
// catalog, DI channel) AND scratchpad (the flaky-attempt counter). Fails on
// attempt 1 (simulated cold cache), succeeds on attempt 2 — `retry()` below
// makes that visible as one clean retry per turn.
// ---------------------------------------------------------------------------

const fetchTips = new FunctionStep<string, Tip[]>({
  name: "fetch",
  fn: (topic, scratchpad, ctx) => {
    scratchpad.update(attemptSlot, (n) => n + 1);
    if (scratchpad.get(attemptSlot) === 1) {
      throw new Error("catalog cold — transient");
    }
    // `ctx.deps` is only OPTIONAL because a bare node can be `.run()` directly
    // without going through `asAgent()`'s promotion (which is what actually
    // binds it) — that "no deps at all" case is distinct from "deps were
    // bound but this key wasn't", so it gets its own explicit guard here.
    if (!ctx.deps) {
      throw new Error("no deps bound — run this pipeline via the asAgent()-promoted export");
    }
    // `DepReader.get()` never returns undefined: it throws `MissingDependencyError`
    // if `catalogKey` was never provided via `provideDeps()` — no truthy-guard needed.
    const catalog = ctx.deps.get(catalogKey);
    return catalog.query(topic);
  },
});

/** Wraps `fetchTips` in `retry()` — never throws to the pipeline, absorbs the flake. */
const fetchWithRetry = retry(fetchTips, { maxAttempts: 2 });

// ---------------------------------------------------------------------------
// respond — deterministic leaf, formats the curated digest into a reply.
// ---------------------------------------------------------------------------

const respond = new FunctionStep<string, string>({
  name: "respond",
  fn: (digest) => `Here are some tips:\n${digest}`,
});

// ---------------------------------------------------------------------------
// Assemble — Sequential threads fetch -> curate -> respond via typed seams
// (Tip[] -> string -> string), no `outputKey` string-threading.
// ---------------------------------------------------------------------------

const pipeline = Sequential.start(fetchWithRetry).then(curateStep).then(respond).build("pipeline2");

// ---------------------------------------------------------------------------
// Promote + export — the pipeline itself becomes the "SequentialAgent" that
// `ap` discovers. `TIn = string` so no `coerceIn` is needed; the default
// `renderOut` (string passthrough) is correct.
// ---------------------------------------------------------------------------

const deps = provideDeps().set(catalogKey, CATALOG).build();

export default asAgent(pipeline, {
  role: {
    name: "Pipeline2",
    description: "A promoted Sequential pipeline: fetch -> curate -> respond.",
  },
  deps,
});
