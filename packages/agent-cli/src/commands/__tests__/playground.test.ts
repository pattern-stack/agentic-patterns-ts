/**
 * Regression test for the SPA-fallback API-prefix gotcha (spec
 * `.ai-docs/stacks/eval-surface/specs/136.md` § Tests, item 7-8).
 *
 * `mountDashboard`'s `app.get("*")` handler consults `isApiPath` before
 * rewriting to `index.html` (`playground.ts:236-238`) — a GET under an API
 * prefix that no mounted route matches (typos, or a future mount-order
 * reshuffle) must still 404 as an API path rather than serve the SPA shell.
 * `/eval` joining `API_PREFIXES` is the fix this issue ships; this table
 * locks the whole allowlist (old + new) against accidental regressions.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRegistration } from "@agentic-patterns/server";
import { describe, expect, it } from "vitest";
import type { DiscoveredAgent } from "../../helpers/discover.js";
import {
  isApiPath,
  isHtmlNavigation,
  toAgentRegistration,
  withHtmlNavigationShim,
} from "../playground.js";

describe("toAgentRegistration — DiscoveredAgent -> AgentRegistration field map (#308 gapcheck G7)", () => {
  // A minimal fake runner: `AgentRegistration.runner` only requires `run`
  // (`stream` stays optional, mirroring `RunnerProtocol`) — no real LLM call
  // needed to exercise the field map itself.
  const fakeRunner: AgentRegistration["runner"] = {
    run: async () => ({
      response: "",
      inputTokens: 0,
      outputTokens: 0,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: "stop",
    }),
  };

  // A duck-typed fake SessionScope (no `@agentic-patterns/core` import,
  // same posture as the discovery fixtures) — its identity is what this
  // test proves survives the map, not its behavior.
  const fakeScope: NonNullable<DiscoveredAgent["scope"]> = {
    schema: { type: "object" },
    redactKeys: ["secret"],
    defaults: { tenant: "acme" },
    parse: (value) => value as Record<string, unknown>,
    toJsonSchema: () => ({}),
  };

  // A duck-typed fake memory declaration (#444) — like `fakeScope`, its
  // IDENTITY surviving the map is what the test proves (the same store
  // instance must reach the server: turn-1 recall and the toolbox must share
  // one store).
  const fakeMemory: NonNullable<DiscoveredAgent["memory"]> = {
    store: {
      write: async () => [],
      search: async () => [],
      get: async () => null,
      invalidate: async () => {},
      delete: async () => {},
      capabilities: async () => ({ search: "keyword" as const }),
    },
    scope: { user: "dug", agent: "full" },
  };

  // Every optional `DiscoveredAgent` field populated — this is the fixture a
  // future field silently failing to reach `AgentRegistration` must show up
  // against.
  const fullReg: DiscoveredAgent = {
    id: "full",
    name: "Full Agent",
    description: "exercises every field",
    // biome-ignore lint/suspicious/noExplicitAny: fake agent shape, kept loose to match DiscoveredAgent.agent
    agent: { role: { name: "Full" } } as any,
    file: "/agents/full/agent.ts",
    provenance: { file: "/agents/full/agent.ts", slots: [] },
    instantiate: async () => ({ role: { name: "Full" } }) as never,
    scope: fakeScope,
    instantiateDefaults: { tenant: "default-tenant" },
    contextRedactKeys: ["secret"],
    evals: [{ setId: "xd-interpret" }],
    memory: fakeMemory,
  };

  it("threads every DiscoveredAgent field into AgentRegistration, scope by identity", () => {
    const result = toAgentRegistration(fullReg, fakeRunner);
    expect(result).toEqual({
      id: "full",
      name: "Full Agent",
      description: "exercises every field",
      agent: fullReg.agent,
      file: "/agents/full/agent.ts",
      provenance: { file: "/agents/full/agent.ts", slots: [] },
      instantiate: fullReg.instantiate,
      scope: fakeScope,
      instantiateDefaults: { tenant: "default-tenant" },
      contextRedactKeys: ["secret"],
      evals: [{ setId: "xd-interpret" }],
      memory: fakeMemory,
      runner: fakeRunner,
    });
    // Not a copy — the exact scope instance must survive (the point of
    // duck-typed pass-through: no `.parse` re-implementation en route).
    expect(result.scope).toBe(fakeScope);
    // Same identity rule for memory (#444): the STORE instance the agent file
    // booted is the one the server's turn-1 recall must read.
    expect(result.memory).toBe(fakeMemory);
  });

  it("a registration declaring none of the optional fields maps to all-undefined, not dropped keys", () => {
    const bareReg: DiscoveredAgent = {
      id: "bare",
      name: "Bare Agent",
      // biome-ignore lint/suspicious/noExplicitAny: fake agent shape
      agent: { role: { name: "Bare" } } as any,
      file: "/agents/bare/agent.ts",
    };
    const result = toAgentRegistration(bareReg, fakeRunner);
    expect(result.scope).toBeUndefined();
    expect(result.instantiate).toBeUndefined();
    expect(result.instantiateDefaults).toBeUndefined();
    expect(result.contextRedactKeys).toBeUndefined();
    expect(result.evals).toBeUndefined();
    expect(result.provenance).toBeUndefined();
    expect(result.memory).toBeUndefined();
    expect(result.runner).toBe(fakeRunner);
  });
});

describe("isApiPath", () => {
  it("classifies /eval and its subpaths as API — would have failed before this change", () => {
    expect(isApiPath("/eval")).toBe(true);
    expect(isApiPath("/eval/sets")).toBe(true);
    expect(isApiPath("/eval/sets/bank/cases")).toBe(true);
    expect(isApiPath("/eval/runs/abc-123")).toBe(true);
  });

  it("does not match by substring — /evaluate is not /eval", () => {
    expect(isApiPath("/evaluate")).toBe(false);
  });

  it("leaves SPA routes alone", () => {
    expect(isApiPath("/")).toBe(false);
    expect(isApiPath("/chat")).toBe(false);
    expect(isApiPath("/tokens")).toBe(false);
  });

  it("locks the pre-existing prefixes (root + a subpath) against accidental removal", () => {
    for (const prefix of [
      "/agents",
      "/roles",
      "/capabilities",
      "/conversations",
      "/admin",
      "/health",
    ]) {
      expect(isApiPath(prefix)).toBe(true);
      expect(isApiPath(`${prefix}/sub`)).toBe(true);
    }
  });
});

describe("isHtmlNavigation", () => {
  it("recognizes a browser top-level navigation by its Accept header", () => {
    expect(
      isHtmlNavigation(
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
      ),
    ).toBe(true);
  });

  it("does not treat SPA fetch() calls as navigations", () => {
    expect(isHtmlNavigation("*/*")).toBe(false);
    expect(isHtmlNavigation("application/json")).toBe(false);
    expect(isHtmlNavigation(undefined)).toBe(false);
  });
});

