/**
 * Contract tests for the chat reducer — the streaming-first core.
 *
 * Retargeted to the FRAMEWORK event vocabulary as it lands POST-`toEventLike`
 * (flat `EventLike`): bare event names (`message.delta`, `tool.start/end`,
 * `thinking`, `thinking.complete`, `error`, `message.complete`) with snake_case
 * payload fields (`tool_name`, `duration_ms`, `error_type`, `input_tokens`).
 *
 * The `message.delta` cases guard FOLD-FIX #1 (the framework emits
 * `message.delta`, not the cockpit's `message.chunk`). A persisted-row case is
 * retained to prove the snake_case-column / payload_json accessors still fold.
 */
import { describe, expect, test } from "vitest";
import type { EventLike } from "../graph/trace-from-events";
import { type Part, applyParts, coalesceStateParts, eventsToAssistantMessage } from "./model";
import type { StateDeltaPart } from "./state-accessors";

const fold = (events: EventLike[]): Part[] => {
  let parts: Part[] = [];
  for (const e of events) parts = applyParts(parts, e).parts;
  return parts;
};

describe("applyParts", () => {
  test("accumulates message.delta deltas into a single text part (fold-fix #1)", () => {
    const parts = fold([
      { type: "message.delta", delta: "Hel" },
      { type: "message.delta", delta: "lo " },
      { type: "message.delta", delta: "world" },
    ]);
    expect(parts).toEqual([{ kind: "text", content: "Hello world" }]);
  });

  test("folds input.request into an inline approval card (deduped by correlation_id)", () => {
    const parts = fold([
      {
        type: "input.request",
        correlation_id: "call-1",
        kind: "approval",
        prompt: 'Approve "ratify_definition"?',
        tool_name: "ratify_definition",
        arguments: { id: "def-1" },
      },
      // A re-delivered request for the same correlation id is a no-op.
      {
        type: "input.request",
        correlation_id: "call-1",
        kind: "approval",
        prompt: "dup",
      },
    ]);
    expect(parts).toEqual([
      {
        kind: "input_request",
        correlationId: "call-1",
        inputKind: "approval",
        prompt: 'Approve "ratify_definition"?',
        options: undefined,
        toolName: "ratify_definition",
        arguments: { id: "def-1" },
      },
    ]);
  });

  test("folds a select input.request carrying options", () => {
    const parts = fold([
      {
        type: "input.request",
        correlation_id: "pick-1",
        kind: "select",
        prompt: "Pick a stage",
        options: ["Discovery", "Negotiation"],
      },
    ]);
    expect(parts[0]).toMatchObject({
      kind: "input_request",
      inputKind: "select",
      options: ["Discovery", "Negotiation"],
    });
  });

  test("pairs tool.start with tool.end on the same tool_call_id", () => {
    const parts = fold([
      {
        type: "tool.start",
        tool_call_id: "t1",
        tool_name: "searchDeals",
        arguments: { q: "acme" },
      },
      {
        type: "tool.end",
        tool_call_id: "t1",
        tool_name: "searchDeals",
        result: [{ id: 1 }],
        duration_ms: 42,
      },
    ]);
    expect(parts).toHaveLength(1);
    const tc = parts[0] as Extract<Part, { kind: "tool_call" }>;
    expect(tc.kind).toBe("tool_call");
    expect(tc.id).toBe("t1");
    expect(tc.arguments).toEqual({ q: "acme" });
    expect(tc.result).toEqual([{ id: 1 }]);
    expect(tc.durationMs).toBe(42);
    expect(tc.error).toBeUndefined();
  });

  test("tool.end carries an error through to the tool_call part", () => {
    const parts = fold([
      { type: "tool.start", tool_call_id: "t1", tool_name: "risky" },
      { type: "tool.end", tool_call_id: "t1", tool_name: "risky", error: "boom" },
    ]);
    const tc = parts[0] as Extract<Part, { kind: "tool_call" }>;
    expect(tc.error).toBe("boom");
  });

  test("tool.rejected flags the part as rejected with a reason (no tool_call_id)", () => {
    const parts = fold([{ type: "tool.rejected", tool_name: "writeThing", reason: "gate denied" }]);
    const tc = parts[0] as Extract<Part, { kind: "tool_call" }>;
    expect(tc.kind).toBe("tool_call");
    expect(tc.name).toBe("writeThing");
    expect(tc.rejected).toBe(true);
    expect(tc.error).toBe("gate denied");
  });

  test("thinking streams then completes (upsert, not duplicate)", () => {
    const parts = fold([
      { type: "thinking", content: "let me " },
      { type: "thinking", content: "check" },
      { type: "thinking.complete", content: "let me check" },
    ]);
    expect(parts).toEqual([{ kind: "thinking", content: "let me check", complete: true }]);
  });

  test("error event appends an error part (snake_case error_type)", () => {
    const parts = fold([
      { type: "error", message: "kaboom", error_type: "ModelError", recoverable: false },
    ]);
    expect(parts).toEqual([{ kind: "error", errorType: "ModelError", message: "kaboom" }]);
  });

  test("message.complete yields model + token metadata, not a part", () => {
    const r = applyParts([], {
      type: "message.complete",
      content: "final",
      model: "sonnet",
      input_tokens: 120,
      output_tokens: 35,
    });
    expect(r.parts).toEqual([]);
    expect(r.meta).toEqual({ model: "sonnet", inputTokens: 120, outputTokens: 35 });
  });

  test("step.start + step.end fold into an agent_step part (delegation, not a tool)", () => {
    const parts = fold([
      {
        type: "step.start",
        span_id: "s1",
        step_name: "interpret",
        agent_name: "Interpreter",
        arguments: { question: "hi" },
      },
      {
        type: "step.end",
        span_id: "s1",
        step_name: "interpret",
        agent_name: "Interpreter",
        arguments: { question: "hi" },
        result: { requests: 1 },
        duration_ms: 12,
      },
    ]);
    expect(parts).toHaveLength(1);
    const st = parts[0] as Extract<Part, { kind: "agent_step" }>;
    expect(st.kind).toBe("agent_step");
    expect(st.id).toBe("s1");
    expect(st.name).toBe("interpret");
    expect(st.agentName).toBe("Interpreter");
    expect(st.arguments).toEqual({ question: "hi" });
    expect(st.result).toEqual({ requests: 1 });
    expect(st.durationMs).toBe(12);
    expect(st.children).toEqual([]);
  });

  test("a tool call whose parent_span_id matches a step nests UNDER it (agent contains tool)", () => {
    const parts = fold([
      { type: "step.start", span_id: "s1", step_name: "navigate", arguments: {} },
      {
        type: "tool.start",
        tool_call_id: "t1",
        tool_name: "select",
        parent_span_id: "s1",
        arguments: { entity: "observations" },
      },
      {
        type: "tool.end",
        tool_call_id: "t1",
        tool_name: "select",
        parent_span_id: "s1",
        result: { rows: 60 },
        duration_ms: 8,
      },
      {
        type: "step.end",
        span_id: "s1",
        step_name: "navigate",
        result: { pool: 60 },
        duration_ms: 20,
      },
    ]);
    // Exactly ONE top-level part — the step; the tool is nested in its children.
    expect(parts).toHaveLength(1);
    const st = parts[0] as Extract<Part, { kind: "agent_step" }>;
    expect(st.kind).toBe("agent_step");
    expect(st.children).toHaveLength(1);
    const child = st.children[0] as Extract<Part, { kind: "tool_call" }>;
    expect(child.kind).toBe("tool_call");
    expect(child.name).toBe("select");
    expect(child.result).toEqual({ rows: 60 });
    expect(st.result).toEqual({ pool: 60 }); // the step still resolves its own output
  });

  test("a tool call with no matching parent stays top-level (back-compat)", () => {
    const parts = fold([
      { type: "step.start", span_id: "s1", step_name: "curate", arguments: {} },
      { type: "tool.start", tool_call_id: "t9", tool_name: "orphan", parent_span_id: "nope" },
      { type: "tool.end", tool_call_id: "t9", tool_name: "orphan", result: 1, duration_ms: 3 },
    ]);
    expect(parts.map((p) => p.kind)).toEqual(["agent_step", "tool_call"]);
  });
});

