import { Agent, Mission, Persona, RoleBuilder } from "@pattern-stack/agentic-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { Accumulate } from "../accumulate.js";
import { AgentStep } from "../agent-step.js";
import { NodeBackedRunner, asAgent } from "../as-agent.js";
import { CoordinatorStep } from "../coordinator-step.js";
import { MissingDependencyError, depKey, provideDeps } from "../deps.js";
import { FanOut } from "../fan-out.js";
import { FunctionStep } from "../function-step.js";
import { Loop } from "../loop.js";
import { delegateTo, nodeTool } from "../node-tool.js";
import type { NodeRunContext } from "../node.js";
import { Parallel } from "../parallel.js";
import { Sequential } from "../sequential.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ApiClient {
  readonly id: string;
}

const apiClientKey = depKey<ApiClient>("apiClient");

function makeAgent(name = "test-agent"): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    renderInitialPrompt: () => "Initial prompt",
  };
}

function coordinatorAgent(): Agent {
  const role = new RoleBuilder("Coordinator")
    .withPersona(
      new Persona({
        identity: "a coordinator that routes work",
        tone: "direct",
        priorities: ["route correctly"],
        principles: ["delegate"],
      }),
    )
    .withDefaultModel("mock")
    .build();
  return new Agent({
    role,
    mission: new Mission({
      objective: "coordinate",
      successCriteria: ["done"],
      constraints: [],
    }),
  });
}

// ---------------------------------------------------------------------------
// 1. Registry semantics
// ---------------------------------------------------------------------------

