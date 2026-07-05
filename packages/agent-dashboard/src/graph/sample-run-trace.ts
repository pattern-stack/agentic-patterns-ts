/**
 * SAMPLE run — a deterministic, clearly-labelled event stream for developing and
 * verifying the constellation surface WITHOUT a live model (the local runner
 * falls back to a limited event vocabulary when no ANTHROPIC_API_KEY is set).
 *
 * Adapted in spirit from swe-brain's `sample-run-trace.ts`, but expressed in OUR
 * wire shape: raw live `AgentEvent` objects (camelCase), the exact frames a live
 * SSE run emits, so it exercises the REAL path — `eventsToSteps` fold →
 * `computeFrame` overlay → render — not a hand-built `TraceStep[]`. The `/run`
 * surface plays this when `?demo` is set (or no live run has started), so every
 * visual state (thinking pulse, tool reveal, drifting result card, waterfall,
 * inspector tabs) is reproducible for browser-pilot verification.
 *
 * A single-agent `retrieval-analyst` run over the query-surface tools
 * (search → fetch → curate), three iterations, so the tool names line up with
 * `composition.ts`'s static inventory (chain AND composition projections light).
 */
import type { EventLite } from "./composition";

export const SAMPLE_REQUEST =
  "What landed this week — any meetings or threads I should know about?";

export const SAMPLE_ANSWER =
  "This week's signal: the **Q3 roadmap review** (4 attendees, organized by priya@findtempo.co) " +
  "and a **vendor security questionnaire** from acme. Both trace back to Monday's planning thread; " +
  "nothing else is material. Want me to draft a reply to the questionnaire?";

export const SAMPLE_SYSTEM_PROMPT =
  "You are retrieval-analyst — surface what changed this week across the workspace.\n" +
  "Mission: sweep recent threads + meetings, curate the material few, and recap plainly.\n" +
  "Capabilities: query-surface (search · fetch · curate). Cite ids; never invent rows.";

/** The exact live SSE frames (camelCase payloads) a real run of the agent emits. */
export const SAMPLE_EVENTS: EventLite[] = [
  { type: "message.start", seq: 1, agentName: "retrieval-analyst" },

  // ── iteration 1 — plan a two-read sweep ──
  { type: "iteration.start", seq: 2, iteration: 0 },
  { type: "llm.start", seq: 3 },
  {
    type: "llm.end",
    seq: 4,
    inputTokens: 1620,
    outputTokens: 104,
    durationMs: 1240,
    hasToolCalls: true,
  },
  {
    type: "tool.start",
    seq: 5,
    toolName: "search",
    arguments: { query: "this week roadmap threads" },
  },
  {
    type: "tool.end",
    seq: 6,
    toolName: "search",
    durationMs: 318,
    result: [
      { id: "eml-7a3", title: "Re: Q3 roadmap review", from: "priya@findtempo.co" },
      { id: "eml-8c1", title: "Vendor security questionnaire", from: "security@acme.com" },
    ],
  },
  { type: "tool.start", seq: 7, toolName: "fetch", arguments: { id: "eml-7a3" } },
  {
    type: "tool.end",
    seq: 8,
    toolName: "fetch",
    durationMs: 274,
    result: { title: "Roadmap review", organizer: "priya@findtempo.co", attendees: 4, total: 4 },
  },

  // ── iteration 2 — curate the two reads ──
  { type: "iteration.start", seq: 9, iteration: 1 },
  { type: "llm.start", seq: 10 },
  {
    type: "llm.end",
    seq: 11,
    inputTokens: 1980,
    outputTokens: 88,
    durationMs: 900,
    hasToolCalls: true,
  },
  { type: "tool.start", seq: 12, toolName: "curate", arguments: { ids: ["eml-7a3", "eml-8c1"] } },
  {
    type: "tool.end",
    seq: 13,
    toolName: "curate",
    durationMs: 120,
    result: { ids: ["eml-7a3", "eml-8c1"], kept: 2 },
  },

  // ── iteration 3 — compose the recap, no further tools ──
  { type: "iteration.start", seq: 14, iteration: 2 },
  { type: "llm.start", seq: 15 },
  {
    type: "llm.end",
    seq: 16,
    inputTokens: 2140,
    outputTokens: 136,
    durationMs: 1300,
    hasToolCalls: false,
  },
  { type: "message.complete", seq: 17, content: SAMPLE_ANSWER },
];
