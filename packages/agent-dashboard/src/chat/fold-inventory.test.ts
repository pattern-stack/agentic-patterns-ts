/**
 * `foldInventory` (#226) pinned against a REAL captured event dump — not
 * hand-typed JSON (the `trace-from-events.test.ts` idiom).
 *
 * Provenance: captured by driving the actual runtime emission stack — a
 * `sequentialAgent` retrieve → correlate → brief pipeline on a real
 * `AgentRunner` (with `ai/test`'s `MockLanguageModelV2` standing in for the
 * network call), an `ObservedScratchpad` + the observed
 * `requireBackpack`/`readBackpack` accessors wired to one `AgentEventBus` —
 * then filtering to `RELAYED_STREAM_EVENTS` (the exact set
 * `NodeBackedRunner.stream` relays to the conversation SSE) and mapping each
 * event through the production `toSSEMapping`, flattened as `toEventLike`
 * flattens live frames (`{ type: name, ...snake_case payload }`). The
 * PERSISTED twin below is the same capture's raw camelCase `AgentEvent`
 * bodies — the exact objects `GET /admin/runs/:id/events` rows carry in
 * `data`. Repro (package: @agentic-patterns/runtime):
 *
 *   const bus = new AgentEventBus();
 *   bus.subscribeAll((e) => events.push(e));
 *   const pad = new ObservedScratchpad(createStateEmitter(bus, { traceId, runId }));
 *   const runner = new AgentRunner(resolver, bus);
 *   await sequentialAgent([retrieve, correlate, brief]).run(q, {
 *     runner, scratchpad: pad, toolExecutor, eventBus: bus, traceId, runId,
 *   });
 *   // -> events.filter(RELAYED).map(toSSEMapping)
 *
 * The retrieve stage's tool drops twice into `backpack.observations`
 * (3 accepted + 1 skipped, then 1 accepted + 1 merged — two DropRecords);
 * correlate's prompt reads `finalized()` and its `onEmit` keeps
 * `brief.highlights`; brief's default render injects the prior emission
 * (the innate `scratchpad.read`).
 */
import { describe, expect, test } from "vitest";
import type { EventLike } from "../graph/trace-from-events";
import { foldInventory } from "./fold-inventory";

// ---------------------------------------------------------------------------
// The real dump (verbatim; only whitespace-formatted for readability).
// ---------------------------------------------------------------------------

