/**
 * Backpack — topology / replay integration suite (spec §5, second list).
 *
 * These exercise the backpack across the runtime's real composition seams —
 * Retry, Loop, FanOut, the agent-as-tool (`nodeTool`) fork, `sequentialAgent`
 * (the motivating consumer), the bare `AgentRunner` host, and the intent gate —
 * proving the §3 mechanism claims end to end: the drop rides the blessed
 * `ToolExecutionContext.host` passthrough (#124), a run-scoped pack is shared by
 * reference through forks, a branch-scoped pack fans in via `absorb`, and the
 * write is strictly downstream of the intent gate.
 *
 * Harnesses mirror the sibling suites: `MockRunner` + `FunctionStep` for the
 * pure-node topologies (loop/retry/fan-out/node-tool), a real `AgentRunner`
 * driven by a `MockLanguageModelV2` for the tool-dispatch seams (node-tool.test
 * / host-propagation.test / sequential-agents.test patterns).
 */

import type { ToolExecutionContext } from "@agentic-patterns/core";
import { ToolSchema } from "@agentic-patterns/core";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import type {
  AgentEvent,
  BackpackAbsorbEvent,
  BackpackDropEvent,
  BackpackReadEvent,
} from "../../events/types.js";
import { type Gate, GateBlock, GateCategory } from "../../gates/base.js";
import type { ModelResolver } from "../../providers/model-resolver.js";
import { AgentRunner } from "../../runner/agent-runner.js";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import type { ToolExecutor } from "../../runner/types.js";
import {
  type BackpackSpec,
  backpackSlot,
  createBackpack,
  createRunHost,
  hydrateThenDrop,
  readBackpack,
  requireBackpack,
} from "../backpack.js";
import { FanOut } from "../fan-out.js";
import { FunctionStep } from "../function-step.js";
import {
  readBackpack as observedReadBackpack,
  requireBackpack as observedRequireBackpack,
} from "../index.js";
import { Loop } from "../loop.js";
import { nodeTool } from "../node-tool.js";
import { ObservedScratchpad } from "../observed-scratchpad.js";
import { retry } from "../retry.js";
import { sequentialAgent } from "../sequential-agents.js";
import { type ScratchpadReader, type Slot, createScratchpad } from "../slot.js";
import { createStateEmitter } from "../state-events.js";

// ---------------------------------------------------------------------------
// Fixtures — one evidence-pool shape, shared with the unit suite's intent.
// ---------------------------------------------------------------------------

interface Raw {
  readonly id?: string;
  readonly text: string;
  readonly score?: number;
}
interface Entry {
  readonly id: string;
  readonly text: string;
  readonly score: number;
}
interface Final {
  readonly count: number;
  readonly ids: readonly string[];
}
type Tag = { facet: string } | undefined;

/** A FRESH spec per test — the backpackSlot WeakMap is keyed by the spec object. */
function makeSpec(
  over: Partial<BackpackSpec<Raw, Entry, Final, Tag>> = {},
): BackpackSpec<Raw, Entry, Final, Tag> {
  return {
    key: `evidence-${Math.random().toString(36).slice(2)}`,
    expand: (raw) => (raw.id ? { id: raw.id, text: raw.text, score: raw.score ?? 0 } : null),
    identify: (e) => e.id,
    finalize: (entries) => ({ count: entries.length, ids: entries.map((e) => e.id) }),
    ...over,
  };
}

const r = (id: string | undefined, text: string, score = 0): Raw => ({ id, text, score });

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

/** An AgentLike leaf whose model id routes through a {@link ModelResolver}. */
function makeAgent(name: string, model: string, tools: ToolSchema[] = []): AgentLike {
  return {
    role: { name },
    getModel: () => model,
    getTools: () => tools,
    renderInitialPrompt: () => `init:${name}`,
  };
}

/**
 * A model that calls the `gather` tool on the FIRST transcript turn, then emits
 * text once the tool result has landed. Decides by INSPECTING the transcript
 * (not a call counter) so a single instance drives many stages/runs correctly.
 */
function gatherToolModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const toolRan = (prompt as ReadonlyArray<{ role: string }>).some((m) => m.role === "tool");
      if (!toolRan) {
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-gather",
              toolName: "gather",
              input: JSON.stringify({}),
            },
          ],
          finishReason: "tool-calls" as const,
          usage: USAGE,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "gathered" }],
        finishReason: "stop" as const,
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

/** A model that just emits one line of text (a downstream reader/curator stage). */
function textModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: "stop" as const,
      usage: USAGE,
      warnings: [],
    }),
  });
}

const gatherToolSchema = ToolSchema.fromZod("gather", "gather evidence", z.object({}));

// ---------------------------------------------------------------------------
// Retry — idempotency under re-run on the shared pad
// ---------------------------------------------------------------------------

describe("Backpack × Retry", () => {
  it("retry idempotency: a tool drops then throws; Retry re-runs on the shared pad; final size unchanged (dedup by identity)", async () => {
    const spec = makeSpec();
    const pad = createScratchpad();
    const runner = new MockRunner();

    let attempt = 0;
    const body = new FunctionStep<undefined, string>({
      name: "gather-then-flake",
      fn: (_input, scratchpad) => {
        attempt += 1;
        // The drop happens BEFORE the flake — the classic "side effect landed,
        // then the step died" shape retry must be idempotent against.
        scratchpad.get(backpackSlot(spec)).drop([r("a", "a1"), r("b", "b1")], { facet: "gather" });
        if (attempt === 1) throw new Error("flaky after drop");
        return "ok";
      },
    });

    const result = await retry(body, { maxAttempts: 3 }).run(undefined, {
      runner,
      scratchpad: pad,
    });

    expect(result.succeeded).toBe(true);
    expect(result.exitReason).toBe("succeeded");
    expect(attempt).toBe(2); // failed once, re-ran once

    // Both attempts dropped a,b onto the SAME run-scoped pack → deduped by
    // identity, not doubled. Canonical indexes are unchanged by the re-drop.
    const pack = pad.get(backpackSlot(spec));
    expect(pack.size).toBe(2);
    expect(pack.entries().map((e) => e.id)).toEqual(["a", "b"]);
    expect(pack.indexOf("a")).toBe(1);
    expect(pack.indexOf("b")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Loop — accumulation across re-entry without double-counting
// ---------------------------------------------------------------------------

describe("Backpack × Loop", () => {
  it("loop re-entry: Loop({ body }) accumulates across iterations without double-count", async () => {
    const spec = makeSpec();
    const pad = createScratchpad();
    const runner = new MockRunner();

    // Each iteration drops one NEW id plus a SHARED id re-dropped every pass.
    const body = new FunctionStep<number, number>({
      name: "gather-iteration",
      fn: (n, scratchpad) => {
        scratchpad.get(backpackSlot(spec)).drop([r(`item-${n}`, `t${n}`), r("shared", "s")]);
        return n + 1;
      },
    });

    const loop = new Loop<number>({ body, until: (_state, i) => i >= 2, maxIterations: 5 });
    const result = await loop.run(0, { runner, scratchpad: pad });

    expect(result.iterations).toBe(3); // body ran with n = 0, 1, 2

    // Loop threads ONE run-scoped pad across iterations: the three unique ids
    // accumulate, and `shared` (dropped 3×) is folded once by identity.
    const pack = pad.get(backpackSlot(spec));
    expect(pack.size).toBe(4);
    expect(pack.entries().map((e) => e.id)).toEqual(["item-0", "shared", "item-1", "item-2"]);
  });
});

// ---------------------------------------------------------------------------
// Parallel dispatch — synchronous drop is race-free under Promise.all
// ---------------------------------------------------------------------------

describe("Backpack × Promise.all", () => {
  it("parallel dispatch: Promise.all of N sync drops loses nothing (exact expected size + untorn receipts)", async () => {
    const spec = makeSpec();
    const pad = createScratchpad();
    const pack = pad.get(backpackSlot(spec));
    const N = 64;

    const receipts = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() => pack.drop(r(`id-${i}`, `t${i}`))),
      ),
    );

    // Nothing lost, nothing merged — N distinct identities landed.
    expect(pack.size).toBe(N);
    for (const receipt of receipts) {
      expect(receipt.accepted).toBe(1);
      expect(receipt.merged).toBe(0);
      expect(receipt.skipped).toBe(0);
      expect(receipt.indexes).toHaveLength(1); // untorn — one drop, one index
    }
    // The canonical indexes cover 1..N exactly — append-only, no collision.
    const allIndexes = receipts.flatMap((rc) => [...rc.indexes]).sort((a, b) => a - b);
    expect(allIndexes).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});

// ---------------------------------------------------------------------------
// nodeTool — run-scoped pack shared by reference across the agent-as-tool fork
// ---------------------------------------------------------------------------

describe("Backpack × nodeTool (agent-as-tool)", () => {
  it("nodeTool seam: a run-scoped pack dropped-into inside a sub-workflow is visible to the parent (fork shares by reference)", async () => {
    const spec = makeSpec();
    const rootPad = createScratchpad();
    const runner = new MockRunner();

    const worker = new FunctionStep<{ n: number }, number>({
      name: "gather",
      fn: (_input, scratchpad) => {
        const pack = scratchpad.get(backpackSlot(spec));
        pack.drop([r("a", "a"), r("b", "b")], { facet: "child" });
        return pack.size;
      },
    });

    const tool = nodeTool(
      { description: "gather", parameters: z.object({ n: z.number() }), node: worker },
      runner,
    );

    // nodeTool FORKS the inherited pad; a run-scoped slot lazily inits into the
    // SHARED run map, so the child's drops reach the parent by reference.
    const out = await tool.execute({ n: 1 }, { host: { scratchpad: rootPad } });
    expect(out).toBe(2);

    const parentPack = rootPad.get(backpackSlot(spec));
    expect(parentPack.size).toBe(2);
    expect(parentPack.entries().map((e) => e.id)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// FanOut — branch-scoped pack fans in via absorb, in index order
// ---------------------------------------------------------------------------

describe("Backpack × FanOut (branch scope)", () => {
  it("branch scope: FanOut branches drop overlapping ids; join() absorbs in index order; post-join size = union; deterministic across runs", async () => {
    const spec = makeSpec();
    const branchSlot = backpackSlot(spec, { scope: "branch" });

    // Branch i drops an OVERLAPPING pair, so the fan-in must dedup by identity.
    const batches: Record<number, Raw[]> = {
      0: [r("a", "a"), r("b", "b0")],
      1: [r("b", "b1"), r("c", "c1")],
      2: [r("c", "c2"), r("d", "d")],
    };

    const step = new FunctionStep<number, number>({
      name: "branch-gather",
      fn: (i, scratchpad) => {
        const pack = scratchpad.get(branchSlot);
        pack.drop(batches[i]!, { facet: `b${i}` });
        return pack.size; // this branch's INDEPENDENT fork size
      },
    });

    const runOnce = async (): Promise<string[]> => {
      const pad = createScratchpad();
      const fan = new FanOut<number[], number, number>({ over: (items) => items, step });
      const result = await fan.run([0, 1, 2], { runner: new MockRunner(), scratchpad: pad });
      expect(result.succeeded).toBe(true);
      // Each branch saw only its own fork — no cross-branch bleed.
      expect(result.output).toEqual([2, 2, 2]);
      return pad
        .get(branchSlot)
        .entries()
        .map((e) => e.id);
    };

    // Union in index order: absorb branch 0 (a,b) → 1 (b merges, c new) → 2 (c
    // merges, d new). Deterministic regardless of branch completion order.
    const first = await runOnce();
    expect(first).toEqual(["a", "b", "c", "d"]);
    const second = await runOnce();
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// sequentialAgent — the motivating consumer, end to end
// ---------------------------------------------------------------------------

describe("Backpack × sequentialAgent", () => {
  it("e2e: a gather stage's tool requireBackpack(...).drop → a later stage's prompt reads finalized(); NO onEmit; writes:[backpackSlot] passes the write-before-read assert", async () => {
    const spec = makeSpec();
    const gatherSlot = backpackSlot(spec);
    const pad = createScratchpad();

    const resolver: ModelResolver = {
      resolve: async (id) => (id === "reader-model" ? textModel("answered") : gatherToolModel()),
    };
    const runner = new AgentRunner(resolver, new AgentEventBus());

    // The write path: narrow ctx.host exactly as the primitive blesses, then drop.
    const toolExecutor: ToolExecutor = {
      execute: async (_name, _args, ctx?: ToolExecutionContext) => {
        const pack = requireBackpack(ctx, spec);
        // a re-dropped id proves the finalize sees the DEDUPED pool.
        pack.drop([r("a", "alpha"), r("b", "bravo"), r("a", "alpha-again")], { facet: "gather" });
        return { size: pack.size };
      },
    };

    let capturedFinal: Final | undefined;
    const node = sequentialAgent([
      { agent: makeAgent("gather", "gather-model", [gatherToolSchema]), writes: [gatherSlot] },
      {
        agent: makeAgent("reader", "reader-model"),
        reads: [gatherSlot],
        // The later stage's prompt marshals the finalized pool off the shared pad.
        prompt: (state) => {
          capturedFinal = readBackpack(state, spec, "reader").finalized();
          return "answer from the pack";
        },
      },
    ]);

    const res = await node.run("gather the evidence", { runner, scratchpad: pad, toolExecutor });

    expect(res.succeeded).toBe(true);
    expect(res.output.outputs).toEqual({ gather: "gathered", reader: "answered" });
    // The reader's prompt saw the deduped, finalized pool — no onEmit harvest tail.
    expect(capturedFinal).toEqual({ count: 2, ids: ["a", "b"] });
    // and the shared pad carries the same pack post-run.
    expect(pad.get(gatherSlot).size).toBe(2);
  });

  it("build-time: a deliberate read-before-write of the backpack slot FAILS the write-before-read assert", () => {
    const spec = makeSpec();
    const gatherSlot: Slot<unknown> = backpackSlot(spec) as Slot<unknown>;

    // The reader is ordered BEFORE the writer → no earlier stage declares the write.
    expect(() =>
      sequentialAgent([
        { agent: makeAgent("reader", "reader-model"), reads: [gatherSlot] },
        { agent: makeAgent("gather", "gather-model", [gatherToolSchema]), writes: [gatherSlot] },
      ]),
    ).toThrow(/reads '.*'/);
  });

  it("stage-collapse regression: the same drops split across two stages vs collapsed into one yield the same finalized()", async () => {
    // Assembly is coupled to the DATA (the slot), not the control flow — so
    // whether the drops land in two stages or one, finalized() is identical.
    const runPipeline = async (batches: Raw[][]): Promise<Final> => {
      const spec = makeSpec();
      const gatherSlot = backpackSlot(spec);
      const pad = createScratchpad();

      const resolver: ModelResolver = {
        resolve: async (id) => (id === "reader-model" ? textModel("answered") : gatherToolModel()),
      };
      const runner = new AgentRunner(resolver, new AgentEventBus());

      let callIndex = 0;
      const toolExecutor: ToolExecutor = {
        execute: async (_name, _args, ctx?: ToolExecutionContext) => {
          const pack = requireBackpack(ctx, spec);
          pack.drop(batches[callIndex++]!, { facet: `g${callIndex}` });
          return {};
        },
      };

      let capturedFinal: Final | undefined;
      const gatherStages = batches.map((_batch, i) => ({
        agent: makeAgent(`gather-${i}`, "gather-model", [gatherToolSchema]),
        writes: [gatherSlot],
      }));
      const reader = {
        agent: makeAgent("reader", "reader-model"),
        reads: [gatherSlot],
        prompt: (state: ScratchpadReader) => {
          capturedFinal = readBackpack(state, spec, "reader").finalized();
          return "go";
        },
      };

      const res = await sequentialAgent([...gatherStages, reader]).run("go", {
        runner,
        scratchpad: pad,
        toolExecutor,
      });
      if (!res.succeeded) throw res.error;
      return capturedFinal!;
    };

    const twoStages = await runPipeline([
      [r("a", "alpha"), r("b", "bravo")],
      [r("b", "bravo-2"), r("c", "charlie")],
    ]);
    const oneStage = await runPipeline([
      [r("a", "alpha"), r("b", "bravo"), r("b", "bravo-2"), r("c", "charlie")],
    ]);

    expect(twoStages).toEqual({ count: 3, ids: ["a", "b", "c"] });
    expect(oneStage).toEqual(twoStages);
  });
});

// ---------------------------------------------------------------------------
// Bare AgentRunner — createRunHost mints the host from above
// ---------------------------------------------------------------------------

describe("Backpack × bare runner", () => {
  it("bare runner: createRunHost() → runner.run(agent, msg, { host }) → session.open(spec).finalized() returns the drops", async () => {
    const spec = makeSpec();
    const session = createRunHost();
    const runner = new AgentRunner({ resolve: async () => gatherToolModel() }, new AgentEventBus());

    const toolExecutor: ToolExecutor = {
      execute: async (_name, _args, ctx?: ToolExecutionContext) => {
        requireBackpack(ctx, spec).drop([r("a", "a"), r("b", "b"), r("a", "a2")], {
          facet: "gather",
        });
        return {};
      },
    };

    const agent = makeAgent("gather", "gather-model", [gatherToolSchema]);
    const result = await runner.run(agent, "gather it", { toolExecutor, host: session.host });

    expect(result.response).toBe("gathered");
    // The caller reads the pack straight off the host it minted — no stage needed.
    expect(session.open(spec).finalized()).toEqual({ count: 2, ids: ["a", "b"] });
  });
});

// ---------------------------------------------------------------------------
// Gate interaction — the drop is strictly downstream of the intent gate
// ---------------------------------------------------------------------------

describe("Backpack × gate", () => {
  it("gate interaction: a gate blocking the dropping tool ⇒ pack stays empty (write is downstream of intent)", async () => {
    const spec = makeSpec();
    const session = createRunHost();

    const blockGate: Gate = {
      category: GateCategory.SAFETY,
      name: "block-gather",
      categoryName: "SAFETY",
      check: async () => GateBlock("gather blocked in test"),
      getBlockReason: () => "gather blocked in test",
    };
    const bus = new AgentEventBus();
    bus.addGate(blockGate);

    let toolRan = false;
    const toolExecutor: ToolExecutor = {
      execute: async (_name, _args, ctx?: ToolExecutionContext) => {
        toolRan = true;
        requireBackpack(ctx, spec).drop(r("a", "a"));
        return {};
      },
    };

    const runner = new AgentRunner({ resolve: async () => gatherToolModel() }, bus);
    const agent = makeAgent("gather", "gather-model", [gatherToolSchema]);

    // A blocked intent throws before dispatch — the tool never runs.
    await expect(runner.run(agent, "gather", { toolExecutor, host: session.host })).rejects.toThrow(
      /blocked/i,
    );

    expect(toolRan).toBe(false);
    expect(session.open(spec).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hydrateThenDrop — async I/O outside the RMW window, sync drop inside
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// State events (#226) — the OBSERVED accessors across Retry / Loop / FanOut.
// The raw accessors above stay event-free; the barrel serves the observed pair.
// ---------------------------------------------------------------------------

function observedHarness(): {
  pad: ObservedScratchpad;
  events: AgentEvent[];
} {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribeAll((e) => void events.push(e as AgentEvent));
  const pad = new ObservedScratchpad(createStateEmitter(bus, { traceId: "t-1", runId: "r-1" }));
  return { pad, events };
}

const dropsOf = (events: AgentEvent[]): BackpackDropEvent[] =>
  events.filter((e) => e.type === "agent.backpack.drop") as BackpackDropEvent[];
const absorbsOf = (events: AgentEvent[]): BackpackAbsorbEvent[] =>
  events.filter((e) => e.type === "agent.backpack.absorb") as BackpackAbsorbEvent[];
const readsOf = (events: AgentEvent[]): BackpackReadEvent[] =>
  events.filter((e) => e.type === "agent.backpack.read") as BackpackReadEvent[];

describe("Backpack × state events (#226)", () => {
  it("Retry: each attempt's drop emits; the re-drop is visible as pure merges (idempotent pool, honest events)", async () => {
    const spec = makeSpec();
    const { pad, events } = observedHarness();
    const runner = new MockRunner();

    let attempt = 0;
    const body = new FunctionStep<undefined, string>({
      name: "gather-then-flake",
      fn: (_input, scratchpad) => {
        attempt += 1;
        const pack = observedRequireBackpack({ host: { scratchpad } }, spec);
        pack.drop([r("a", "a1"), r("b", "b1")], { facet: "gather" });
        if (attempt === 1) throw new Error("flaky after drop");
        return "ok";
      },
    });

    const result = await retry(body, { maxAttempts: 3 }).run(undefined, {
      runner,
      scratchpad: pad,
    });
    expect(result.succeeded).toBe(true);

    const drops = dropsOf(events);
    expect(drops).toHaveLength(2); // one per attempt — the retry seam is visible
    expect(drops[0]).toMatchObject({
      key: `backpack.${spec.key}`,
      origin: "explicit",
      accepted: 2,
      merged: 0,
      skipped: 0,
      indexes: [1, 2],
      sizeBefore: 0,
      sizeAfter: 2,
      previewsOmitted: 0,
      tag: '{"facet":"gather"}',
      traceId: "t-1",
      runId: "r-1",
    });
    expect(drops[0]!.previews.map((p) => [p.index, p.op])).toEqual([
      [1, "added"],
      [2, "added"],
    ]);
    // The re-drop: same identities, nothing new — dedup shown, not hidden.
    expect(drops[1]).toMatchObject({ accepted: 0, merged: 2, sizeBefore: 2, sizeAfter: 2 });
    expect(drops[1]!.previews.map((p) => [p.index, p.op])).toEqual([
      [1, "merged"],
      [2, "merged"],
    ]);
  });

  it("Loop: one drop event per iteration, single monotonic ordinal stream", async () => {
    const spec = makeSpec();
    const { pad, events } = observedHarness();
    const runner = new MockRunner();

    const body = new FunctionStep<number, number>({
      name: "gather-iteration",
      fn: (n, scratchpad) => {
        observedRequireBackpack({ host: { scratchpad } }, spec).drop([
          r(`item-${n}`, `t${n}`),
          r("shared", "s"),
        ]);
        return n + 1;
      },
    });

    const loop = new Loop<number>({ body, until: (_state, i) => i >= 2, maxIterations: 5 });
    await loop.run(0, { runner, scratchpad: pad });

    const drops = dropsOf(events);
    expect(drops).toHaveLength(3);
    expect(drops.map((d) => d.sizeAfter)).toEqual([2, 3, 4]); // accumulation visible per frame
    const ordinals = drops.map((d) => d.ordinal);
    expect(ordinals[0]! < ordinals[1]! && ordinals[1]! < ordinals[2]!).toBe(true);
  });

  it("FanOut: branch fan-in emits one innate backpack.absorb per branch, in index order — and still merges", async () => {
    const spec = makeSpec();
    const branchSlot = backpackSlot(spec, { scope: "branch" });
    const { pad, events } = observedHarness();

    const batches: Record<number, Raw[]> = {
      0: [r("a", "a"), r("b", "b0")],
      1: [r("b", "b1"), r("c", "c1")],
      2: [r("c", "c2"), r("d", "d")],
    };

    const step = new FunctionStep<number, number>({
      name: "branch-gather",
      fn: (i, scratchpad) => {
        const pack = observedRequireBackpack({ host: { scratchpad } }, spec);
        pack.drop(batches[i]!, { facet: `b${i}` });
        return pack.size;
      },
    });

    const fan = new FanOut<number[], number, number>({ over: (items) => items, step });
    const result = await fan.run([0, 1, 2], { runner: new MockRunner(), scratchpad: pad });
    expect(result.succeeded).toBe(true);
    expect(result.output).toEqual([2, 2, 2]);

    // The union still lands (ObservedScratchpad passes the join instanceof guard).
    expect(
      pad
        .get(branchSlot)
        .entries()
        .map((e) => e.id),
    ).toEqual(["a", "b", "c", "d"]);

    // Per-branch drops (explicit) + per-branch absorbs (innate, index order).
    expect(dropsOf(events)).toHaveLength(3);
    const absorbs = absorbsOf(events);
    expect(absorbs).toHaveLength(3);
    for (const a of absorbs) {
      expect(a.origin).toBe("innate");
      expect(a.key).toBe(`backpack.${spec.key}`);
    }
    expect(absorbs.map((a) => [a.sizeBefore, a.sizeAfter, a.accepted, a.merged])).toEqual([
      [0, 2, 2, 0], // branch 0: a,b — both new
      [2, 3, 1, 1], // branch 1: b merges, c appends
      [3, 4, 1, 1], // branch 2: c merges, d appends
    ]);
    expect(absorbs.map((a) => a.appendedIndexes)).toEqual([[1, 2], [3], [4]]);
    // Each branch forked and joined the shared pad.
    expect(events.filter((e) => e.type === "agent.scratchpad.fork")).toHaveLength(3);
    expect(events.filter((e) => e.type === "agent.scratchpad.join")).toHaveLength(3);
  });

  it("finalized() via the observed accessor emits backpack.read with memo hit/miss across proxies", async () => {
    const spec = makeSpec();
    const { pad, events } = observedHarness();
    const ctx = { host: { scratchpad: pad } };

    const pack = observedRequireBackpack(ctx, spec);
    pack.drop([r("a", "alpha"), r("b", "bravo")]);

    pack.finalized(); // computes
    pack.finalized(); // memo
    observedRequireBackpack(ctx, spec).finalized(); // a DIFFERENT proxy — memo state is per-pack
    pack.drop(r("c", "charlie")); // invalidates
    pack.finalized(); // recomputes

    const reads = readsOf(events);
    expect(reads.map((rd) => rd.memoHit)).toEqual([false, true, true, false]);
    expect(reads.map((rd) => rd.size)).toEqual([2, 2, 2, 3]);
    expect(reads[0]!.preview).toContain('"count":2');
  });

  it("threads toolCallId + spec.display onto backpack events; nests under the causing tool call", async () => {
    const spec = makeSpec({ display: { caption: "Evidence" } });
    const { pad, events } = observedHarness();

    const pack = observedRequireBackpack(
      { host: { scratchpad: pad }, parentToolCallId: "tc-gather" },
      spec,
    );
    pack.drop(r("a", "alpha"));

    const [drop] = dropsOf(events);
    expect(drop).toMatchObject({
      toolCallId: "tc-gather",
      parentSpanId: "tc-gather", // the tool call's span IS the parent span
      display: { caption: "Evidence" },
    });
  });

  it("row previews are byte-capped with the explicit marker; oversized batches report previewsOmitted", async () => {
    const spec = makeSpec();
    const { pad, events } = observedHarness();
    const pack = observedRequireBackpack({ host: { scratchpad: pad } }, spec);

    // 8 rows × ~600B raw text: each row preview clips at 512B and the 2KB frame
    // budget cannot hold all of them.
    pack.drop(Array.from({ length: 8 }, (_, i) => r(`id-${i}`, "x".repeat(600))));

    const [drop] = dropsOf(events);
    expect(drop!.accepted).toBe(8);
    expect(drop!.previews.length).toBeLessThan(8);
    expect(drop!.previewsOmitted).toBe(8 - drop!.previews.length);
    for (const p of drop!.previews) {
      expect(p.preview.endsWith("… (preview only)")).toBe(true);
    }
  });

  it("a plain (unobserved) pad gets the RAW pack back — zero emission, today's behavior exactly", async () => {
    const spec = makeSpec();
    const pad = createScratchpad();

    const pack = observedRequireBackpack({ host: { scratchpad: pad } }, spec);
    // No ObservedScratchpad in the host → no proxy: the identical slot value.
    expect(pack).toBe(pad.get(backpackSlot(spec)));

    // And the raw accessor (backpack.ts) remains what the observed module wraps:
    // the two agree on the same underlying pack.
    expect(requireBackpack({ host: { scratchpad: pad } }, spec)).toBe(pack);
  });

  it("pad-side readBackpack via the observed pad/reader emits backpack.read — the stage-prompt read seam", async () => {
    const spec = makeSpec();
    const key = backpackSlot(spec).key;
    const { pad, events } = observedHarness();

    // Seed rows through the RAW pack: the slot-handle fetch is plumbing and the
    // raw pack's drop is event-free — the read events below stand alone.
    pad.get(backpackSlot(spec)).drop([r("a", "alpha"), r("b", "bravo")]);
    expect(events).toHaveLength(0);

    // The documented read path: a reader minted by the observed pad (what a
    // sequentialAgent stage prompt receives), and the pad itself (post-run
    // readers / eval probes are handed the pad directly).
    expect(observedReadBackpack(pad.reader(), spec, "reader-stage").finalized()).toEqual({
      count: 2,
      ids: ["a", "b"],
    });
    observedReadBackpack(pad, spec, "eval-probe").finalized();

    const reads = readsOf(events);
    expect(reads.map((rd) => [rd.key, rd.memoHit, rd.size])).toEqual([
      [key, false, 2],
      [key, true, 2], // memo state is per-PACK — shared across accessor proxies
    ]);
    expect(reads[0]!.origin).toBe("explicit");
    expect(reads[0]!.toolCallId).toBeUndefined(); // pad-side: no tool dispatch
    // The backpack slot fetches stayed suppressed — no scratchpad.read leaked.
    expect(events.some((e) => e.type === "agent.scratchpad.read")).toBe(false);
  });

  it("readBackpack over a PLAIN pad/reader returns the raw pack — zero emission, today's behavior exactly", async () => {
    const spec = makeSpec();
    const pad = createScratchpad();
    expect(observedReadBackpack(pad.reader(), spec, "probe")).toBe(pad.get(backpackSlot(spec)));
  });
});

describe("Backpack × hydrateThenDrop", () => {
  it("hydrateThenDrop: I/O outside the RMW window; drop itself synchronous; receipt correct", async () => {
    const spec = makeSpec();
    const pack = createBackpack(spec);

    let hydrateCalls = 0;
    const receipt = await hydrateThenDrop(
      pack,
      ["a", "b", "a"], // raw request keys — hydrated by an out-of-band client
      async (keys) => {
        hydrateCalls += 1;
        return keys.map((k) => r(k, `text-${k}`));
      },
      { facet: "hydrated" },
    );

    expect(hydrateCalls).toBe(1); // the await happened once, before the drop
    expect(receipt.accepted).toBe(2); // a, b
    expect(receipt.merged).toBe(1); // the second a
    expect(receipt.skipped).toBe(0);
    expect(receipt.indexes).toEqual([1, 2, 1]); // raw order, merged a keeps #1
    expect(pack.size).toBe(2);
    expect(pack.finalized()).toEqual({ count: 2, ids: ["a", "b"] });
  });
});