/* ── state-delta frames (#226) ─────────────────────────────────────────────
 * Wire shape per the runtime's `toSSEMapping` (snake_case, flattened by
 * `toEventLike`); the persisted-row case pins the camelCase tolerance of the
 * shared accessor module (state-accessors.ts).
 */
describe("applyParts — state deltas (#226)", () => {
  const drop = (over: Record<string, unknown> = {}): EventLike => ({
    type: "backpack.drop",
    key: "backpack.observations",
    origin: "explicit",
    ordinal: 1,
    accepted: 4,
    merged: 0,
    skipped: 1,
    indexes: [1, 2, 3, 4],
    size_before: 0,
    size_after: 4,
    previews: [
      { index: 1, op: "added", preview: "obs · security review gating" },
      { index: 2, op: "added", preview: "obs · CFO approved budget" },
    ],
    previews_omitted: 2,
    tag: '{"facet":"observations"}',
    display: { caption: "Evidence" },
    ...over,
  });

  test("backpack.drop folds into a standalone state_delta drop frame", () => {
    const parts = fold([drop()]);
    expect(parts).toHaveLength(1);
    const f = parts[0] as Extract<StateDeltaPart, { op: "drop" }>;
    expect(f.kind).toBe("state_delta");
    expect(f.op).toBe("drop");
    expect(f.key).toBe("backpack.observations");
    expect(f.origin).toBe("explicit");
    expect(f.ordinal).toBe(1);
    expect(f.accepted).toBe(4);
    expect(f.merged).toBe(0);
    expect(f.skipped).toBe(1);
    expect(f.indexes).toEqual([1, 2, 3, 4]);
    expect(f.sizeBefore).toBe(0);
    expect(f.sizeAfter).toBe(4);
    expect(f.previews).toEqual([
      { index: 1, op: "added", preview: "obs · security review gating" },
      { index: 2, op: "added", preview: "obs · CFO approved budget" },
    ]);
    expect(f.previewsOmitted).toBe(2);
    expect(f.tag).toBe('{"facet":"observations"}');
    expect(f.display).toEqual({ caption: "Evidence" });
    expect(f.dropSeq).toBe(0); // first DropRecord for this pack
  });

  test("a drop with tool_call_id nests immediately after its causing tool (via = tool name)", () => {
    const parts = fold([
      { type: "tool.start", tool_call_id: "t1", tool_name: "search_deal_context" },
      drop({ tool_call_id: "t1" }),
      { type: "tool.end", tool_call_id: "t1", tool_name: "search_deal_context", result: {} },
    ]);
    expect(parts.map((p) => p.kind)).toEqual(["tool_call", "state_delta"]);
    const f = parts[1] as Extract<StateDeltaPart, { op: "drop" }>;
    expect(f.toolCallId).toBe("t1");
    expect(f.via).toBe("search_deal_context");
  });

  test("a drop whose tool lives in an agent_step's children nests INSIDE the step", () => {
    const parts = fold([
      { type: "step.start", span_id: "s1", step_name: "retrieve" },
      { type: "tool.start", tool_call_id: "t1", tool_name: "search", parent_span_id: "s1" },
      drop({ tool_call_id: "t1" }),
      { type: "tool.end", tool_call_id: "t1", tool_name: "search", parent_span_id: "s1" },
    ]);
    expect(parts).toHaveLength(1);
    const step = parts[0] as Extract<Part, { kind: "agent_step" }>;
    expect(step.children.map((c) => c.kind)).toEqual(["tool_call", "state_delta"]);
  });

  test("a drop with an unmatched tool_call_id stays standalone (honest degradation)", () => {
    const parts = fold([drop({ tool_call_id: "nope" })]);
    expect(parts.map((p) => p.kind)).toEqual(["state_delta"]);
    const f = parts[0] as Extract<StateDeltaPart, { op: "drop" }>;
    expect(f.via).toBeUndefined();
  });

  test("dropSeq counts DropRecords per pack in fold order", () => {
    const parts = fold([drop(), drop({ ordinal: 2, size_before: 4, size_after: 6 })]);
    const seqs = parts.map((p) => (p as Extract<StateDeltaPart, { op: "drop" }>).dropSeq);
    expect(seqs).toEqual([0, 1]);
  });

  test("scratchpad.write folds set/update, hadValue, before/after previews", () => {
    const parts = fold([
      {
        type: "scratchpad.write",
        key: "brief.highlights",
        origin: "explicit",
        ordinal: 3,
        op: "set",
        had_value: false,
        after: '["#1","#2"]',
      },
    ]);
    const f = parts[0] as Extract<StateDeltaPart, { op: "write" }>;
    expect(f.op).toBe("write");
    expect(f.writeOp).toBe("set");
    expect(f.hadValue).toBe(false);
    expect(f.before).toBeUndefined();
    expect(f.after).toBe('["#1","#2"]');
  });

  test("innate scratchpad events carry origin through (the auto chip's source)", () => {
    const parts = fold([
      {
        type: "scratchpad.write",
        key: "agents.retrieve",
        origin: "innate",
        ordinal: 2,
        op: "set",
        had_value: false,
        after: "{…}",
      },
    ]);
    expect((parts[0] as StateDeltaPart).origin).toBe("innate");
  });

  test("backpack.read folds memo hit/miss with size + preview", () => {
    const parts = fold([
      {
        type: "backpack.read",
        key: "backpack.observations",
        origin: "explicit",
        ordinal: 4,
        memo_hit: true,
        size: 6,
        preview: "{ timeline: … } (preview only)",
      },
    ]);
    const f = parts[0] as Extract<StateDeltaPart, { op: "read" }>;
    expect(f.op).toBe("read");
    expect(f.scope).toBe("backpack");
    expect(f.memoHit).toBe(true);
    expect(f.size).toBe(6);
    expect(f.preview).toBe("{ timeline: … } (preview only)");
  });

  test("scratchpad fork/join fold shared / merged+discarded keys (the silent-discard trap)", () => {
    const parts = fold([
      { type: "scratchpad.fork", origin: "innate", ordinal: 5, shared_keys: ["notes.draft"] },
      {
        type: "scratchpad.join",
        origin: "innate",
        ordinal: 6,
        merged_keys: ["notes.draft"],
        discarded_keys: ["temp.scratch"],
      },
    ]);
    const fork = parts[0] as Extract<StateDeltaPart, { op: "fork" }>;
    const join = parts[1] as Extract<StateDeltaPart, { op: "join" }>;
    expect(fork.sharedKeys).toEqual(["notes.draft"]);
    expect(join.mergedKeys).toEqual(["notes.draft"]);
    expect(join.discardedKeys).toEqual(["temp.scratch"]);
  });

  test("backpack.absorb folds branch fan-in with appended indexes", () => {
    const parts = fold([
      {
        type: "backpack.absorb",
        key: "backpack.observations",
        origin: "innate",
        ordinal: 7,
        child_size: 3,
        accepted: 2,
        merged: 1,
        size_before: 12,
        size_after: 14,
        appended_indexes: [13, 14],
      },
    ]);
    const f = parts[0] as Extract<StateDeltaPart, { op: "absorb" }>;
    expect(f.op).toBe("absorb");
    expect(f.childSize).toBe(3);
    expect(f.appendedIndexes).toEqual([13, 14]);
    expect(f.sizeAfter).toBe(14);
  });

  test("reads the PERSISTED row shape (camelCase payload_json) via the shared accessors", () => {
    const parts = fold([
      {
        type: "agent.backpack.drop",
        run_id: "r1",
        payload_json: JSON.stringify({
          key: "backpack.observations",
          origin: "explicit",
          ordinal: 1,
          accepted: 2,
          merged: 1,
          skipped: 0,
          indexes: [5, 6, 1],
          sizeBefore: 4,
          sizeAfter: 6,
          previews: [{ index: 5, op: "added", preview: "artifact · meeting" }],
          previewsOmitted: 0,
          toolCallId: "t9",
        }),
      },
    ]);
    const f = parts[0] as Extract<StateDeltaPart, { op: "drop" }>;
    expect(f.kind).toBe("state_delta");
    expect(f.sizeBefore).toBe(4);
    expect(f.sizeAfter).toBe(6);
    expect(f.toolCallId).toBe("t9");
    expect(f.previews).toEqual([{ index: 5, op: "added", preview: "artifact · meeting" }]);
  });

  test("a state event with no key is ignored, not crashed on", () => {
    const parts = fold([{ type: "backpack.drop", origin: "explicit", ordinal: 1 }]);
    expect(parts).toEqual([]);
  });
});

