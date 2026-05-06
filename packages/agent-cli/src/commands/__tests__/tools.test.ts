/**
 * Tests for `ap tools list` / `ap tools call`.
 *
 * The agent under test is built from real `@agentic-patterns/core`
 * builders (Persona, Mission, RoleBuilder, AgentBuilder, Capability,
 * Toolbox) so the capability-walk path is exercised end-to-end. The
 * toolbox itself is a minimal `EchoToolbox` with one trivial tool —
 * the test goal is to prove the dispatch path, not arithmetic.
 */

import {
  AgentBuilder,
  Capability,
  Mission,
  Persona,
  RoleBuilder,
  type ToolDefinition,
  Toolbox,
} from "@agentic-patterns/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DiscoveredAgent } from "../../helpers/discover.js";
import { runToolsCommand } from "../tools.js";

// ---------------------------------------------------------------------------
// Fixture: a real Agent backed by a tiny Echo toolbox
// ---------------------------------------------------------------------------

class EchoToolbox extends Toolbox {
  readonly name = "echo_tools";
  readonly description = "Echoes its input back.";

  readonly tools: Record<string, ToolDefinition> = {
    echo: {
      description: "Return the message unchanged",
      parameters: z.object({
        message: z.string().describe("Text to echo back"),
      }),
      execute: async (args) => {
        const { message } = args as { message: string };
        return { message };
      },
    },
    countdown: {
      description: "Echo back the count",
      parameters: z.object({
        count: z.number().describe("How high to count"),
        loud: z.boolean().optional().describe("Uppercase the result"),
        labels: z.array(z.string()).optional().describe("Optional labels"),
      }),
      execute: async (args) => {
        const { count, loud, labels } = args as {
          count: number;
          loud?: boolean;
          labels?: string[];
        };
        return { count, loud: loud ?? false, labels: labels ?? [] };
      },
    },
  };
}

function buildEchoAgent(): DiscoveredAgent {
  const toolbox = new EchoToolbox();
  const role = new RoleBuilder("echo-bot")
    .withPersona(
      new Persona({
        identity: "A trivial echo bot",
        tone: "neutral",
        priorities: ["accuracy"],
        principles: ["echo verbatim"],
      }),
    )
    .withCapability(new Capability("echo_capability", "Echo capability", toolbox))
    .build();
  const agent = new AgentBuilder(role)
    .withMission(
      new Mission({
        objective: "Echo input verbatim",
        success_criteria: ["round-trip"],
      }),
    )
    .build();

  return {
    id: "echo",
    name: "Echo Bot",
    description: "Trivial echo agent for tests",
    agent,
    file: "/virtual/echo.ts",
  };
}

// ---------------------------------------------------------------------------
// Stdio + exit harness
// ---------------------------------------------------------------------------

interface StdHarness {
  stdout: string[];
  stderr: string[];
  exits: number[];
  restore: () => void;
}

function captureStdio(): StdHarness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];

  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(((code?: number): never => {
      exits.push(code ?? 0);
      throw new Error(`__exit__:${code ?? 0}`);
    }) as never);

  return {
    stdout,
    stderr,
    exits,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    },
  };
}

// Helper: run, swallow the synthetic exit Error so test code keeps flowing.
async function runSafely(promise: Promise<void>): Promise<void> {
  try {
    await promise;
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("__exit__:")) throw e;
  }
}

// Strip ANSI from captured output.
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function joined(chunks: string[]): string {
  return stripAnsi(chunks.join(""));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ap tools", () => {
  let h: StdHarness;
  let agents: DiscoveredAgent[];

  beforeEach(() => {
    h = captureStdio();
    agents = [buildEchoAgent()];
  });

  afterEach(() => {
    h.restore();
  });

  describe("list", () => {
    it("enumerates tools across capabilities with name + description", async () => {
      await runSafely(
        runToolsCommand({
          agents,
          subcommand: "list",
          positionals: ["echo"],
          argv: ["tools", "list", "echo"],
        }),
      );

      const out = joined(h.stdout);
      expect(out).toContain("echo");
      expect(out).toContain("countdown");
      expect(out).toContain("Return the message unchanged");
      expect(out).toContain("echo_capability");
      expect(h.exits).toEqual([]);
    });

    it("exits non-zero with available list when agent unknown", async () => {
      await runSafely(
        runToolsCommand({
          agents,
          subcommand: "list",
          positionals: ["does-not-exist"],
          argv: ["tools", "list", "does-not-exist"],
        }),
      );

      expect(h.exits[0]).toBe(1);
      const err = joined(h.stderr);
      expect(err).toContain("does-not-exist");
      expect(err).toContain("available:");
      expect(err).toContain("echo");
    });
  });

  describe("call", () => {
    it("parses --message=hello, dispatches, prints JSON result", async () => {
      await runSafely(
        runToolsCommand({
          agents,
          subcommand: "call",
          positionals: ["echo", "echo"],
          argv: ["tools", "call", "echo", "echo", "--message=hello"],
        }),
      );

      const out = joined(h.stdout);
      expect(out).toContain('"message": "hello"');
      expect(h.exits).toEqual([]);
    });

    it("coerces number, boolean, and array-of-string flags from the Zod shape", async () => {
      await runSafely(
        runToolsCommand({
          agents,
          subcommand: "call",
          positionals: ["echo", "countdown"],
          argv: [
            "tools",
            "call",
            "echo",
            "countdown",
            "--count=3",
            "--loud",
            "--labels=a,b",
            "--labels=c",
          ],
        }),
      );

      const out = joined(h.stdout);
      const parsed = JSON.parse(out.trim()) as {
        count: number;
        loud: boolean;
        labels: string[];
      };
      expect(parsed.count).toBe(3);
      expect(parsed.loud).toBe(true);
      expect(parsed.labels).toEqual(["a", "b", "c"]);
      expect(h.exits).toEqual([]);
    });

    it("exits non-zero with available list when tool unknown", async () => {
      await runSafely(
        runToolsCommand({
          agents,
          subcommand: "call",
          positionals: ["echo", "nope"],
          argv: ["tools", "call", "echo", "nope"],
        }),
      );

      expect(h.exits[0]).toBe(1);
      const err = joined(h.stderr);
      expect(err).toContain("nope");
      expect(err).toContain("available:");
      expect(err).toContain("echo");
    });

    it("propagates Zod validation errors to stderr and exits non-zero", async () => {
      await runSafely(
        runToolsCommand({
          agents,
          subcommand: "call",
          positionals: ["echo", "echo"],
          // No --message= provided → Zod will reject "Required".
          argv: ["tools", "call", "echo", "echo"],
        }),
      );

      expect(h.exits[0]).toBe(1);
      const err = joined(h.stderr);
      expect(err.toLowerCase()).toContain("error");
      // Zod's invalid_type / Required messaging — surface either form.
      expect(err.length).toBeGreaterThan(0);
    });
  });
});
