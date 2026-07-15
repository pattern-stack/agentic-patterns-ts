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
import { formatScopeBanner, redactContextForDisplay, resolveRunContext } from "../run.js";

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
