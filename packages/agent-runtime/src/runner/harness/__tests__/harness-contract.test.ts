/**
 * Harness contract unit tests (B-2 / #326): the C1 decision-validation helper,
 * the run-start GateRequirements compatibility check, and the CC adapter probe.
 */

import { describe, expect, it } from "vitest";

import { AgentEventBus } from "../../../events/agent-event-bus.js";
import type { Gate, GateResult } from "../../../gates/base.js";
import { GateCategory } from "../../../gates/base.js";
import type { HarnessDecision, NativeProposal } from "../../../gates/decisions.js";
import { ClaudeCodeRunner } from "../../claude-code-runner.js";
import type { AgentLikeForBridge } from "../../sdk-bridge.js";
import { ClaudeCodeAdapter } from "../claude-code/claude-code-adapter.js";
import { validateDecision } from "../decision-validation.js";
import { GateRequirementError, assertGateRequirements } from "../gate-requirements.js";
import type { DecisionVocabulary, HarnessProbeResult } from "../types.js";

// ---------------------------------------------------------------------------
// C1 — decision validation against the adapter vocabulary (NOT availableDecisions)
// ---------------------------------------------------------------------------

const CC_VOCAB: DecisionVocabulary = {
  "tool-permission": ["allowOnce", "allowWithRules", "deny", "cancel", "rewriteInput"],
};

const sessionProposal: NativeProposal = {
  id: "p-session",
  nativeKind: "cc-permission-update",
  allowedScopes: ["session"],
  payload: { destination: "session" },
};
const durableProposal: NativeProposal = {
  id: "p-durable",
  nativeKind: "cc-permission-update",
  allowedScopes: ["durable"],
  payload: { destination: "userSettings" },
};

