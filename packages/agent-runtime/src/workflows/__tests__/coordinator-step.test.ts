import { Agent, Mission, Persona, RoleBuilder } from "@agentic-patterns/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { createToolboxExecutor } from "../../runner/toolbox-executor.js";
import { CoordinatorStep, withTeamCapability } from "../coordinator-step.js";
import { delegateTo } from "../node-tool.js";

// --- helpers ---------------------------------------------------------------

/** A minimal leaf subagent (the runner duck-type; no real Role needed). */
function subagent(name: string): AgentLike {
  return {
    role: { name },
    getModel: () => "mock",
    getTools: () => [],
    renderInitialPrompt: () => `you are ${name}`,
  };
}

/** A real core coordinator Agent (needs a Role so the team can be attached). */
function coordinatorAgent(): Agent {
  const role = new RoleBuilder("CanvasAuthor")
    .withPersona(
      new Persona({
        identity: "a canvas author who routes work to the right specialist",
        tone: "direct",
        priorities: ["route correctly"],
        principles: ["delegate, never do the work directly"],
      }),
    )
    .withDefaultModel("mock")
    .build();
  return new Agent({
    role,
    mission: new Mission({
      objective: "author a canvas template",
      successCriteria: ["valid template"],
      constraints: [],
    }),
  });
}

const Template = z.object({ title: z.string(), sections: z.array(z.string()) });

describe("withTeamCapability", () => {
  it("advertises the team's tools AND keeps them executable, preserving prior capabilities", async () => {
    const runner = new MockRunner().addResponse("*", { content: "drafted" });
    const team = delegateTo(runner, [
      { agent: subagent("writer"), description: "drafts a section" },
      { agent: subagent("planner"), description: "plans sections" },
    ]);

    const wired = withTeamCapability(coordinatorAgent(), team);

    // ADVERTISE channel: the model sees the team's tools via getTools().
    const toolNames = wired.getTools().map((t) => t.name);
    expect(toolNames.sort()).toEqual(["planner", "writer"]);

    // EXECUTE channel: the derived executor dispatches a team tool to its subagent.
    const exec = createToolboxExecutor(wired);
    const out = await exec.execute("writer", { task: "write the intro" });
    expect(out).toBe("drafted");
  });

  it("does not mutate the original agent", () => {
    const runner = new MockRunner();
    const original = coordinatorAgent();
    const before = original.getTools().length;
    withTeamCapability(
      original,
      delegateTo(runner, [{ agent: subagent("writer"), description: "x" }]),
    );
    expect(original.getTools().length).toBe(before);
  });
});

describe("CoordinatorStep", () => {
  it("returns the typed structured output as a NodeResult (call-and-return)", async () => {
    const template = { title: "Onboarding", sections: ["intro", "setup"] };
    const runner = new MockRunner().addResponse("*", { content: "{}", object: template });
    const team = delegateTo(runner, [
      { agent: subagent("writer"), description: "drafts a section" },
    ]);

    const author = new CoordinatorStep<{ instruction: string }, z.infer<typeof Template>>({
      name: "CanvasAuthor",
      agent: coordinatorAgent(),
      team,
      output: Template,
      prompt: (input) => input.instruction,
    });

    const result = await author.run({ instruction: "build the onboarding canvas" }, { runner });

    expect(result.succeeded).toBe(true);
    expect(result.output).toEqual(template);
    expect(result.error).toBeUndefined();
  });

  it("is a Node — surfaces a leaf failure as succeeded:false, never throws", async () => {
    // No `object` configured → MockRunner.runStructured throws; the leaf must catch it.
    const runner = new MockRunner().addResponse("*", { content: "no object here" });
    const team = delegateTo(runner, [{ agent: subagent("writer"), description: "drafts" }]);

    const author = new CoordinatorStep<{ instruction: string }, z.infer<typeof Template>>({
      agent: coordinatorAgent(),
      team,
      output: Template,
      prompt: (input) => input.instruction,
    });

    const result = await author.run({ instruction: "go" }, { runner });
    expect(result.succeeded).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });
});