describe("applyParts — derived TRAVEL frames (#226, v1 UI-derived)", () => {
  const dropIn = (toolId: string, over: Record<string, unknown> = {}): EventLike[] => [
    { type: "tool.start", tool_call_id: toolId, tool_name: "search", parent_span_id: "s1" },
    {
      type: "backpack.drop",
      key: "backpack.observations",
      origin: "explicit",
      ordinal: 1,
      accepted: 4,
      merged: 0,
      skipped: 0,
      indexes: [1, 2, 3, 4],
      size_before: 0,
      size_after: 4,
      previews: [{ index: 1, op: "added", preview: "obs · one" }],
      previews_omitted: 0,
      tool_call_id: toolId,
      ...over,
    },
    { type: "tool.end", tool_call_id: toolId, tool_name: "search", parent_span_id: "s1" },
  ];

  test("a stage boundary after drops derives one ⇄ frame per pack, before the new step", () => {
    const parts = fold([
      { type: "step.start", span_id: "s1", step_name: "retrieve" },
      ...dropIn("t1"),
      { type: "step.end", span_id: "s1", step_name: "retrieve", result: {} },
      { type: "step.start", span_id: "s2", step_name: "correlate" },
    ]);
    expect(parts.map((p) => p.kind)).toEqual(["agent_step", "state_delta", "agent_step"]);
    const travel = parts[1] as Extract<StateDeltaPart, { op: "travel" }>;
    expect(travel.op).toBe("travel");
    expect(travel.derived).toBe(true);
    expect(travel.key).toBe("backpack.observations");
    expect(travel.toStep).toBe("correlate");
    expect(travel.items).toBe(4);
    expect(travel.records).toEqual([{ drop: 0, covered: 4 }]);
    expect(travel.previews).toEqual([{ index: 1, op: "added", preview: "obs · one" }]);
    expect(travel.quiet).toBeUndefined();
  });

  test("no drops yet → the first step.start derives nothing", () => {
    const parts = fold([{ type: "step.start", span_id: "s1", step_name: "retrieve" }]);
    expect(parts.map((p) => p.kind)).toEqual(["agent_step"]);
  });

  test("a boundary with NO new drops since the last travel derives the honest quiet variant", () => {
    const parts = fold([
      { type: "step.start", span_id: "s1", step_name: "retrieve" },
      ...dropIn("t1"),
      { type: "step.end", span_id: "s1", step_name: "retrieve", result: {} },
      { type: "step.start", span_id: "s2", step_name: "correlate" },
      { type: "step.end", span_id: "s2", step_name: "correlate", result: {} },
      { type: "step.start", span_id: "s3", step_name: "brief" },
    ]);
    const travels = parts.filter(
      (p): p is Extract<StateDeltaPart, { op: "travel" }> =>
        p.kind === "state_delta" && p.op === "travel",
    );
    expect(travels).toHaveLength(2);
    expect(travels[0]?.quiet).toBeUndefined();
    expect(travels[1]?.quiet).toBe(true);
    expect(travels[1]?.toStep).toBe("brief");
    expect(travels[1]?.sinceStep).toBe("retrieve"); // the stage that last dropped
    expect(travels[1]?.items).toBe(4);
  });

  test("a NESTED step.start (parent span present) derives no travel frames", () => {
    const parts = fold([
      { type: "step.start", span_id: "s1", step_name: "retrieve" },
      ...dropIn("t1"),
      { type: "step.start", span_id: "s1b", step_name: "sub", parent_span_id: "s1" },
    ]);
    expect(parts.filter((p) => p.kind === "state_delta").every((p) => p.op !== "travel")).toBe(
      true,
    );
  });
});

