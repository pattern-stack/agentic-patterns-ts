#!/usr/bin/env bun
/**
 * Acceptance sweep for issue #265: lint every shipped example agent's tool
 * and playbook-play schemas with `lintModelFacingSchema` under the
 * `gemini-bifrost` dialect. Zero findings is an explicit acceptance
 * criterion — if a shipped schema genuinely trips a rule, that is a real bug
 * to fix in the schema, not a reason to loosen a rule or skip a target here.
 *
 * Runs via `bun run check:model-facing-schemas` (wired into the root
 * `check` script, after build/typecheck/lint/test — see root package.json)
 * and therefore requires `packages/*` to already be built: it imports the
 * public surface of `@pattern-stack/agentic-core` and `@pattern-stack/agentic-runtime`,
 * not source files.
 *
 * Sweep targets (spec: `.ai-docs/specs/tool-authoring-sugar.md` § Test plan
 * § Zero-false-positive sweep):
 *   - runtime presets: calculator, todo, writing-coach (no tools — handled
 *     gracefully since `Role.capabilities` is simply empty).
 *   - examples/agents/toolsmith — its tools + returns, and its playbook
 *     play's parameters + returns.
 *   - core `ManualToolbox`'s two built-in tool parameter schemas.
 *
 * Deliberately does NOT run the `openai` dialect: that rule set represents
 * the structured-output conversion path, not tool-input schemas.
 */

import {
  type Agent,
  ManualToolbox,
  type PlayDefinition,
  type SchemaLintFinding,
  TextManual,
  type ToolDefinition,
  lintModelFacingSchema,
} from "@pattern-stack/agentic-core";
import {
  buildCalculatorAgent,
  buildTodoAgent,
  buildWritingCoachAgent,
} from "@pattern-stack/agentic-runtime";
// The workspace-member example agent (examples/agents/package.json depends on
// @pattern-stack/agentic-core + runtime as real workspace deps) — its default
// export is an already-built Agent instance (see agent.ts's final line).
import toolsmith from "../examples/agents/toolsmith/agent.js";

const DIALECT = "gemini-bifrost" as const;

interface LabeledFinding {
  readonly agent: string;
  readonly capability: string;
  readonly tool: string;
  readonly schema: "parameters" | "returns";
  readonly finding: SchemaLintFinding;
}

const labeled: LabeledFinding[] = [];

/** Lint every tool/play's `parameters` and (if present) `returns`. */
function lintDefinitions(
  agentLabel: string,
  capabilityLabel: string,
  definitions: Record<string, ToolDefinition | PlayDefinition>,
): void {
  for (const [name, def] of Object.entries(definitions)) {
    for (const finding of lintModelFacingSchema(def.parameters, {
      dialect: DIALECT,
      requireDescribe: false,
    })) {
      labeled.push({
        agent: agentLabel,
        capability: capabilityLabel,
        tool: name,
        schema: "parameters",
        finding,
      });
    }
    if (def.returns) {
      for (const finding of lintModelFacingSchema(def.returns, {
        dialect: DIALECT,
        requireDescribe: false,
      })) {
        labeled.push({
          agent: agentLabel,
          capability: capabilityLabel,
          tool: name,
          schema: "returns",
          finding,
        });
      }
    }
  }
}

/** Lint every capability's toolbox tools and (if present) playbook plays. */
function lintAgent(agentLabel: string, agent: Agent): void {
  for (const capability of agent.role.capabilities) {
    lintDefinitions(agentLabel, capability.name, capability.toolbox.tools);
    if (capability.playbook) {
      lintDefinitions(agentLabel, `${capability.name} (playbook)`, capability.playbook.plays);
    }
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

lintAgent("calculator", buildCalculatorAgent());
lintAgent("todo", buildTodoAgent());
// writing-coach declares no capability at all — Role.capabilities is simply
// empty, so lintAgent is a graceful no-op rather than a special case.
lintAgent("writing-coach", buildWritingCoachAgent());
lintAgent("toolsmith", toolsmith);

// core `ManualToolbox`'s two built-in tools (readManualSection,
// listManualSections) — their parameter schemas are the same regardless of
// which Manual instance backs them, so any non-empty Manual probes them.
const manualToolbox = new ManualToolbox(
  new TextManual("sweep-probe", "Probe content for the model-facing schema sweep."),
);
lintDefinitions("core", "ManualToolbox", manualToolbox.tools);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (labeled.length > 0) {
  const detail = labeled
    .map(
      ({ agent, capability, tool, schema, finding }) =>
        `  [${agent} / ${capability} / ${tool}.${schema}] ${finding.code} (${finding.severity}) at ${finding.path}: ${finding.message}`,
    )
    .join("\n");
  throw new Error(
    `check-model-facing-schemas: ${labeled.length} model-facing schema lint finding(s) on shipped examples ` +
      `(dialect: ${DIALECT}):\n${detail}`,
  );
}

console.log(
  `check-model-facing-schemas: clean — 0 findings across calculator/todo/writing-coach/toolsmith/ManualToolbox (dialect: ${DIALECT}).`,
);
