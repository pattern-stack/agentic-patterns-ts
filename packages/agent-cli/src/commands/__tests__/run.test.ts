/**
 * `ap run` run-scope context tests (#268 PR-3).
 *
 * Exercises the three pure helpers `runRunCommand` builds on — `resolveRunContext`,
 * `redactContextForDisplay`, `formatScopeBanner` — directly, rather than driving the
 * full command (which requires a live `ExecutionService`/runner). This is also what
 * "fails loud pre-run" means as a testable property: the validation these functions
 * perform never touches a runner, a credential, or a model call.
 */

import { describe, expect, it } from "vitest";
import type { DiscoveredAgent } from "../../helpers/discover.js";
import {
  checkInstantiateKindMatch,
  formatScopeBanner,
  formatScopeValidationError,
  redactContextForDisplay,
  resolveRunContext,
  unionRedactKeys,
} from "../run.js";

// A duck-typed fake SessionScope (#308) — no `@pattern-stack/agentic-core` import,
// same posture as the discovery fixtures.
function fakeScope(
  overrides: Partial<NonNullable<DiscoveredAgent["scope"]>> = {},
): NonNullable<DiscoveredAgent["scope"]> {
  return {
    schema: { type: "object" },
    redactKeys: [],
    parse: (value) => value as Record<string, unknown>,
    toJsonSchema: () => ({}),
    ...overrides,
  };
}

// Minimal fixtures for `isPromotedAgent`'s structural check (`as-agent.ts`):
// a promoted instance needs `__promotedNode.run` + `coerceIn`/`renderOut`/
// `getModel`/`renderInitialPrompt` as functions; a plain agent satisfies
// none of that.
const plainAgent = { role: { name: "Plain" } };
const promotedAgent = {
  role: { name: "Promoted" },
  __promotedNode: { run: async () => ({}) },
  coerceIn: (x: unknown) => x,
  renderOut: (x: unknown) => x,
  getModel: () => "sonnet",
  renderInitialPrompt: () => "",
};