const WIRE: EventLike[] = [
  {
    type: "step.start",
    span_id: "a06b7e63-3e2a-47da-a0d0-530292b5033b",
    step_name: "retrieve",
    agent_name: "retrieve",
    arguments: { input: "Where does the Meridian Health deal stand?" },
  },
  {
    type: "tool.intent",
    tool_call_id: "tc-search",
    tool_name: "search_deal_context",
    arguments: {},
  },
  {
    type: "tool.start",
    tool_call_id: "tc-search",
    tool_name: "search_deal_context",
    arguments: {},
  },
  {
    type: "backpack.drop",
    key: "backpack.observations",
    origin: "explicit",
    ordinal: 1,
    accepted: 3,
    merged: 0,
    skipped: 1,
    indexes: [1, 2, 3],
    size_before: 0,
    size_after: 3,
    previews: [
      {
        index: 1,
        op: "added",
        preview: "obs · security review gating — SOC 2 letter · gong 06-28",
      },
      {
        index: 2,
        op: "added",
        preview: "obs · CFO approved budget at $210k ceiling · email 06-24",
      },
      {
        index: 3,
        op: "added",
        preview: "obs · champion (VP Ops) moving teams in Q3 · slack 06-19",
      },
    ],
    previews_omitted: 0,
    tool_call_id: "tc-search",
    tag: '{"facet":"observations"}',
    display: { caption: "Evidence" },
  },
  {
    type: "backpack.drop",
    key: "backpack.observations",
    origin: "explicit",
    ordinal: 2,
    accepted: 1,
    merged: 1,
    skipped: 0,
    indexes: [4, 1],
    size_before: 3,
    size_after: 4,
    previews: [
      {
        index: 4,
        op: "added",
        preview: "obs · legal redlining MSA §7 liability cap · meeting 07-01",
      },
      { index: 1, op: "merged", preview: "obs · security review gating (resurfaced) · gong 06-28" },
    ],
    previews_omitted: 0,
    tool_call_id: "tc-search",
    tag: '{"facet":"artifacts"}',
    display: { caption: "Evidence" },
  },
  {
    type: "tool.end",
    tool_call_id: "tc-search",
    tool_name: "search_deal_context",
    result: { receipt: { accepted: 3, merged: 0, skipped: 1, indexes: [1, 2, 3] } },
    duration_ms: 1,
  },
  {
    type: "scratchpad.write",
    key: "agents.retrieve",
    origin: "innate",
    ordinal: 3,
    op: "set",
    had_value: false,
    after: "gathered",
  },
  {
    type: "step.end",
    span_id: "a06b7e63-3e2a-47da-a0d0-530292b5033b",
    step_name: "retrieve",
    agent_name: "retrieve",
    arguments: { input: "Where does the Meridian Health deal stand?" },
    result: "gathered",
    duration_ms: 7,
  },
  {
    type: "step.start",
    span_id: "b4e2b11a-f66f-4905-a470-b14064a507d6",
    step_name: "correlate",
    agent_name: "correlate",
    arguments: { input: "Where does the Meridian Health deal stand?" },
  },
  {
    type: "backpack.read",
    key: "backpack.observations",
    origin: "explicit",
    ordinal: 4,
    memo_hit: false,
    size: 4,
    preview: '{"count":4,"ids":["obs_9f31","obs_4t20","obs_7m54","obs_1k88"]}',
    display: { caption: "Evidence" },
  },
  {
    type: "scratchpad.write",
    key: "agents.correlate",
    origin: "innate",
    ordinal: 5,
    op: "set",
    had_value: false,
    after: "done",
  },
  {
    type: "scratchpad.write",
    key: "brief.highlights",
    origin: "explicit",
    ordinal: 6,
    op: "set",
    had_value: false,
    after: '["#1","#2","#4"]',
  },
  {
    type: "step.end",
    span_id: "b4e2b11a-f66f-4905-a470-b14064a507d6",
    step_name: "correlate",
    agent_name: "correlate",
    arguments: { input: "Where does the Meridian Health deal stand?" },
    result: "done",
    duration_ms: 0,
  },
  {
    type: "step.start",
    span_id: "98d753b1-674d-4937-952e-e75ae7e5b0ab",
    step_name: "brief",
    agent_name: "brief",
    arguments: { input: "Where does the Meridian Health deal stand?" },
  },
  {
    type: "scratchpad.read",
    key: "agents.correlate",
    origin: "innate",
    ordinal: 7,
    preview: "done",
  },
  {
    type: "scratchpad.write",
    key: "agents.brief",
    origin: "innate",
    ordinal: 8,
    op: "set",
    had_value: false,
    after: "done",
  },
  {
    type: "step.end",
    span_id: "98d753b1-674d-4937-952e-e75ae7e5b0ab",
    step_name: "brief",
    agent_name: "brief",
    arguments: { input: "Where does the Meridian Health deal stand?" },
    result: "done",
    duration_ms: 0,
  },
];

/** The same capture's raw camelCase `AgentEvent` bodies (`PersistedEvent.data`),
 *  mapped exactly as `persistedToEventLike` maps rows: `{ ...data, type, seq }`.
 *  Only the state/step/tool fields the fold reads are reproduced; run-plumbing
 *  ids (trace/span/timestamps) are kept where the capture had them. */
