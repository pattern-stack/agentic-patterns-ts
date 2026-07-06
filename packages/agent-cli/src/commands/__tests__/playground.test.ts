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
import { describe, expect, it } from "vitest";
import { isApiPath, isHtmlNavigation, withHtmlNavigationShim } from "../playground.js";

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
