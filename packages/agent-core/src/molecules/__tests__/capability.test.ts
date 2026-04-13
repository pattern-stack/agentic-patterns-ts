import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Capability } from "../capability.js";
import { TextManual } from "../manual.js";
import { type ToolDefinition, Toolbox } from "../toolbox.js";

class TestToolbox extends Toolbox {
  readonly name = "Test";
  readonly description = "Test toolbox";
  readonly tools: Record<string, ToolDefinition> = {
    doThing: {
      description: "Does a thing",
      parameters: z.object({ input: z.string() }),
      execute: async (args) => `done: ${(args as { input: string }).input}`,
    },
  };
}

describe("Capability", () => {
  const toolbox = new TestToolbox();
  const manual = new TextManual("Guide", "Follow these steps.");

  it("is frozen after construction", () => {
    const cap = new Capability("Test Cap", "A test", toolbox, manual);
    expect(() => {
      (cap as unknown as Record<string, unknown>).name = "changed";
    }).toThrow();
  });

  describe("getTools", () => {
    it("returns schemas from toolbox", () => {
      const cap = new Capability("Test Cap", "A test", toolbox);
      const tools = cap.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("doThing");
    });
  });

  describe("getGuidance", () => {
    it("returns manual content when manual present", () => {
      const cap = new Capability("Test Cap", "A test", toolbox, manual);
      expect(cap.getGuidance()).toContain("Follow these steps");
    });

    it("returns empty string when no manual", () => {
      const cap = new Capability("Test Cap", "A test", toolbox);
      expect(cap.getGuidance()).toBe("");
    });
  });

  describe("toPrompt", () => {
    it("renders capability with tools and guidance", () => {
      const cap = new Capability("Test Cap", "A test", toolbox, manual);
      const output = cap.toPrompt();

      expect(output).toContain("### Test Cap");
      expect(output).toContain("A test");
      expect(output).toContain("Follow these steps");
      expect(output).toContain("**Tools:**");
      expect(output).toContain("- **doThing**: Does a thing");
    });

    it("renders without guidance when no manual", () => {
      const cap = new Capability("Test Cap", "A test", toolbox);
      const output = cap.toPrompt();

      expect(output).toContain("### Test Cap");
      expect(output).toContain("**Tools:**");
      expect(output).not.toContain("Follow these steps");
    });
  });
});