describe("withHtmlNavigationShim", () => {
  const apiResponse = () =>
    new Response(JSON.stringify({ from: "api" }), {
      headers: { "content-type": "application/json" },
    });
  const api = { fetch: () => apiResponse() };

  async function withDashboardDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ap-shim-"));
    try {
      await fs.writeFile(path.join(dir, "index.html"), "<html>SPA</html>");
      await fs.writeFile(path.join(dir, "app.css"), "body{}");
      return await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

  it("answers a browser navigation to an API-colliding route from the SPA", async () => {
    await withDashboardDir(async (dir) => {
      const shim = withHtmlNavigationShim(api, dir);
      const res = await shim.fetch(
        new Request("http://x/eval/runs/abc-123", { headers: { accept: BROWSER_ACCEPT } }),
      );
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("SPA");
    });
  });

  it("passes fetch()-style requests through to the API untouched", async () => {
    await withDashboardDir(async (dir) => {
      const shim = withHtmlNavigationShim(api, dir);
      const res = await shim.fetch(
        new Request("http://x/eval/runs/abc-123", { headers: { accept: "*/*" } }),
      );
      expect(await res.json()).toEqual({ from: "api" });
    });
  });

  it("serves a literal asset over the SPA index when one exists", async () => {
    await withDashboardDir(async (dir) => {
      const shim = withHtmlNavigationShim(api, dir);
      const res = await shim.fetch(
        new Request("http://x/app.css", { headers: { accept: BROWSER_ACCEPT } }),
      );
      expect(res.headers.get("content-type")).toContain("text/css");
    });
  });

  it("falls through to the API when the SPA index is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ap-shim-empty-"));
    try {
      const shim = withHtmlNavigationShim(api, dir);
      const res = await shim.fetch(
        new Request("http://x/agents/foo", { headers: { accept: BROWSER_ACCEPT } }),
      );
      expect(await res.json()).toEqual({ from: "api" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("never intercepts non-GET requests", async () => {
    await withDashboardDir(async (dir) => {
      const shim = withHtmlNavigationShim(api, dir);
      const res = await shim.fetch(
        new Request("http://x/eval/runs", { method: "POST", headers: { accept: BROWSER_ACCEPT } }),
      );
      expect(await res.json()).toEqual({ from: "api" });
    });
  });
});