const PERSISTED: EventLike[] = (
  [
    {
      traceId: "t-fix",
      runId: "r-fix",
      stepName: "retrieve",
      agentName: "retrieve",
      arguments: { input: "Where does the Meridian Health deal stand?" },
      type: "agent.step.start",
      spanId: "a06b7e63-3e2a-47da-a0d0-530292b5033b",
    },
    {
      traceId: "t-fix",
      runId: "VXxz0Okczv7R4gi8",
      parentSpanId: "e03b32f3-0ef3-4f34-bd84-1c3bc77967ea",
      toolCallId: "tc-search",
      toolName: "search_deal_context",
      arguments: {},
      type: "agent.tool.intent",
      spanId: "942bb6b5-754c-4bb8-8ce2-523ff99b0189",
    },
    {
      spanId: "tc-search",
      traceId: "t-fix",
      runId: "VXxz0Okczv7R4gi8",
      parentSpanId: "e03b32f3-0ef3-4f34-bd84-1c3bc77967ea",
      toolCallId: "tc-search",
      toolName: "search_deal_context",
      arguments: {},
      type: "agent.tool.start",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      parentSpanId: "tc-search",
      origin: "explicit",
      ordinal: 1,
      toolCallId: "tc-search",
      key: "backpack.observations",
      display: { caption: "Evidence" },
      accepted: 3,
      merged: 0,
      skipped: 1,
      indexes: [1, 2, 3],
      sizeBefore: 0,
      sizeAfter: 3,
      previews: [
        {
          index: 1,
          op: "added",
          preview: "obs · security review gating — SOC 2 letter · gong 06-28",
        },
        {
          index: 2,
          op: "added",
          preview: "obs · CFO approved budget at $210k ceiling · email 06-24",
        },
        {
          index: 3,
          op: "added",
          preview: "obs · champion (VP Ops) moving teams in Q3 · slack 06-19",
        },
      ],
      previewsOmitted: 0,
      tag: '{"facet":"observations"}',
      type: "agent.backpack.drop",
      spanId: "31e0ccdc-d663-4a7f-ae42-f6c830836371",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      parentSpanId: "tc-search",
      origin: "explicit",
      ordinal: 2,
      toolCallId: "tc-search",
      key: "backpack.observations",
      display: { caption: "Evidence" },
      accepted: 1,
      merged: 1,
      skipped: 0,
      indexes: [4, 1],
      sizeBefore: 3,
      sizeAfter: 4,
      previews: [
        {
          index: 4,
          op: "added",
          preview: "obs · legal redlining MSA §7 liability cap · meeting 07-01",
        },
        {
          index: 1,
          op: "merged",
          preview: "obs · security review gating (resurfaced) · gong 06-28",
        },
      ],
      previewsOmitted: 0,
      tag: '{"facet":"artifacts"}',
      type: "agent.backpack.drop",
      spanId: "cd0ff8e2-2f37-4ff2-b9fd-19c6cee2849b",
    },
    {
      traceId: "t-fix",
      runId: "VXxz0Okczv7R4gi8",
      spanId: "tc-search",
      parentSpanId: "e03b32f3-0ef3-4f34-bd84-1c3bc77967ea",
      toolCallId: "tc-search",
      toolName: "search_deal_context",
      arguments: {},
      result: { receipt: { accepted: 3, merged: 0, skipped: 1, indexes: [1, 2, 3] } },
      durationMs: 1,
      resultTokens: 0,
      type: "agent.tool.end",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      origin: "innate",
      ordinal: 3,
      key: "agents.retrieve",
      op: "set",
      hadValue: false,
      after: "gathered",
      type: "agent.scratchpad.write",
      spanId: "4d176dff-ceed-4d2f-80d0-3445feee7816",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      spanId: "a06b7e63-3e2a-47da-a0d0-530292b5033b",
      stepName: "retrieve",
      agentName: "retrieve",
      arguments: { input: "Where does the Meridian Health deal stand?" },
      result: "gathered",
      durationMs: 7,
      type: "agent.step.end",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      stepName: "correlate",
      agentName: "correlate",
      arguments: { input: "Where does the Meridian Health deal stand?" },
      type: "agent.step.start",
      spanId: "b4e2b11a-f66f-4905-a470-b14064a507d6",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      origin: "explicit",
      ordinal: 4,
      key: "backpack.observations",
      display: { caption: "Evidence" },
      memoHit: false,
      size: 4,
      preview: '{"count":4,"ids":["obs_9f31","obs_4t20","obs_7m54","obs_1k88"]}',
      type: "agent.backpack.read",
      spanId: "421b8d82-ccb0-426b-8440-5e3be40f3bad",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      origin: "innate",
      ordinal: 5,
      key: "agents.correlate",
      op: "set",
      hadValue: false,
      after: "done",
      type: "agent.scratchpad.write",
      spanId: "f70be1b9-37d0-4c43-9173-267e39c3989e",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      origin: "explicit",
      ordinal: 6,
      key: "brief.highlights",
      op: "set",
      hadValue: false,
      after: '["#1","#2","#4"]',
      type: "agent.scratchpad.write",
      spanId: "232ee4c8-41ae-41ea-a10b-000799287308",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      spanId: "b4e2b11a-f66f-4905-a470-b14064a507d6",
      stepName: "correlate",
      agentName: "correlate",
      arguments: { input: "Where does the Meridian Health deal stand?" },
      result: "done",
      durationMs: 0,
      type: "agent.step.end",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      stepName: "brief",
      agentName: "brief",
      arguments: { input: "Where does the Meridian Health deal stand?" },
      type: "agent.step.start",
      spanId: "98d753b1-674d-4937-952e-e75ae7e5b0ab",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      parentSpanId: "98d753b1-674d-4937-952e-e75ae7e5b0ab",
      origin: "innate",
      ordinal: 7,
      key: "agents.correlate",
      preview: "done",
      type: "agent.scratchpad.read",
      spanId: "c701b05f-f66c-4f6b-80d4-6872381769c7",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      origin: "innate",
      ordinal: 8,
      key: "agents.brief",
      op: "set",
      hadValue: false,
      after: "done",
      type: "agent.scratchpad.write",
      spanId: "30ecbc6c-96bf-4d75-8ae5-9ce56c131193",
    },
    {
      traceId: "t-fix",
      runId: "r-fix",
      spanId: "98d753b1-674d-4937-952e-e75ae7e5b0ab",
      stepName: "brief",
      agentName: "brief",
      arguments: { input: "Where does the Meridian Health deal stand?" },
      result: "done",
      durationMs: 0,
      type: "agent.step.end",
    },
  ] as Record<string, unknown>[]
).map((data, i) => ({ ...data, type: String(data.type), seq: i + 1 }));

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

