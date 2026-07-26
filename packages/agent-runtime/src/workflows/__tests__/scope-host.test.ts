/**
 * Unit coverage for `scope-host.ts` — the sibling-`host.scope`-key accessor
 * trio (#308 D1/D2). Mirrors `backpack.test.ts`'s direct coverage of
 * `openBackpack`/`requireBackpack`'s undefined/throw edges.
 */

import type { ToolExecutionContext } from "@agentic-patterns/core";
import { describe, expect, it } from "vitest";
import {
  ScopeUnavailableError,
  buildScopeHost,
  readScope,
  readScopeAs,
  requireScope,
  requireScopeAs,
} from "../scope-host.js";

describe("buildScopeHost", () => {
  it("wraps a parsed scope value under a `scope` key", () => {
    const parsed = { workspace: "acme", user: "sam@acme.dev" };
    expect(buildScopeHost(parsed)).toEqual({ scope: parsed });
  });

  it("is mergeable with other host bits at the injection site", () => {
    const parsed = { workspace: "acme" };
    const scratchpadMarker = { fake: "scratchpad" };
    const merged = { scratchpad: scratchpadMarker, ...buildScopeHost(parsed) };
    expect(merged).toEqual({ scratchpad: scratchpadMarker, scope: parsed });
  });
});

describe("readScope — soft probe", () => {
  it("undefined ctx -> undefined", () => {
    expect(readScope(undefined)).toBeUndefined();
  });

  it("ctx with no host -> undefined", () => {
    expect(readScope({} as ToolExecutionContext)).toBeUndefined();
  });

  it("ctx.host present but no scope key -> undefined", () => {
    expect(readScope({ host: {} } as ToolExecutionContext)).toBeUndefined();
  });

  it("ctx.host.scope present -> returns it by reference", () => {
    const parsed = { workspace: "acme" };
    const ctx = { host: buildScopeHost(parsed) } as ToolExecutionContext;
    expect(readScope(ctx)).toEqual(parsed);
    // buildScopeHost freezes a shallow COPY at the injection seam — reads are
    // stable across calls, but the caller's own object is never frozen.
    expect(readScope(ctx)).toBe(readScope(ctx));
    expect(Object.isFrozen(readScope(ctx))).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(false);
  });

  it("readScope narrows exactly the sibling key — a scope-shaped value under host.deps is NOT picked up", () => {
    // The whole point of D1: scope must never be confused with host.deps.
    const ctx = { host: { deps: { workspace: "acme" } } } as unknown as ToolExecutionContext;
    expect(readScope(ctx)).toBeUndefined();
  });
});

describe("requireScope — fail-loud accessor", () => {
  it("throws ScopeUnavailableError with remediation text when scope is absent", () => {
    expect(() => requireScope(undefined)).toThrow(ScopeUnavailableError);
    try {
      requireScope(undefined);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeUnavailableError);
      expect((err as Error).message).toContain("buildScopeHost");
      expect((err as Error).message).toContain("readScope");
    }
  });

  it("returns the scope value when present (same value as readScope)", () => {
    const parsed = { workspace: "acme" };
    const ctx = { host: buildScopeHost(parsed) } as ToolExecutionContext;
    expect(requireScope(ctx)).toBe(readScope(ctx));
    expect(requireScope(ctx)).toEqual(parsed);
  });
});

describe("readScopeAs — typed cast sugar", () => {
  interface WorkspaceScope {
    readonly workspace: string;
    readonly user: string;
  }

  it("casts the raw scope bag to T without re-parsing", () => {
    const parsed: Record<string, unknown> = { workspace: "acme", user: "sam@acme.dev" };
    const ctx = { host: buildScopeHost(parsed) } as ToolExecutionContext;
    const typed = readScopeAs<WorkspaceScope>(ctx);
    expect(typed).toEqual(parsed);
    expect(typed).toBe(readScope(ctx)); // identity with the host bag — a cast, not a copy
  });

  it("undefined when no scope is present", () => {
    expect(readScopeAs<WorkspaceScope>(undefined)).toBeUndefined();
  });
});

describe("requireScopeAs — typed + fail-loud", () => {
  interface WorkspaceScope {
    readonly workspace: string;
    readonly user: string;
  }

  it("casts the raw scope bag to T without re-parsing", () => {
    const parsed: Record<string, unknown> = { workspace: "acme", user: "sam@acme.dev" };
    const ctx = { host: buildScopeHost(parsed) } as ToolExecutionContext;
    const typed = requireScopeAs<WorkspaceScope>(ctx);
    expect(typed).toEqual(parsed);
    expect(typed).toBe(readScope(ctx)); // identity with the host bag — a cast, not a copy
  });

  it("throws ScopeUnavailableError when scope is absent, unlike readScopeAs", () => {
    expect(readScopeAs<WorkspaceScope>(undefined)).toBeUndefined();
    expect(() => requireScopeAs<WorkspaceScope>(undefined)).toThrow(ScopeUnavailableError);
  });

  it("accepts a node context (scope at ctx.scope) like the untyped accessors", () => {
    const parsed = { workspace: "acme", user: "sam@acme.dev" };
    expect(requireScopeAs<WorkspaceScope>({ scope: parsed })).toBe(parsed);
  });
});

describe("NodeRunContext shape — scope at ctx.scope, no host bag", () => {
  it("readScope reads a node context's direct scope field", () => {
    const parsed = { workspace: "acme" };
    expect(readScope({ scope: parsed })).toBe(parsed);
  });

  it("requireScope accepts a node context instead of always throwing on it", () => {
    const parsed = { workspace: "acme" };
    expect(requireScope({ scope: parsed })).toBe(parsed);
    expect(() => requireScope({} as { scope?: Record<string, unknown> })).toThrow(
      "No session scope",
    );
  });

  it("host.scope wins over a direct scope field when both exist", () => {
    const hostScope = { workspace: "from-host" };
    const ctx = { host: buildScopeHost(hostScope), scope: { workspace: "direct" } };
    expect(readScope(ctx)).toEqual(hostScope);
  });
});