describe("coalesceStateParts (#226 — 3+ consecutive same-site frames)", () => {
  const writeEvent = (key: string, ordinal: number): EventLike => ({
    type: "scratchpad.write",
    key,
    origin: "explicit",
    ordinal,
    op: "set",
    had_value: false,
    after: "v",
  });

  test("3+ consecutive explicit write frames fold into one state_group", () => {
    const parts = fold([writeEvent("a", 1), writeEvent("b", 2), writeEvent("c", 3)]);
    const view = coalesceStateParts(parts);
    expect(view).toHaveLength(1);
    const group = view[0] as Extract<Part, { kind: "state_group" }>;
    expect(group.kind).toBe("state_group");
    expect(group.parts).toHaveLength(3);
  });

  test("2 consecutive frames stay individual", () => {
    const parts = fold([writeEvent("a", 1), writeEvent("b", 2)]);
    expect(coalesceStateParts(parts).map((p) => p.kind)).toEqual(["state_delta", "state_delta"]);
  });

  test("any other part breaks the run", () => {
    const parts = fold([
      writeEvent("a", 1),
      writeEvent("b", 2),
      { type: "message.delta", delta: "hi" },
      writeEvent("c", 3),
    ]);
    expect(coalesceStateParts(parts).map((p) => p.kind)).toEqual([
      "state_delta",
      "state_delta",
      "text",
      "state_delta",
    ]);
  });

  test("innate frames and reads never coalesce (the stage-boundary trio stays legible)", () => {
    const parts = fold([
      {
        type: "scratchpad.write",
        key: "agents.retrieve",
        origin: "innate",
        ordinal: 1,
        op: "set",
        had_value: false,
        after: "{…}",
      },
      {
        type: "scratchpad.read",
        key: "agents.retrieve",
        origin: "innate",
        ordinal: 2,
        preview: "TASK: …",
      },
      {
        type: "backpack.read",
        key: "backpack.observations",
        origin: "explicit",
        ordinal: 3,
        memo_hit: true,
        size: 6,
        preview: "p",
      },
    ]);
    expect(coalesceStateParts(parts).every((p) => p.kind === "state_delta")).toBe(true);
  });

  test("coalesces inside an agent_step's children too", () => {
    const events: EventLike[] = [
      { type: "step.start", span_id: "s1", step_name: "loop" },
      { type: "tool.start", tool_call_id: "t1", tool_name: "process", parent_span_id: "s1" },
    ];
    for (let i = 0; i < 4; i++) {
      events.push({
        type: "backpack.drop",
        key: "backpack.observations",
        origin: "explicit",
        ordinal: i + 1,
        accepted: 1,
        merged: 0,
        skipped: 0,
        indexes: [i + 1],
        size_before: i,
        size_after: i + 1,
        previews: [],
        previews_omitted: 0,
        tool_call_id: "t1",
      });
    }
    const parts = fold(events);
    const view = coalesceStateParts(parts);
    const step = view[0] as Extract<Part, { kind: "agent_step" }>;
    expect(step.children.map((c) => c.kind)).toEqual(["tool_call", "state_group"]);
    const group = step.children[1] as Extract<Part, { kind: "state_group" }>;
    expect(group.parts).toHaveLength(4);
  });
});