describe("foldInventory — pinned against the captured pipeline dump", () => {
  test("folds the full run: pack ledger, stage chain, kept values, healthy receipts", () => {
    const snap = foldInventory(WIRE);

    expect(snap.empty).toBe(false);
    expect(snap.packs).toHaveLength(1);
    const pack = snap.packs[0]!;
    expect(pack.key).toBe("backpack.observations");
    expect(pack.size).toBe(4); // the focal numeral
    expect(pack.records.map((r) => [r.seq, r.kind, r.covered, r.accepted])).toEqual([
      [0, "drop", 3, 3],
      [1, "drop", 2, 1],
    ]);
    expect(pack.merged).toBe(1);
    expect(pack.skipped).toBe(1);
    expect(pack.display).toEqual({ caption: "Evidence" });
    expect(snap.packsDisplay).toEqual({ caption: "Evidence" });

    // Ledger: 4 entries, [#1] carries the merge history, minted-by resolved
    // through the tool.start correlation (tool_call_id -> tool name).
    expect(pack.entries.map((e) => e.index)).toEqual([1, 2, 3, 4]);
    expect(pack.entries[0]).toMatchObject({
      index: 1,
      preview: "obs · security review gating — SOC 2 letter · gong 06-28",
      mintedDrop: 0,
      mintedVia: "search_deal_context",
      mintedTag: '{"facet":"observations"}',
    });
    expect(pack.entries[0]!.merges).toEqual([
      "×1 — re-surfaced by search_deal_context (drop #1) · obs · security review gating (resurfaced) · gong 06-28",
    ]);
    expect(pack.entries[3]).toMatchObject({ index: 4, mintedDrop: 1 });

    // Stage chain: all three done, all three saved, correlate's output
    // injected into brief's prompt.
    expect(snap.stages.map((s) => [s.name, s.status, s.saved, s.promptRead])).toEqual([
      ["retrieve", "done", true, false],
      ["correlate", "done", true, true],
      ["brief", "done", true, false],
    ]);
    expect(snap.savedCount).toBe(3);

    // Kept values: the explicit onEmit write, NOT the innate stage emissions.
    expect(snap.slots).toEqual([
      { key: "brief.highlights", value: '["#1","#2","#4"]', writeOp: "set", ordinal: 6 },
    ]);

    // Receipts reconcile; footer numbers.
    expect(snap.health).toEqual({ ok: true });
    expect(snap.dropReceipts).toBe(2);
    expect(snap.writeCount).toBe(6); // 2 drops + 4 scratchpad writes

    // Recency: the last write is the framework saving brief's stage output.
    expect(snap.lastWrite).toEqual({ section: "stages", key: "agents.brief", ordinal: 8 });
  });

  test("SHARED-ACCESSOR DRIFT PIN: the persisted camelCase bodies fold to the identical snapshot", () => {
    expect(foldInventory(PERSISTED)).toEqual(foldInventory(WIRE));
  });

  test("scrub: fold(events[0..cursor)) re-materializes mid-run state", () => {
    // cursor 5 = through both drops, before tool.end / any stage emission.
    const mid = foldInventory(WIRE, 5);
    expect(mid.packs[0]?.size).toBe(4);
    expect(mid.stages).toEqual([
      { name: "retrieve", status: "current", saved: false, promptRead: false },
    ]);
    expect(mid.savedCount).toBe(0);
    expect(mid.slots).toEqual([]);
    expect(mid.lastWrite).toEqual({
      section: "evidence",
      key: "backpack.observations",
      ordinal: 2,
    });

    // cursor 0 = nothing carried yet — the teaching empty state.
    const zero = foldInventory(WIRE, 0);
    expect(zero.empty).toBe(true);
    expect(zero.packs).toEqual([]);
    expect(zero.health.ok).toBe(true);
  });

  test("a receipt that doesn't add up flips the health footer to the loud mismatch", () => {
    const corrupted = WIRE.map((e) =>
      e.type === "backpack.drop" && e.ordinal === 2 ? { ...e, size_after: 5 } : e,
    );
    const snap = foldInventory(corrupted);
    expect(snap.health.ok).toBe(false);
    expect(snap.health.mismatch).toEqual({
      key: "backpack.observations",
      recordSeq: 1,
      expected: 4, // receipts say 3 + 1 accepted
      actual: 5, // scratchpad shows the corrupted size_after
    });
  });

  test("an empty stream folds to the empty snapshot (never crashes)", () => {
    const snap = foldInventory([]);
    expect(snap).toMatchObject({
      packs: [],
      stages: [],
      slots: [],
      empty: true,
      writeCount: 0,
      dropReceipts: 0,
      health: { ok: true },
    });
    expect(snap.lastWrite).toBeUndefined();
  });

  test("indexes minted past the preview budget still get honest preview-less ledger rows", () => {
    const snap = foldInventory([
      {
        type: "backpack.drop",
        key: "backpack.observations",
        origin: "explicit",
        ordinal: 1,
        accepted: 3,
        merged: 0,
        skipped: 0,
        indexes: [1, 2, 3],
        size_before: 0,
        size_after: 3,
        previews: [{ index: 1, op: "added", preview: "only one previewed" }],
        previews_omitted: 2,
      },
    ]);
    const entries = snap.packs[0]!.entries;
    expect(entries.map((e) => [e.index, e.preview ?? null])).toEqual([
      [1, "only one previewed"],
      [2, null],
      [3, null],
    ]);
  });

  test("absorb records append entries and count as DropRecords (FanOut fan-in)", () => {
    const snap = foldInventory([
      {
        type: "backpack.drop",
        key: "backpack.observations",
        origin: "explicit",
        ordinal: 1,
        accepted: 2,
        merged: 0,
        skipped: 0,
        indexes: [1, 2],
        size_before: 0,
        size_after: 2,
        previews: [],
        previews_omitted: 0,
      },
      {
        type: "backpack.absorb",
        key: "backpack.observations",
        origin: "innate",
        ordinal: 2,
        child_size: 2,
        accepted: 1,
        merged: 1,
        size_before: 2,
        size_after: 3,
        appended_indexes: [3],
      },
    ]);
    const pack = snap.packs[0]!;
    expect(pack.size).toBe(3);
    expect(pack.records.map((r) => r.kind)).toEqual(["drop", "absorb"]);
    expect(pack.entries.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(pack.merged).toBe(1);
    expect(snap.dropReceipts).toBe(2);
    expect(snap.health.ok).toBe(true);
  });
});
