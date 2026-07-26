/**
 * Tests for the `deferred` session strategy — the A-2 session-economics path.
 *
 * A scripted SDK mock lets us assert the mechanism without a live CLI: that a
 * second `doGenerate` for the same conversation **resumes** the first turn's
 * session (`options.resume`) rather than spawning a fresh one, that the resume
 * hook **allows** the pending deferred call and **defers** new ones, that the
 * session id is stable (append-only), and that a poisoned resume degrades to
 * the flatten path.
 */

import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Scriptable SDK mock
// ---------------------------------------------------------------------------

interface Resp {
  sessionId: string;
  /** If set, the result carries `deferred_tool_use` with this id. */
  deferredId?: string;
  isError?: boolean;
  terminalReason?: string;
  stopReason?: string;
  text?: string;
  /** If set, the mock probes the PreToolUse hook to record its decisions. */
  probeHook?: { pendingId: string; newId: string };
}

interface CallRec {
  resume: string | undefined;
  initSessions: string[];
}

const responses: Resp[] = [];
const calls: CallRec[] = [];
const hookDecisions: { pending?: string; other?: string } = {};

function resetMock(): void {
  responses.length = 0;
  calls.length = 0;
  hookDecisions.pending = undefined;
  hookDecisions.other = undefined;
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; tools: unknown[] }) => ({
    type: "sdk",
    name: opts.name,
    instance: { tools: opts.tools },
  }),
  tool: (name: string, description: string) => ({ name, description }),
  query: ({ options }: { prompt: string; options: Record<string, unknown> }) => {
    const resp = responses.shift() ?? { sessionId: "s-default", stopReason: "end_turn" };
    const rec: CallRec = { resume: options.resume as string | undefined, initSessions: [] };
    calls.push(rec);
    const hook = (
      options.hooks as
        | {
            PreToolUse?: Array<{
              hooks?: Array<
                (
                  input: Record<string, unknown>,
                  id: string,
                  ctx: { signal: AbortSignal },
                ) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>
              >;
            }>;
          }
        | undefined
    )?.PreToolUse?.[0]?.hooks?.[0];

    async function* gen() {
      rec.initSessions.push(resp.sessionId);
      yield { type: "system", subtype: "init", session_id: resp.sessionId };

      if (resp.probeHook && hook) {
        const ctx = { signal: new AbortController().signal };
        const mk = (id: string) => ({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__agent_runner_tools__add",
          tool_input: {},
          tool_use_id: id,
        });
        const p = await hook(mk(resp.probeHook.pendingId), resp.probeHook.pendingId, ctx);
        const o = await hook(mk(resp.probeHook.newId), resp.probeHook.newId, ctx);
        hookDecisions.pending = p.hookSpecificOutput?.permissionDecision;
        hookDecisions.other = o.hookSpecificOutput?.permissionDecision;
      }

      if (resp.text) {
        yield { type: "assistant", message: { content: [{ text: resp.text }] } };
      }

      yield {
        type: "result",
        subtype: "success",
        is_error: resp.isError ?? false,
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: resp.deferredId ? "tool_deferred" : (resp.stopReason ?? "end_turn"),
        terminal_reason: resp.terminalReason ?? (resp.deferredId ? "tool_deferred" : "completed"),
        session_id: resp.sessionId,
        deferred_tool_use: resp.deferredId
          ? { id: resp.deferredId, name: "mcp__agent_runner_tools__add", input: {} }
          : undefined,
      };
    }

    return gen();
  },
}));

import { claudeCode } from "../claude-code.js";

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function" as const,
    name: "add",
    description: "Add two numbers",
    inputSchema: { type: "object", properties: {}, additionalProperties: true } as const,
  },
];

function callOptions(prompt: LanguageModelV4Prompt): LanguageModelV4CallOptions {
  return { tools: TOOLS, prompt };
}

const TURN1: LanguageModelV4Prompt = [
  { role: "system", content: "Math bot." },
  { role: "user", content: [{ type: "text", text: "17 + 28?" }] },
];

/** Turn-2 prompt: turn 1 + the deferred tool call + its result. */
function turn2(deferredId: string): LanguageModelV4Prompt {
  return [
    ...TURN1,
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: deferredId, toolName: "add", input: { a: 17, b: 28 } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: deferredId,
          toolName: "add",
          output: { type: "json", value: { result: 45 } },
        },
      ],
    },
  ];
}