describe("eventsToAssistantMessage", () => {
  test("interleaves thinking, text, tool call, text in seq order", () => {
    const msg = eventsToAssistantMessage("a", [
      { type: "thinking", content: "plan", seq: 1 },
      { type: "thinking.complete", content: "plan", seq: 2 },
      { type: "message.delta", delta: "First ", seq: 3 },
      { type: "tool.start", tool_call_id: "t1", tool_name: "add", arguments: { a: 1 }, seq: 4 },
      { type: "tool.end", tool_call_id: "t1", tool_name: "add", result: 3, duration_ms: 5, seq: 5 },
      { type: "message.delta", delta: "done", seq: 6 },
      { type: "message.complete", model: "opus", input_tokens: 9, output_tokens: 2, seq: 7 },
    ]);
    expect(msg.parts.map((p) => p.kind)).toEqual(["thinking", "text", "tool_call", "text"]);
    expect((msg.parts[1] as Extract<Part, { kind: "text" }>).content).toBe("First ");
    expect((msg.parts[3] as Extract<Part, { kind: "text" }>).content).toBe("done");
    expect(msg.model).toBe("opus");
    expect(msg.outputTokens).toBe(2);
  });

  test("reads the PERSISTED row shape (snake_case columns + payload_json)", () => {
    const msg = eventsToAssistantMessage("a", [
      {
        type: "tool.start",
        seq: 1,
        tool_call_id: "t1",
        tool_name: "fetchRows",
        args_json: '{"limit":5}',
        payload_json: '{"toolName":"fetchRows","toolCallId":"t1","arguments":{"limit":5}}',
        run_id: "r1",
      },
      {
        type: "tool.end",
        seq: 2,
        tool_call_id: "t1",
        tool_name: "fetchRows",
        result_json: "[1,2,3]",
        duration_ms: 17,
        payload_json: '{"toolName":"fetchRows","result":[1,2,3],"durationMs":17}',
        run_id: "r1",
      },
    ]);
    const tc = msg.parts[0] as Extract<Part, { kind: "tool_call" }>;
    expect(tc.kind).toBe("tool_call");
    expect(tc.name).toBe("fetchRows");
    expect(tc.arguments).toEqual({ limit: 5 });
    expect(tc.result).toEqual([1, 2, 3]);
    expect(tc.durationMs).toBe(17);
  });

  test("sorts out-of-order events by seq before folding", () => {
    const msg = eventsToAssistantMessage("a", [
      { type: "message.delta", delta: "B", seq: 2 },
      { type: "message.delta", delta: "A", seq: 1 },
    ]);
    expect((msg.parts[0] as Extract<Part, { kind: "text" }>).content).toBe("AB");
  });
});

