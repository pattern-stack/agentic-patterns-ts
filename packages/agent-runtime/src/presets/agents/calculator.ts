/**
 * Calculator agent preset — a fully-built agent that performs arithmetic
 * and algebraic calculations using dedicated tools.
 *
 * NO MODEL (#179/#222): pins no model. It runs on whatever model the runner
 * resolves (tier / `AGENT_MODEL` / gateway / profiles) — e.g. `createRunner({
 * tier })` in `agent-server/examples/live-demo.ts`. Pin one explicitly with
 * `buildCalculatorAgent().withModel(id)` if you need a specific model.
 */

import {
  AgentBuilder,
  Capability,
  Judgment,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
  type ToolDefinition,
  Toolbox,
  defineTool,
} from "@agentic-patterns/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Toolbox
// ---------------------------------------------------------------------------

/** Every operation resolves to a single number under `result`. */
const NumericResult = z.object({ result: z.number() });

// `CalculatorToolbox` stays a class: it is exported from the package barrel, so
// collapsing it into a `toolbox()` literal would be a breaking API change. The
// tools inside it use `defineTool` — typed args, no hand-casts, and `returns`
// validated on the way out.
export class CalculatorToolbox extends Toolbox {
  readonly name = "calculator_operations";
  readonly description = "Arithmetic and algebraic calculator operations";

  readonly tools: Record<string, ToolDefinition> = {
    add: defineTool({
      description: "Add two numbers together",
      parameters: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      returns: NumericResult,
      execute: async ({ a, b }) => ({ result: a + b }),
    }),
    subtract: defineTool({
      description: "Subtract the second number from the first",
      parameters: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      returns: NumericResult,
      execute: async ({ a, b }) => ({ result: a - b }),
    }),
    multiply: defineTool({
      description: "Multiply two numbers together",
      parameters: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      returns: NumericResult,
      execute: async ({ a, b }) => ({ result: a * b }),
    }),
    divide: defineTool({
      description: "Divide the first number by the second",
      parameters: z.object({
        a: z.number().describe("Dividend"),
        b: z.number().describe("Divisor"),
      }),
      returns: NumericResult,
      execute: async ({ a, b }) => {
        if (b === 0) {
          throw new Error("Division by zero is undefined");
        }
        return { result: a / b };
      },
    }),
    power: defineTool({
      description: "Raise a base to an exponent",
      parameters: z.object({
        base: z.number().describe("Base number"),
        exponent: z.number().describe("Exponent"),
      }),
      returns: NumericResult,
      execute: async ({ base, exponent }) => ({ result: base ** exponent }),
    }),
    sqrt: defineTool({
      description: "Compute the square root of a number",
      parameters: z.object({
        n: z.number().describe("Number to take the square root of"),
      }),
      returns: NumericResult,
      execute: async ({ n }) => {
        if (n < 0) {
          throw new Error("Square root of a negative number is undefined");
        }
        return { result: Math.sqrt(n) };
      },
    }),
    percentage: defineTool({
      description: "Calculate what percent% of value is",
      parameters: z.object({
        value: z.number().describe("The base value"),
        percent: z.number().describe("The percentage to compute"),
      }),
      returns: NumericResult,
      execute: async ({ value, percent }) => ({ result: (value * percent) / 100 }),
    }),
    modulo: defineTool({
      description: "Compute the remainder of dividing a by b",
      parameters: z.object({
        a: z.number().describe("Dividend"),
        b: z.number().describe("Divisor"),
      }),
      returns: NumericResult,
      execute: async ({ a, b }) => ({ result: a % b }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Agent builder
// ---------------------------------------------------------------------------

export function buildCalculatorAgent() {
  const toolbox = new CalculatorToolbox();

  const role = new RoleBuilder("calculator-assistant")
    .withPersona(
      new Persona({
        identity: "A precise calculator that shows its work step by step",
        tone: "concise and mathematical",
        priorities: ["accuracy", "showing work"],
        principles: ["Always use the provided calculator tools — never do mental math"],
      }),
    )
    .withJudgment(
      new Judgment({
        domain: "arithmetic and algebra",
        heuristics: [
          "Use the provided tools for every calculation",
          "Break compound expressions into sequential tool calls",
        ],
        constraints: ["Only answer math and numerical reasoning questions"],
      }),
    )
    .withCapability(
      new Capability("calculator_operations", "Arithmetic and algebraic calculations", toolbox),
    )
    .withResponsibility(
      new Responsibility({
        key: "calculate",
        name: "Perform Calculations",
        description: "Perform calculations accurately using tools",
      }),
    )
    .build();

  const mission = new Mission({
    objective: "Help users with math calculations, compound operations, and numerical reasoning",
    successCriteria: [
      "Correct answers verified by tool use",
      "Work shown step by step",
      "Tools used for every calculation",
    ],
  });

  return new AgentBuilder(role).withMission(mission).build();
}
