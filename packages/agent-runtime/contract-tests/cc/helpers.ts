/**
 * Shared helpers for the Claude Code enforcement contract tests (B-2 / #326).
 *
 * Every run drives the real Claude Agent SDK subprocess against THIS machine's
 * host `~/.claude` (Max login), model `haiku`, in a throwaway temp workspace so
 * a permitted side effect (a created file / run command) is observable and never
 * touches the repo.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentBuilder,
  Capability,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
  type ToolDefinition,
  Toolbox,
} from "@pattern-stack/agentic-core";
import { z } from "zod";

import { AgentEventBus } from "../../src/events/agent-event-bus.js";
import type { AgentEvent } from "../../src/events/types.js";
import type { BaseEvent } from "../../src/events/types.js";
import { GateCategory } from "../../src/gates/base.js";
import type { Gate, GateResult } from "../../src/gates/base.js";
import { ClaudeCodeRunner } from "../../src/runner/claude-code-runner.js";
import type { OperationClass } from "../../src/runner/harness/types.js";

export function assertPreconditions(): void {
  try {
    execSync("claude --version", { stdio: "ignore" });
  } catch {
    throw new Error(
      "claude binary not found on PATH — the CC contract suite requires the Claude Code CLI + a logged-in Max subscription (or ANTHROPIC_API_KEY)",
    );
  }
}

let root: string | undefined;
export function workspace(name: string): string {
  if (!root) root = mkdtempSync(join(tmpdir(), "cc-contract-"));
  const dir = join(root, `${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
export function cleanup(): void {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
}
export const fileExists = (p: string): boolean => existsSync(p);

/** A gate that denies any tool-intent whose name matches `pred`. */
export class DenyToolGate implements Gate {
  readonly category = GateCategory.SAFETY;
  readonly categoryName = "SAFETY";
  constructor(
    readonly name: string,
    private readonly pred: (toolName: string) => boolean,
  ) {}
  async check(event: BaseEvent): Promise<GateResult> {
    const toolName = (event as { toolName?: string }).toolName ?? "";
    if (this.pred(toolName)) {
      return { action: "block", reason: `denied by ${this.name}` };
    }
    return { action: "allow" };
  }
  getBlockReason(): string {
    return `denied by ${this.name}`;
  }
}

/** A math capability so MCP-tool enforcement is exercisable. */
class MathToolbox extends Toolbox {
  readonly name = "math_operations";
  readonly description = "Basic math operations";
  readonly tools: Record<string, ToolDefinition> = {
    add: {
      description: "Add two numbers",
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async (args) => {
        const { a, b } = args as { a: number; b: number };
        return { result: a + b };
      },
    },
  };
}

export function buildAgent(withMath = false) {
  const persona = new Persona({
    identity: "A terse operator that does exactly what it is told and then stops",
    tone: "minimal",
    priorities: ["do the one requested action"],
    principles: ["never retry a declined action", "never try an alternative tool"],
  });
  const responsibility = new Responsibility({
    key: "act",
    name: "Perform the requested action",
    description: "Carry out exactly one requested action and stop.",
  });
  let role = new RoleBuilder("cc-contract-agent")
    .withPersona(persona)
    .withResponsibility(responsibility)
    .withDefaultModel("haiku");
  if (withMath) {
    role = role.withCapability(new Capability("math_operations", "Basic math", new MathToolbox()));
  }
  const mission = new Mission({
    objective: "Carry out the single requested action, then stop.",
    successCriteria: ["the one action is attempted"],
  });
  return new AgentBuilder(role.build()).withMission(mission).build();
}

export interface RunObservation {
  intents: string[];
  rejected: string[];
  started: string[];
  ended: string[];
  response: string;
}

/**
 * Run a prompt through a fresh ClaudeCodeRunner (host mode, haiku) with an
 * optional deny gate, collecting the tool lifecycle events.
 */
export async function runObserving(opts: {
  agent: ReturnType<typeof buildAgent>;
  prompt: string;
  denyGate?: DenyToolGate;
  nativeTools?: "all" | "none" | readonly string[];
}): Promise<RunObservation> {
  const bus = new AgentEventBus();
  if (opts.denyGate) bus.addGate(opts.denyGate);

  const obs: RunObservation = {
    intents: [],
    rejected: [],
    started: [],
    ended: [],
    response: "",
  };
  const name = (e: unknown) => (e as { toolName?: string }).toolName ?? "";
  bus.subscribe("agent.tool.intent", (e) => obs.intents.push(name(e)));
  bus.subscribe("agent.tool.rejected", (e) => obs.rejected.push(name(e)));
  bus.subscribe("agent.tool.start", (e) => obs.started.push(name(e)));
  bus.subscribe("agent.tool.end", (e) => obs.ended.push(name(e)));

  const runner = new ClaudeCodeRunner({
    eventBus: bus,
    nativeTools: opts.nativeTools ?? "all",
  });
  try {
    const result = await runner.run(opts.agent, opts.prompt, {
      eventBus: bus,
      maxIterations: 4,
    });
    obs.response = result.response;
  } finally {
    runner.dispose();
  }
  return obs;
}

// ---------------------------------------------------------------------------
// Enforcement matrix accumulation + reporting
// ---------------------------------------------------------------------------

export type EnforcementBasis = "live-verified" | "observed" | "docs";
export interface MatrixRow {
  enforcement: "enforcing" | "advisory" | "unsupported";
  basis: EnforcementBasis;
  evidence: string;
}

const matrix = new Map<OperationClass, MatrixRow>();
export function recordMatrix(cls: OperationClass, row: MatrixRow): void {
  matrix.set(cls, row);
}
export function printMatrix(): void {
  const order: OperationClass[] = [
    "shell",
    "file-change",
    "mcp-tool",
    "local-tool",
    "subagent",
    "hosted-tool",
  ];
  const lines = [
    "",
    "=== CC per-class enforcement matrix (contract-tested) ===",
    "| OperationClass | Enforcement | Basis | Evidence |",
    "|---|---|---|---|",
  ];
  for (const cls of order) {
    const row = matrix.get(cls);
    if (row) {
      lines.push(`| ${cls} | ${row.enforcement} | ${row.basis} | ${row.evidence} |`);
    }
  }
  // Deliberate console output: the matrix IS the test artifact. (noConsole is
  // not enabled in this repo's biome config, so no suppression is needed —
  // biome 1.9.5+ flags the unused suppression itself.)
  console.log(lines.join("\n"));
}