describe("applyParts — #324 kinds (gate.decision / harness.native / cost)", () => {
  test("folds gate.decision into a gate_decision part with trail + provenance", () => {
    const parts = fold([
      {
        type: "gate.decision",
        tool_name: "deleteFile",
        outcome: "block",
        settled_by: "gate",
        blocked_by: "safety",
        reason: "destructive path",
        trail: [
          { gate: "safety", result: "block" },
          { gate: "rate-limit", result: "allow" },
        ],
      },
    ]);
    expect(parts).toEqual([
      {
        kind: "gate_decision",
        toolName: "deleteFile",
        outcome: "block",
        settledBy: "gate",
        blockedBy: "safety",
        reason: "destructive path",
        trail: [
          { gate: "safety", result: "block" },
          { gate: "rate-limit", result: "allow" },
        ],
      },
    ]);
  });

  test("folds harness.native into a collapsed envelope part", () => {
    const parts = fold([
      {
        type: "harness.native",
        harness: "claude-code",
        name: "compact_boundary",
        payload: { pre_tokens: 1200, trigger: "auto" },
      },
    ]);
    expect(parts).toEqual([
      {
        kind: "harness_native",
        harness: "claude-code",
        name: "compact_boundary",
        payload: { pre_tokens: 1200, trigger: "auto" },
      },
    ]);
  });

  test("message.complete carries costUsd from the wire (cost_usd) into message meta", () => {
    const msg = eventsToAssistantMessage("a", [
      {
        type: "message.complete",
        model: "opus",
        input_tokens: 9,
        output_tokens: 2,
        cost_usd: 0.0123,
        seq: 1,
      },
    ]);
    expect(msg.costUsd).toBe(0.0123);
  });

  test("message.complete reads persisted camelCase costUsd too", () => {
    const msg = eventsToAssistantMessage("a", [
      {
        type: "message.complete",
        seq: 1,
        run_id: "r1",
        payload_json: '{"model":"opus","inputTokens":9,"outputTokens":2,"costUsd":0.5}',
      },
    ]);
    expect(msg.costUsd).toBe(0.5);
  });

  /* ── render artifacts (ADR-0006) ────────────────────────────────────────── */

  test("tool.end carries a wire-shaped artifacts array (snake_case display_type) onto the tool_call", () => {
    const parts = fold([
      { type: "tool.start", tool_call_id: "t1", tool_name: "listDeals" },
      {
        type: "tool.end",
        tool_call_id: "t1",
        tool_name: "listDeals",
        result: "23 deals",
        artifacts: [
          {
            id: "crm_table:abc",
            display_type: "table",
            data: { columns: ["name"], rows: [["Acme"]] },
            title: "May deals",
          },
        ],
      },
    ]);
    const tc = parts[0] as Extract<Part, { kind: "tool_call" }>;
    expect(tc.artifacts).toEqual([
      {
        id: "crm_table:abc",
        displayType: "table",
        data: { columns: ["name"], rows: [["Acme"]] },
        title: "May deals",
      },
    ]);
  });

  test("tool.end with no artifacts key leaves tool_call.artifacts undefined", () => {
    const parts = fold([
      { type: "tool.start", tool_call_id: "t1", tool_name: "noop" },
      { type: "tool.end", tool_call_id: "t1", tool_name: "noop", result: "ok" },
    ]);
    const tc = parts[0] as Extract<Part, { kind: "tool_call" }>;
    expect(tc.artifacts).toBeUndefined();
  });

  test("a malformed artifact entry (missing id) is dropped, not thrown", () => {
    const parts = fold([
      { type: "tool.start", tool_call_id: "t1", tool_name: "listDeals" },
      {
        type: "tool.end",
        tool_call_id: "t1",
        tool_name: "listDeals",
        result: "ok",
        artifacts: [
          { display_type: "table", data: { columns: [], rows: [] } },
          { id: "good:1", display_type: "table", data: { columns: [], rows: [] } },
        ],
      },
    ]);
    const tc = parts[0] as Extract<Part, { kind: "tool_call" }>;
    expect(tc.artifacts).toHaveLength(1);
    expect(tc.artifacts?.[0]?.id).toBe("good:1");
  });

  test("a ceiling marker (data absent) parses with data left undefined, never fabricated", () => {
    const parts = fold([
      { type: "tool.start", tool_call_id: "t1", tool_name: "listDeals" },
      {
        type: "tool.end",
        tool_call_id: "t1",
        tool_name: "listDeals",
        result: "ok",
        artifacts: [{ id: "crm_table:big", display_type: "table", truncated: true }],
      },
    ]);
    const tc = parts[0] as Extract<Part, { kind: "tool_call" }>;
    expect(tc.artifacts).toEqual([{ id: "crm_table:big", displayType: "table", truncated: true }]);
    expect("data" in (tc.artifacts?.[0] ?? {})).toBe(false);
  });

  test("message.complete artifacts with no matching prior tool become a standalone artifacts part", () => {
    const parts = fold([
      { type: "message.delta", delta: "23 deals closed." },
      {
        type: "message.complete",
        artifacts: [
          { id: "crm_table:xyz", display_type: "table", data: { columns: [], rows: [] } },
        ],
      },
    ]);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({
      kind: "artifacts",
      items: [{ id: "crm_table:xyz", displayType: "table", data: { columns: [], rows: [] } }],
    });
  });

  test("message.complete artifacts already emitted on an earlier tool.end are deduped", () => {
    const parts = fold([
      { type: "tool.start", tool_call_id: "t1", tool_name: "listDeals" },
      {
        type: "tool.end",
        tool_call_id: "t1",
        tool_name: "listDeals",
        result: "ok",
        artifacts: [
          { id: "crm_table:dup", display_type: "table", data: { columns: [], rows: [] } },
        ],
      },
      {
        type: "message.complete",
        artifacts: [
          { id: "crm_table:dup", display_type: "table", data: { columns: [], rows: [] } },
        ],
      },
    ]);
    // Only the tool_call carries it — no second standalone `artifacts` part.
    expect(parts).toHaveLength(1);
    expect(parts.some((p) => p.kind === "artifacts")).toBe(false);
  });

  test("llm.end carrying an artifacts field is ignored (artifacts ride on message.complete only)", () => {
    const parts = fold([
      {
        type: "llm.end",
        artifacts: [
          { id: "crm_table:xyz", display_type: "table", data: { columns: [], rows: [] } },
        ],
      },
    ]);
    expect(parts).toEqual([]);
  });

  /* ── structured terminal answer (ADR-0006 §9) ──────────────────────────── */

  test("structured_content byte-identical to the accumulated text REPLACES that text part", () => {
    const structured = { answer: "We closed 23 deals.", ref: "crm_table:e891" };
    const parts = fold([
      { type: "message.delta", delta: JSON.stringify(structured) },
      { type: "message.complete", structured_content: structured },
    ]);
    expect(parts).toEqual([{ kind: "answer", value: structured }]);
  });

  test("structured_content with no matching text part is APPENDED, not mangled", () => {
    const structured = { answer: "23 deals." };
    const parts = fold([
      { type: "message.delta", delta: "some other prose" },
      { type: "message.complete", structured_content: structured },
    ]);
    expect(parts).toEqual([
      { kind: "text", content: "some other prose" },
      { kind: "answer", value: structured },
    ]);
  });

  test("structured_content with NO preceding text at all is appended standalone", () => {
    const structured = { answer: "23 deals." };
    const parts = fold([{ type: "message.complete", structured_content: structured }]);
    expect(parts).toEqual([{ kind: "answer", value: structured }]);
  });

  test("reads persisted camelCase structuredContent the same as wire structured_content", () => {
    const structured = { answer: "23 deals." };
    const msg = eventsToAssistantMessage("a", [
      {
        type: "message.delta",
        delta: JSON.stringify(structured),
        seq: 1,
      },
      {
        type: "message.complete",
        seq: 2,
        run_id: "r1",
        payload_json: JSON.stringify({ structuredContent: structured }),
      },
    ]);
    expect(msg.parts).toEqual([{ kind: "answer", value: structured }]);
  });

  test("llm.end carrying structured_content is ignored (rides on message.complete only)", () => {
    const parts = fold([
      { type: "message.delta", delta: JSON.stringify({ answer: "x" }) },
      { type: "llm.end", structured_content: { answer: "x" } },
    ]);
    expect(parts).toEqual([{ kind: "text", content: JSON.stringify({ answer: "x" }) }]);
  });

  test("a normal string answer with no structured_content is completely unaffected", () => {
    const parts = fold([
      { type: "message.delta", delta: "Hello there." },
      { type: "message.complete", model: "sonnet" },
    ]);
    expect(parts).toEqual([{ kind: "text", content: "Hello there." }]);
  });

  test("message.complete can carry BOTH structured_content and artifacts in one fold", () => {
    const structured = { answer: "23 deals.", ref: "crm_table:xyz" };
    const parts = fold([
      { type: "message.delta", delta: JSON.stringify(structured) },
      {
        type: "message.complete",
        structured_content: structured,
        artifacts: [
          { id: "crm_table:xyz", display_type: "table", data: { columns: [], rows: [] } },
        ],
      },
    ]);
    expect(parts).toEqual([
      { kind: "answer", value: structured },
      {
        kind: "artifacts",
        items: [{ id: "crm_table:xyz", displayType: "table", data: { columns: [], rows: [] } }],
      },
    ]);
  });
});
