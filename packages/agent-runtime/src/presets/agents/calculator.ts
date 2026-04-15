/**
 * Calculator agent preset — a fully-built agent that performs arithmetic
 * and algebraic calculations using dedicated tools.
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
} from "@agentic-patterns/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Toolbox
// ---------------------------------------------------------------------------

export class CalculatorToolbox extends Toolbox {
  readonly name = "calculator_operations";
  readonly description = "Arithmetic and algebraic calculator operations";

  readonly tools: Record<string, ToolDefinition> = {
    add: {
      description: "Add two numbers together",
      parameters: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      execute: async (args) => {
        const { a, b } = args as { a: number; b: number };
        return { result: a + b };
      },
    },
    subtract: {
      description: "Subtract the second number from the first",
      parameters: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      execute: async (args) => {
        const { a, b } = args as { a: number; b: number };
        return { result: a - b };
      },
    },
    multiply: {
      description: "Multiply two numbers together",
      parameters: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      execute: async (args) => {
        const { a, b } = args as { a: number; b: number };
        return { result: a * b };
      },
    },
    divide: {
      description: "Divide the first number by the second",
      parameters: z.object({
        a: z.number().describe("Dividend"),
        b: z.number().describe("Divisor"),
      }),
      execute: async (args) => {
        const { a, b } = args as { a: number; b: number };
        if (b === 0) {
          throw new Error("Division by zero is undefined");
        }
        return { result: a / b };
      },
    },
    power: {
      description: "Raise a base to an exponent",
      parameters: z.object({
        base: z.number().describe("Base number"),
        exponent: z.number().describe("Exponent"),
      }),
      execute: async (args) => {
        const { base, exponent } = args as { base: number; exponent: number };
        return { result: base ** exponent };
      },
    },
    sqrt: {
      description: "Compute the square root of a number",
      parameters: z.object({
        n: z.number().describe("Number to take the square root of"),
      }),
      execute: async (args) => {
        const { n } = args as { n: number };
        if (n < 0) {
          throw new Error("Square root of a negative number is undefined");
        }
        return { result: Math.sqrt(n) };
      },
    },
    percentage: {
      description: "Calculate what percent% of value is",
      parameters: z.object({
        value: z.number().describe("The base value"),
        percent: z.number().describe("The percentage to compute"),
      }),
      execute: async (args) => {
        const { value, percent } = args as { value: number; percent: number };
        return { result: (value * percent) / 100 };
      },
    },
    modulo: {
      description: "Compute the remainder of dividing a by b",
      parameters: z.object({
        a: z.number().describe("Dividend"),
        b: z.number().describe("Divisor"),
      }),
      execute: async (args) => {
        const { a, b } = args as { a: number; b: number };
        return { result: a % b };
      },
    },
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
    .withDefaultModel("sonnet")
    .build();

  const mission = new Mission({
    objective: "Help users with math calculations, compound operations, and numerical reasoning",
    success_criteria: [
      "Correct answers verified by tool use",
      "Work shown step by step",
      "Tools used for every calculation",
    ],
  });

  return new AgentBuilder(role).withMission(mission).build();
}
