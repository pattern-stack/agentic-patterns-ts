/**
 * pipeline2 — dependency-injection channel: the in-memory tip catalog.
 *
 * Demonstrates `depKey`/`provideDeps`. This is a plain data dependency, not a
 * Role/Agent — it is bound into the pipeline in `agent.ts` (via
 * `provideDeps().set(catalogKey, CATALOG).build()`, passed to `asAgent()`)
 * and read by the `fetchTips` leaf via `ctx.deps?.get(catalogKey)`, with no
 * closures.
 */

import { depKey } from "@pattern-stack/agentic-runtime";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Tip {
  readonly id: string;
  readonly topic: string;
  readonly text: string;
}

export interface Catalog {
  query(topic: string): Tip[];
}

// ---------------------------------------------------------------------------
// Sample data — pure, no network, no clock, no randomness
// ---------------------------------------------------------------------------

const TIPS: readonly Tip[] = Object.freeze([
  { id: "t1", topic: "testing", text: "Write the test name as a sentence describing behavior." },
  { id: "t2", topic: "testing", text: "Prefer one assertion concept per test." },
  { id: "t3", topic: "testing", text: "Fake the clock; never sleep() in a unit test." },
  { id: "t4", topic: "typescript", text: "Turn on noUncheckedIndexedAccess early, not late." },
  {
    id: "t5",
    topic: "typescript",
    text: "Prefer `Readonly<>` + `as const` over runtime freezing alone.",
  },
  {
    id: "t6",
    topic: "typescript",
    text: "Model illegal states as unrepresentable, not as a comment.",
  },
]);

/** Minimal `Catalog` over the frozen `TIPS` array — substring match on topic. */
export const CATALOG: Catalog = Object.freeze({
  query(topic: string): Tip[] {
    const needle = topic.trim().toLowerCase();
    return TIPS.filter((t) => t.topic.includes(needle) || needle.includes(t.topic));
  },
});

// ---------------------------------------------------------------------------
// DI key
// ---------------------------------------------------------------------------

/** Typed handle for the tip catalog — bound via `provideDeps()` in `agent.ts`. */
export const catalogKey = depKey<Catalog>("catalog");