describe("resolveRunContext — precedence: flag > AP_CONTEXT env > instantiateDefaults", () => {
  const noHook = {};
  const withHook = { instantiate: async (ctx?: Record<string, unknown>) => ({ ctx }) };
  const withHookAndDefaults = {
    instantiate: async (ctx?: Record<string, unknown>) => ({ ctx }),
    instantiateDefaults: { tenant: "default-tenant" },
  };

  it("no flag, no env, no hook, no defaults → ok, no hook, undefined context", () => {
    const result = resolveRunContext(noHook, undefined, {});
    expect(result).toEqual({ ok: true, hasHook: false, context: undefined });
  });

  it("no flag, no env, hook with no defaults → ok, hook, undefined context", () => {
    const result = resolveRunContext(withHook, undefined, {});
    expect(result).toEqual({ ok: true, hasHook: true, context: undefined });
  });

  it("falls back to instantiateDefaults when neither flag nor env is present", () => {
    const result = resolveRunContext(withHookAndDefaults, undefined, {});
    expect(result).toEqual({
      ok: true,
      hasHook: true,
      context: { tenant: "default-tenant" },
    });
  });

  it("instantiateDefaults is shallow-copied — a mutation on the resolved context never corrupts the registration's shared defaults object", () => {
    const result = resolveRunContext(withHookAndDefaults, undefined, {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    (result.context as Record<string, unknown>).tenant = "mutated";
    expect(withHookAndDefaults.instantiateDefaults).toEqual({ tenant: "default-tenant" });
  });

  it("AP_CONTEXT env resolves context when no --context flag is given", () => {
    const result = resolveRunContext(withHook, undefined, {
      AP_CONTEXT: '{"tenant":"env-tenant"}',
    });
    expect(result).toEqual({ ok: true, hasHook: true, context: { tenant: "env-tenant" } });
  });

  it("--context flag wins over AP_CONTEXT env when both are present", () => {
    const result = resolveRunContext(withHook, '{"tenant":"flag-tenant"}', {
      AP_CONTEXT: '{"tenant":"env-tenant"}',
    });
    expect(result).toEqual({ ok: true, hasHook: true, context: { tenant: "flag-tenant" } });
  });

  it("an explicit flag/env context beats instantiateDefaults entirely (no merge)", () => {
    const result = resolveRunContext(withHookAndDefaults, '{"tenant":"flag-tenant"}', {});
    expect(result).toEqual({ ok: true, hasHook: true, context: { tenant: "flag-tenant" } });
  });

  it("invalid JSON in --context fails loud, before any model call", () => {
    const result = resolveRunContext(withHook, "{not valid json", {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/not valid JSON/);
  });

  it("invalid JSON in AP_CONTEXT fails loud the same way", () => {
    const result = resolveRunContext(withHook, undefined, { AP_CONTEXT: "[[[" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/not valid JSON/);
  });

  it("a non-object JSON value (array) is rejected — mirrors the server's object-only grammar", () => {
    const result = resolveRunContext(withHook, "[1,2,3]", {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/must be a JSON object/);
  });

  it("a non-object JSON value (string) is rejected", () => {
    const result = resolveRunContext(withHook, '"just a string"', {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/must be a JSON object/);
  });

  it("--context on a hook-less agent errors — parity with the server's 400", () => {
    const result = resolveRunContext(noHook, '{"tenant":"x"}', {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/no instantiate hook/);
  });

  it("AP_CONTEXT on a hook-less agent errors the same way", () => {
    const result = resolveRunContext(noHook, undefined, { AP_CONTEXT: '{"tenant":"x"}' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/no instantiate hook/);
  });

  it("invalid JSON on a hook-less agent reports the JSON error, not the hook error (parse validated first)", () => {
    const result = resolveRunContext(noHook, "{not json", {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/not valid JSON/);
  });

  // Gate 2.5 should-fix: a present-but-blank AP_CONTEXT (e.g. a stray
  // `export AP_CONTEXT=` in a .env) must behave like an ABSENT source, not
  // like a malformed one — `??` alone lets `""` through to JSON.parse, which
  // throws, hard-blocking every `ap run` including hook-less agents that
  // never opted into context at all.
  it("blank AP_CONTEXT falls back to instantiateDefaults on a hook-bearing agent, same as unset", () => {
    const result = resolveRunContext(withHookAndDefaults, undefined, { AP_CONTEXT: "" });
    expect(result).toEqual({
      ok: true,
      hasHook: true,
      context: { tenant: "default-tenant" },
    });
  });

  it("whitespace-only AP_CONTEXT falls back the same way", () => {
    const result = resolveRunContext(withHookAndDefaults, undefined, { AP_CONTEXT: "   " });
    expect(result).toEqual({
      ok: true,
      hasHook: true,
      context: { tenant: "default-tenant" },
    });
  });

  it("blank AP_CONTEXT on a hook-less agent runs normally — never trips the JSON or hook-presence check", () => {
    const result = resolveRunContext(noHook, undefined, { AP_CONTEXT: "" });
    expect(result).toEqual({ ok: true, hasHook: false, context: undefined });
  });
});

describe("resolveRunContext — scope subsumption (#308, decisions.md D12)", () => {
  const scopeOnly = { scope: fakeScope() };
  const scopeWithDefaults = { scope: fakeScope({ defaults: { tenant: "scope-tenant" } }) };
  const hookAndScopeWithDefaults = {
    instantiate: async (ctx?: Record<string, unknown>) => ({ ctx }),
    instantiateDefaults: { tenant: "instantiate-tenant" },
    scope: fakeScope({ defaults: { tenant: "scope-tenant" } }),
  };

  it("scope.defaults wins over instantiateDefaults when both are declared", () => {
    const result = resolveRunContext(hookAndScopeWithDefaults, undefined, {});
    expect(result).toEqual({ ok: true, hasHook: true, context: { tenant: "scope-tenant" } });
  });

  it("a scope-only registration (no instantiate hook) falls back to scope.defaults", () => {
    const result = resolveRunContext(scopeWithDefaults, undefined, {});
    expect(result).toEqual({ ok: true, hasHook: false, context: { tenant: "scope-tenant" } });
  });

  it("a scope-only registration with no defaults resolves to undefined context, same as hook-less/scope-less", () => {
    const result = resolveRunContext(scopeOnly, undefined, {});
    expect(result).toEqual({ ok: true, hasHook: false, context: undefined });
  });

  it("a scope-only registration ACCEPTS --context — the no-instantiate-hook rejection widens to hasScope", () => {
    const result = resolveRunContext(scopeOnly, '{"tenant":"flag-tenant"}', {});
    expect(result).toEqual({ ok: true, hasHook: false, context: { tenant: "flag-tenant" } });
  });

  it("a scope-only registration ACCEPTS AP_CONTEXT the same way", () => {
    const result = resolveRunContext(scopeOnly, undefined, { AP_CONTEXT: '{"tenant":"x"}' });
    expect(result).toEqual({ ok: true, hasHook: false, context: { tenant: "x" } });
  });

  it("a genuinely hook-less, scope-less agent still rejects --context (no regression)", () => {
    const result = resolveRunContext({}, '{"tenant":"x"}', {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/no instantiate hook/);
  });

  it("scope.defaults is shallow-copied per call — a mutation never corrupts the registration's shared defaults", () => {
    const result = resolveRunContext(scopeWithDefaults, undefined, {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    (result.context as Record<string, unknown>).tenant = "mutated";
    expect(scopeWithDefaults.scope.defaults).toEqual({ tenant: "scope-tenant" });
  });
});

describe("formatScopeValidationError (#308 decisions.md D3 — duck-typed err.issues)", () => {
  it("formats a zod-shaped issues array into a readable summary", () => {
    const err = {
      issues: [
        { path: ["tenant"], message: "Required" },
        { path: ["region"], message: "Invalid enum value" },
      ],
    };
    expect(formatScopeValidationError(err)).toBe(
      "scope validation failed: tenant: Required; region: Invalid enum value",
    );
  });

  it("falls back to '(root)' when an issue has no path", () => {
    const err = { issues: [{ message: "Expected object, received string" }] };
    expect(formatScopeValidationError(err)).toBe(
      "scope validation failed: (root): Expected object, received string",
    );
  });

  it("falls back to a plain Error's message when there is no issues array", () => {
    expect(formatScopeValidationError(new Error("boom"))).toBe("scope validation failed: boom");
  });

  it("falls back to String() for a non-Error, non-issues throw", () => {
    expect(formatScopeValidationError("plain string throw")).toBe(
      "scope validation failed: plain string throw",
    );
  });
});

describe("unionRedactKeys (#308 — mirrors routes/conversations.ts's union)", () => {
  it("unions scope and deprecated contextRedactKeys, deduped", () => {
    expect(unionRedactKeys(["secret", "userId"], ["userId", "token"])).toEqual([
      "secret",
      "userId",
      "token",
    ]);
  });

  it("handles both sides absent", () => {
    expect(unionRedactKeys(undefined, undefined)).toEqual([]);
  });

  it("handles one side absent", () => {
    expect(unionRedactKeys(["secret"], undefined)).toEqual(["secret"]);
    expect(unionRedactKeys(undefined, ["token"])).toEqual(["token"]);
  });
});

describe("redactContextForDisplay", () => {
  it("passes through undefined context regardless of keys", () => {
    expect(redactContextForDisplay(undefined, ["secret"])).toBeUndefined();
  });

  it("passes through when no keys are declared", () => {
    const context = { tenant: "t1" };
    expect(redactContextForDisplay(context, undefined)).toEqual({ tenant: "t1" });
  });

  it("passes through when declared keys are absent from the context", () => {
    const context = { tenant: "t1" };
    expect(redactContextForDisplay(context, ["secret"])).toEqual({ tenant: "t1" });
  });

  it("redacts only the declared keys that are present, leaving others intact", () => {
    const context = { tenant: "t1", secret: "shh", userId: "u1" };
    expect(redactContextForDisplay(context, ["secret"])).toEqual({
      tenant: "t1",
      secret: "[redacted]",
      userId: "u1",
    });
  });

  it("does not mutate the input context", () => {
    const context = { tenant: "t1", secret: "shh" };
    redactContextForDisplay(context, ["secret"]);
    expect(context.secret).toBe("shh");
  });
});

describe("checkInstantiateKindMatch — #268 hardening: instantiate's kind contract", () => {
  it("ok when declared and delivered are both plain", () => {
    expect(checkInstantiateKindMatch(plainAgent, plainAgent)).toEqual({ ok: true });
  });

  it("ok when declared and delivered are both promoted", () => {
    expect(checkInstantiateKindMatch(promotedAgent, promotedAgent)).toEqual({ ok: true });
  });

  it("errors when a plain-declared registration's hook delivers a promoted instance (the silent-wrong direction — would otherwise get LLM-looped, never running the pipeline)", () => {
    const result = checkInstantiateKindMatch(plainAgent, promotedAgent);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe(
      "instantiate must return an instance runnable by the registration's runner — declared plain, delivered promoted",
    );
  });

  it("errors when a promoted-declared registration's hook delivers a plain instance (the loud-but-late direction — caught here instead of deep inside NodeBackedRunner)", () => {
    const result = checkInstantiateKindMatch(promotedAgent, plainAgent);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe(
      "instantiate must return an instance runnable by the registration's runner — declared promoted, delivered plain",
    );
  });
});

describe("formatScopeBanner", () => {
  it("renders `scope: null` when there is no context", () => {
    expect(formatScopeBanner(undefined, undefined)).toBe("scope: null");
  });

  it("renders the compact JSON of the context verbatim when no keys are redacted", () => {
    expect(formatScopeBanner({ tenant: "t1" }, undefined)).toBe('scope: {"tenant":"t1"}');
  });

  it("renders the redacted form when contextRedactKeys are declared", () => {
    expect(formatScopeBanner({ tenant: "t1", secret: "shh" }, ["secret"])).toBe(
      'scope: {"tenant":"t1","secret":"[redacted]"}',
    );
  });
});
