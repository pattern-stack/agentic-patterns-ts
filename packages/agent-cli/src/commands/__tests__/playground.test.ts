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

import { describe, expect, it } from "vitest";
import { isApiPath } from "../playground.js";

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