describe("provideDeps / DepRegistry", () => {
  it("binds and reads a value by key", () => {
    const client: ApiClient = { id: "c1" };
    const registry = provideDeps().set(apiClientKey, client).build();
    expect(registry.get(apiClientKey)).toBe(client);
  });

  it("getOptional returns undefined for a missing key", () => {
    const registry = provideDeps().build();
    const missing = depKey<string>("missing");
    expect(registry.getOptional(missing)).toBeUndefined();
  });

  it("get throws MissingDependencyError naming the key when unbound", () => {
    const registry = provideDeps().build();
    const missing = depKey<string>("missing-thing");
    expect(() => registry.get(missing)).toThrow(MissingDependencyError);
    expect(() => registry.get(missing)).toThrow(/missing-thing/);
  });

  it("has() reports binding presence", () => {
    const key = depKey<number>("count");
    const registry = provideDeps().set(key, 42).build();
    expect(registry.has(key)).toBe(true);
    expect(registry.has(depKey<number>("count"))).toBe(false); // distinct key instance
  });

  it("two keys with the same name do not collide", () => {
    const keyA = depKey<string>("dup");
    const keyB = depKey<string>("dup");
    const registry = provideDeps().set(keyA, "a").set(keyB, "b").build();
    expect(registry.get(keyA)).toBe("a");
    expect(registry.get(keyB)).toBe("b");
  });

  it("the built registry is frozen", () => {
    const registry = provideDeps().build();
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it("accepts an array-literal form", () => {
    const key = depKey<number>("n");
    const registry = provideDeps([[key, 7]]).build();
    expect(registry.get(key)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 2. Leaf reads a root-injected dep without closures
// ---------------------------------------------------------------------------

describe("leaf dep reads (no closures)", () => {
  it("a FunctionStep reads a root-injected dep via ctx.deps", async () => {
    const client: ApiClient = { id: "c1" };
    const deps = provideDeps().set(apiClientKey, client).build();
    const step = new FunctionStep<void, ApiClient>({
      name: "read-dep",
      fn: (_input, _scratchpad, ctx) => ctx.deps!.get(apiClientKey),
    });

    const result = await step.run(undefined, { runner: new MockRunner(), deps });
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe(client);
  });

  it("a leaf using getOptional sees undefined and does not throw when deps is absent", async () => {
    const step = new FunctionStep<void, ApiClient | undefined>({
      name: "read-optional",
      fn: (_input, _scratchpad, ctx) => ctx.deps?.getOptional(apiClientKey),
    });

    const result = await step.run(undefined, { runner: new MockRunner() });
    expect(result.succeeded).toBe(true);
    expect(result.output).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Propagation through every combinator (core acceptance)
// ---------------------------------------------------------------------------

describe("deps propagation through combinators", () => {
  const client: ApiClient = { id: "shared" };

  function probe(name: string) {
    return new FunctionStep<void, ApiClient>({
      name,
      fn: (_input, _scratchpad, ctx) => ctx.deps!.get(apiClientKey),
    });
  }

  it("Sequential", async () => {
    const seq = Sequential.start(
      new FunctionStep<void, void>({ name: "noop", fn: () => undefined }),
    )
      .then(probe("read"))
      .build();
    const deps = provideDeps().set(apiClientKey, client).build();
    const result = await seq.run(undefined, { runner: new MockRunner(), deps });
    expect(result.output).toBe(client);
  });

  it("Loop", async () => {
    const loop = new Loop<ApiClient | undefined>({
      name: "one-shot",
      body: new FunctionStep<ApiClient | undefined, ApiClient | undefined>({
        name: "read",
        fn: (_input, _scratchpad, ctx) => ctx.deps!.get(apiClientKey),
      }),
      until: () => true,
      maxIterations: 1,
    });
    const deps = provideDeps().set(apiClientKey, client).build();
    const result = await loop.run(undefined, { runner: new MockRunner(), deps });
    expect(result.output).toBe(client);
  });

  it("Accumulate", async () => {
    const acc = new Accumulate<void, void, ApiClient | undefined>({
      name: "read",
      over: () => [undefined],
      initial: () => undefined,
      step: new FunctionStep({
        name: "read-in-step",
        fn: (_input, _scratchpad, ctx) => ctx.deps!.get(apiClientKey),
      }),
    });
    const deps = provideDeps().set(apiClientKey, client).build();
    const result = await acc.run(undefined, { runner: new MockRunner(), deps });
    expect(result.output).toBe(client);
  });

  it("Parallel (in a branch)", async () => {
    const par = new Parallel<void, ApiClient>([{ name: "branch", node: probe("read") }]);
    const deps = provideDeps().set(apiClientKey, client).build();
    const result = await par.run(undefined, { runner: new MockRunner(), deps });
    expect(result.output).toEqual([client]);
  });

  it("FanOut (in a branch)", async () => {
    const fan = new FanOut<{ items: number[] }, number, ApiClient>({
      name: "read",
      over: (input) => input.items,
      step: new FunctionStep<number, ApiClient>({
        name: "read-item",
        fn: (_input, _scratchpad, ctx) => ctx.deps!.get(apiClientKey),
      }),
    });
    const deps = provideDeps().set(apiClientKey, client).build();
    const result = await fan.run({ items: [1] }, { runner: new MockRunner(), deps });
    expect(result.output).toEqual([client]);
  });

  it("CoordinatorStep — deps reach the ctx passed to the internal AgentStep leaf", async () => {
    const runner = new MockRunner().addResponse("*", { content: "routed", object: { ok: true } });
    const deps = provideDeps().set(apiClientKey, client).build();

    let capturedCtx: NodeRunContext | undefined;
    const originalRun = AgentStep.prototype.run;
    const spy = vi.spyOn(AgentStep.prototype, "run").mockImplementation(function (
      this: AgentStep<unknown, unknown>,
      input,
      ctx,
    ) {
      capturedCtx = ctx;
      return originalRun.call(this, input, ctx);
    });

    try {
      const team = delegateTo(runner, [
        { agent: makeAgent("writer"), description: "writes things" },
      ]);
      const coordinator = new CoordinatorStep({
        agent: coordinatorAgent(),
        team,
        output: z.object({ ok: z.boolean() }),
        prompt: () => "go",
      });

      await coordinator.run(undefined, { runner, deps });
      expect(capturedCtx?.deps).toBe(deps);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. asAgent exposure — deps bound at promotion time
// ---------------------------------------------------------------------------

describe("asAgent + NodeBackedRunner deps exposure", () => {
  it("a dep bound at promotion time is readable by a nested leaf", async () => {
    const client: ApiClient = { id: "promoted" };
    const deps = provideDeps().set(apiClientKey, client).build();

    const pipeline = new FunctionStep<string, ApiClient>({
      name: "read",
      fn: (_input, _scratchpad, ctx) => ctx.deps!.get(apiClientKey),
    });

    const promoted = asAgent(pipeline, { role: { name: "Promoted" }, deps });
    const inner = new MockRunner();
    const runner = new NodeBackedRunner(inner);
    const result = await runner.run(promoted, "hello");

    expect(result.response).toBe(JSON.stringify(client, null, 2));
  });
});

// ---------------------------------------------------------------------------
// 5. nodeTool explicit injection
// ---------------------------------------------------------------------------

describe("nodeTool explicit deps injection", () => {
  it("the wrapped node's leaf reads the dep when the tool executes", async () => {
    const client: ApiClient = { id: "tool" };
    const deps = provideDeps().set(apiClientKey, client).build();
    const runner = new MockRunner();

    const tool = nodeTool(
      {
        description: "reads a dep",
        parameters: z.object({}),
        node: new FunctionStep<Record<string, never>, ApiClient>({
          name: "read",
          fn: (_input, _scratchpad, ctx) => ctx.deps!.get(apiClientKey),
        }),
      },
      runner,
      undefined,
      deps,
    );

    const out = await tool.execute({});
    expect(out).toBe(client);
  });
});

// ---------------------------------------------------------------------------
// 6. Additive / no-regression
// ---------------------------------------------------------------------------

describe("additive — no deps still works", () => {
  it("node.run(input, { runner }) with no deps still succeeds", async () => {
    const seq = Sequential.start(
      new FunctionStep<number, number>({ name: "inc", fn: (n) => n + 1 }),
    ).build();
    const result = await seq.run(1, { runner: new MockRunner() });
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe(2);
  });

  it("a leaf using ctx.deps?.getOptional(k) sees undefined and does not throw", async () => {
    const step = new FunctionStep<void, ApiClient | undefined>({
      name: "read-optional",
      fn: (_input, _scratchpad, ctx) => ctx.deps?.getOptional(apiClientKey),
    });
    const result = await step.run(undefined, { runner: new MockRunner() });
    expect(result.succeeded).toBe(true);
    expect(result.output).toBeUndefined();
  });
});