const disposables: Array<{ dispose: () => void }> = [];
function makeModel() {
  const m = claudeCode("haiku", { config: { mode: "host" }, sessionStrategy: "deferred" });
  disposables.push(m);
  return m;
}

beforeEach(() => resetMock());
afterEach(() => {
  for (const d of disposables) d.dispose();
  disposables.length = 0;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deferred strategy — session reuse", () => {
  it("resumes the first turn's session on the second doGenerate (append-only)", async () => {
    responses.push({ sessionId: "s1", deferredId: "tc-0" }); // turn 1 → tool call
    responses.push({ sessionId: "s1", text: "45" }); // turn 2 → final answer (resume)

    const model = makeModel();
    const r1 = await model.doGenerate(callOptions(TURN1));
    const r2 = await model.doGenerate(callOptions(turn2("tc-0")));

    // Turn 1 surfaced the deferred call.
    const toolCall = r1.content.find((c) => c.type === "tool-call");
    expect(toolCall).toMatchObject({ toolName: "add", toolCallId: "tc-0" });
    // Turn 2 returned the model's continuation after the parked result.
    expect(r2.content.find((c) => c.type === "text")).toMatchObject({ text: "45" });

    // Two SDK calls: fresh, then a resume of the SAME session.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.resume).toBeUndefined();
    expect(calls[1]?.resume).toBe("s1");
    // ≤1 subprocess (init) per LLM turn.
    expect(calls[0]?.initSessions).toEqual(["s1"]);
    expect(calls[1]?.initSessions).toEqual(["s1"]);
  });

  it("allows the pending deferred call on resume and defers a new one", async () => {
    responses.push({ sessionId: "s1", deferredId: "tc-0" });
    responses.push({
      sessionId: "s1",
      text: "45",
      probeHook: { pendingId: "tc-0", newId: "tc-9" },
    });

    const model = makeModel();
    await model.doGenerate(callOptions(TURN1));
    await model.doGenerate(callOptions(turn2("tc-0")));

    expect(hookDecisions.pending).toBe("allow"); // the resumed call executes via the shim
    expect(hookDecisions.other).toBe("defer"); // a new call is handed back to AgentRunner
  });

  it("chains a second deferred call, still on one session", async () => {
    responses.push({ sessionId: "s1", deferredId: "tc-0" }); // turn 1
    responses.push({ sessionId: "s1", deferredId: "tc-1" }); // turn 2 resume → next tool
    responses.push({ sessionId: "s1", text: "done" }); // turn 3 resume → answer

    const model = makeModel();
    await model.doGenerate(callOptions(TURN1));
    const r2 = await model.doGenerate(callOptions(turn2("tc-0")));
    const r3 = await model.doGenerate(callOptions(turn2("tc-1")));

    expect(r2.content.find((c) => c.type === "tool-call")).toMatchObject({ toolCallId: "tc-1" });
    expect(r3.content.find((c) => c.type === "text")).toMatchObject({ text: "done" });
    expect(calls.map((c) => c.resume)).toEqual([undefined, "s1", "s1"]);
  });
});

describe("deferred strategy — poisoned-call guard", () => {
  it("degrades to flatten when resume returns tool_deferred_unavailable", async () => {
    responses.push({ sessionId: "s1", deferredId: "tc-0" }); // turn 1 fresh
    responses.push({ sessionId: "s1", isError: true, terminalReason: "tool_deferred_unavailable" }); // poisoned resume
    responses.push({ sessionId: "s2", text: "recovered" }); // flatten fallback

    const model = makeModel();
    await model.doGenerate(callOptions(TURN1));
    const r2 = await model.doGenerate(callOptions(turn2("tc-0")));

    // The turn recovered via the flatten path (full history is in the prompt).
    expect(r2.content.find((c) => c.type === "text")).toMatchObject({ text: "recovered" });
    // Three SDK calls: fresh, poisoned resume, flatten (no resume).
    expect(calls.map((c) => c.resume)).toEqual([undefined, "s1", undefined]);
  });
});

describe("flatten strategy — no session resume", () => {
  it("runs a fresh query per doGenerate and never resumes", async () => {
    responses.push({ sessionId: "s1", deferredId: "tc-0" });
    responses.push({ sessionId: "s2", text: "45" });

    const model = claudeCode("haiku", { config: { mode: "host" }, sessionStrategy: "flatten" });
    disposables.push(model);
    await model.doGenerate(callOptions(TURN1));
    await model.doGenerate(callOptions(turn2("tc-0")));

    expect(calls.map((c) => c.resume)).toEqual([undefined, undefined]);
  });
});