describe("validateDecision — C1 four-check", () => {
  it("step 1 (kind): a kind in the adapter vocabulary passes even if absent from availableDecisions", () => {
    // `deny` is legitimate for CC but a wire `availableDecisions` might omit it
    // (C1). Validation keys on the vocabulary, so it passes.
    const decision: HarnessDecision = { kind: "deny", reason: "nope" };
    expect(
      validateDecision({
        decision,
        requestType: "tool-permission",
        vocabulary: CC_VOCAB,
        proposals: [],
        operation: "shell",
        durableEnabled: false,
      }),
    ).toEqual({ ok: true });
  });

  it("step 1 (kind): a kind NOT in the vocabulary is rejected", () => {
    // CC has no rule-free session cache → allowSession is not in its vocabulary.
    const decision: HarnessDecision = { kind: "allowSession" };
    const result = validateDecision({
      decision,
      requestType: "tool-permission",
      vocabulary: CC_VOCAB,
      proposals: [],
      operation: "shell",
      durableEnabled: false,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: "kind" });
  });

  it("step 2 (compatibility): a ruleRef that resolves to no proposal is rejected", () => {
    const decision: HarnessDecision = {
      kind: "allowWithRules",
      ruleRefs: [{ proposalId: "missing" }],
      scope: "session",
    };
    const result = validateDecision({
      decision,
      requestType: "tool-permission",
      vocabulary: CC_VOCAB,
      proposals: [sessionProposal],
      operation: "shell",
      durableEnabled: false,
    });
    expect(result).toMatchObject({ ok: false, code: "compatibility" });
  });

  it("step 3 (scope): a scope outside the proposal's allowedScopes is rejected", () => {
    const decision: HarnessDecision = {
      kind: "allowWithRules",
      ruleRefs: [{ proposalId: "p-session" }],
      scope: "durable", // proposal only allows "session"
    };
    const result = validateDecision({
      decision,
      requestType: "tool-permission",
      vocabulary: CC_VOCAB,
      proposals: [sessionProposal],
      operation: "shell",
      durableEnabled: true,
    });
    expect(result).toMatchObject({ ok: false, code: "scope" });
  });

  it("step 4 (authorization): durable scope requires the D13 flag", () => {
    const decision: HarnessDecision = {
      kind: "allowWithRules",
      ruleRefs: [{ proposalId: "p-durable" }],
      scope: "durable",
    };
    const denied = validateDecision({
      decision,
      requestType: "tool-permission",
      vocabulary: CC_VOCAB,
      proposals: [durableProposal],
      operation: "shell",
      durableEnabled: false,
    });
    expect(denied).toMatchObject({ ok: false, code: "authorization" });

    const allowed = validateDecision({
      decision,
      requestType: "tool-permission",
      vocabulary: CC_VOCAB,
      proposals: [durableProposal],
      operation: "shell",
      durableEnabled: true,
    });
    expect(allowed).toEqual({ ok: true });
  });

  it("session-scoped allowWithRules against a session proposal passes", () => {
    const decision: HarnessDecision = {
      kind: "allowWithRules",
      ruleRefs: [{ proposalId: "p-session" }],
      scope: "session",
    };
    expect(
      validateDecision({
        decision,
        requestType: "tool-permission",
        vocabulary: CC_VOCAB,
        proposals: [sessionProposal],
        operation: "shell",
        durableEnabled: false,
      }),
    ).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// GateRequirements — run-start compatibility check
// ---------------------------------------------------------------------------

function gate(name: string, requires?: Gate["requires"]): Gate {
  return {
    category: GateCategory.SAFETY,
    name,
    categoryName: "SAFETY",
    ...(requires ? { requires } : {}),
    async check(): Promise<GateResult> {
      return { action: "allow" };
    },
    getBlockReason: () => "blocked",
  };
}

function probe(overrides?: Partial<HarnessProbeResult>): HarnessProbeResult {
  return {
    ok: true,
    issues: [],
    authMode: "subscription",
    enforcement: {
      shell: "enforcing",
      "file-change": "enforcing",
      "mcp-tool": "enforcing",
      "local-tool": "enforcing",
      subagent: "enforcing",
      "hosted-tool": "advisory",
    },
    sandbox: { networkPolicy: "none" },
    features: {
      interactiveAsk: true,
      resume: true,
      partialStreaming: true,
      inputRewrite: true,
      durableRules: true,
    },
    ...overrides,
  };
}

describe("assertGateRequirements — run-start fail-loud", () => {
  it("undeclared gates impose no requirements (existing gates unaffected)", () => {
    expect(() =>
      assertGateRequirements([gate("SafetyGate"), gate("AuditGate")], probe(), "claude-code"),
    ).not.toThrow();
  });

  it("passes when the harness enforces every required class", () => {
    expect(() =>
      assertGateRequirements(
        [gate("ShellGuard", { interceptClasses: ["shell", "file-change"] })],
        probe(),
        "claude-code",
      ),
    ).not.toThrow();
  });

  it("throws naming the gate AND the class when a required class is only advisory", () => {
    expect(() =>
      assertGateRequirements(
        [gate("WebGuard", { interceptClasses: ["hosted-tool"] })],
        probe(),
        "claude-code",
      ),
    ).toThrow(GateRequirementError);
    try {
      assertGateRequirements(
        [gate("WebGuard", { interceptClasses: ["hosted-tool"] })],
        probe(),
        "claude-code",
      );
    } catch (e) {
      expect((e as Error).message).toContain("WebGuard");
      expect((e as Error).message).toContain("hosted-tool");
      expect((e as Error).message).toContain("advisory");
      expect((e as Error).message).toContain("claude-code");
    }
  });

  it("throws when a required class is unsupported", () => {
    expect(() =>
      assertGateRequirements(
        [gate("MdGuard", { interceptClasses: ["mcp-tool"] })],
        probe({
          enforcement: { ...probe().enforcement, "mcp-tool": "unsupported" },
        }),
        "codex",
      ),
    ).toThrow(/MdGuard[\s\S]*mcp-tool[\s\S]*unsupported/);
  });

  it("throws when a rewrite-declaring gate meets a harness without inputRewrite", () => {
    expect(() =>
      assertGateRequirements(
        [gate("Rewriter", { rewrite: true })],
        probe({ features: { ...probe().features, inputRewrite: false } }),
        "codex",
      ),
    ).toThrow(/Rewriter[\s\S]*rewrite/);
  });
});

// ---------------------------------------------------------------------------
// CC adapter probe + decision vocabulary
// ---------------------------------------------------------------------------

describe("ClaudeCodeAdapter — probe + vocabulary", () => {
  const adapter = new ClaudeCodeAdapter({
    buildOptions: () => ({}) as never,
  });

  it("declares the CC enforcement matrix (shell/file/mcp/local/subagent enforcing; hosted advisory)", async () => {
    const p = await adapter.probe({});
    expect(p.ok).toBe(true);
    expect(p.enforcement).toMatchObject({
      shell: "enforcing",
      "file-change": "enforcing",
      "mcp-tool": "enforcing",
      "local-tool": "enforcing",
      subagent: "enforcing",
      "hosted-tool": "advisory",
    });
    expect(p.features.inputRewrite).toBe(true);
  });

  it("vocabulary excludes allowSession + grantPermissions (CC has neither seam)", () => {
    const vocab = adapter.decisionVocabulary["tool-permission"] ?? [];
    expect(vocab).toContain("allowOnce");
    expect(vocab).toContain("allowWithRules");
    expect(vocab).toContain("rewriteInput");
    expect(vocab).not.toContain("allowSession");
    expect(vocab).not.toContain("grantPermissions");
  });
});

// ---------------------------------------------------------------------------
// Run-start integration — CodingAgentRunner fails loud BEFORE launching the SDK
// ---------------------------------------------------------------------------

describe("CodingAgentRunner — run-start GateRequirements check", () => {
  function agent(): AgentLikeForBridge {
    return {
      role: { name: "t", capabilities: [] },
      getModel: () => "claude-haiku-4-5",
      getTools: () => [],
      renderInitialPrompt: () => "system",
    };
  }

  it("throws GateRequirementError (named gate + class) before any harness launch", async () => {
    const bus = new AgentEventBus();
    // A gate demanding synchronous interception of hosted tools — which CC only
    // treats as advisory. The run must fail at start, never spawning the SDK.
    bus.addGate(gate("WebSearchGuard", { interceptClasses: ["hosted-tool"] }));
    const runner = new ClaudeCodeRunner({ eventBus: bus });

    await expect(runner.run(agent(), "hello")).rejects.toThrow(GateRequirementError);
    await expect(runner.run(agent(), "hello")).rejects.toThrow(/WebSearchGuard[\s\S]*hosted-tool/);
  });
});
