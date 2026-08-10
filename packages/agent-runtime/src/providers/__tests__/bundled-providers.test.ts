/**
 * Packaging contract for the bundled providers (#472).
 *
 * The bug: `@agentic-patterns/runtime` imported every `@ai-sdk/*` provider
 * dynamically and shipped none, so a consumer who installed the runtime and set
 * a provider key still could not construct a model — and, because
 * `ClaudeCodeAPIRunner` has no read site for `options.messageHistory`, the
 * degraded path silently dropped conversation history.
 *
 * The fix has two halves. This file guards the packaging half: the providers a
 * `ProviderProtocol` advertises as `bundled` must genuinely be `dependencies` of
 * `@agentic-patterns/runtime` — not devDependencies, not peerDependencies, not
 * an aspiration in a comment. A test, because a comment cannot fail CI.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BUNDLED_PROVIDERS,
  BUNDLED_PROVIDER_ENV_VARS,
  PROVIDERS,
  PROVIDER_PRIORITY,
  type SupportedProvider,
} from "../index.js";

const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** The three providers Doug scoped for the first pass (#472). */
const SCOPED: readonly SupportedProvider[] = ["anthropic", "openai", "google"];

describe("bundled providers — packaging contract (#472)", () => {
  it("is the runtime package we think it is", () => {
    expect(pkg.name).toBe("@agentic-patterns/runtime");
  });

  it.each(SCOPED)("%s is marked bundled", (name) => {
    expect(PROVIDERS[name].bundled).toBe(true);
  });

  it.each(SCOPED)("%s's package is a real dependency of the runtime", (name) => {
    const { packageName } = PROVIDERS[name];
    expect(Object.keys(pkg.dependencies ?? {})).toContain(packageName);
  });

  it.each(SCOPED)("%s's package is NOT relegated to devDependencies", (name) => {
    // A devDependency makes the workspace tests pass while every published
    // consumer still gets nothing — the exact shape of the original defect.
    const { packageName } = PROVIDERS[name];
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain(packageName);
  });

  it.each(SCOPED)("%s's package is NOT an (optional) peerDependency", (name) => {
    // An optional peer is silently absent by default — same silent degradation.
    const { packageName } = PROVIDERS[name];
    expect(Object.keys(pkg.peerDependencies ?? {})).not.toContain(packageName);
  });

  it("every provider flagged `bundled` really is in dependencies", () => {
    const deps = Object.keys(pkg.dependencies ?? {});
    const lying = BUNDLED_PROVIDERS.filter((n) => !deps.includes(PROVIDERS[n].packageName));
    expect(lying).toEqual([]);
  });

  it("no provider flagged NOT bundled is secretly in dependencies", () => {
    // Keeps the flag honest in the other direction: a package that quietly
    // becomes a dependency must also become `bundled: true`, or the error copy
    // will tell users to install something they already have.
    const deps = Object.keys(pkg.dependencies ?? {});
    const understated = PROVIDER_PRIORITY.filter(
      (n) => !PROVIDERS[n].bundled && deps.includes(PROVIDERS[n].packageName),
    );
    expect(understated).toEqual([]);
  });

  it("every adapter declares the package its load() actually imports", () => {
    for (const name of PROVIDER_PRIORITY) {
      expect(PROVIDERS[name].packageName, `${name}.packageName`).toMatch(/^[@a-z]/);
    }
  });

  it("advertises exactly one primary env var per bundled provider", () => {
    expect(BUNDLED_PROVIDER_ENV_VARS).toEqual(
      BUNDLED_PROVIDERS.map((n) => PROVIDERS[n].envVars[0]),
    );
    // The three scoped providers must be reachable via the advertised copy.
    expect(BUNDLED_PROVIDER_ENV_VARS).toContain("ANTHROPIC_API_KEY");
    expect(BUNDLED_PROVIDER_ENV_VARS).toContain("OPENAI_API_KEY");
    expect(BUNDLED_PROVIDER_ENV_VARS).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
  });

  it.each(SCOPED)("%s.load() really builds a model, offline, unstubbed", async (name) => {
    // Not a stub: this is the "install one package and it works" claim itself.
    // Loading an @ai-sdk provider and constructing a model makes no network
    // call and reads no credential — both are deferred to request time — so it
    // holds with no keys and no connectivity.
    const model = await PROVIDERS[name].load(PROVIDERS[name].tiers.haiku);
    expect(model).toBeTruthy();
    expect(model.modelId).toBe(PROVIDERS[name].tiers.haiku);
  });
});
