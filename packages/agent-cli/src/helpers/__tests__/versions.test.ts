/**
 * Version-helper tests — the pure, network-free logic behind `ap update` and
 * the out-of-date notifier: semver comparison, behind-detection, dependency
 * discovery, and package-manager inference. `fetchLatest`/`notifyIfOutdated`
 * (network + stderr) are covered by the live CLI, not here.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectApDeps,
  compareSemver,
  detectPackageManager,
  installLatestArgv,
  isBehind,
  readInstalledVersion,
  readSelfVersion,
} from "../versions.js";

describe("compareSemver", () => {
  it("orders major.minor.patch", () => {
    expect(compareSemver("0.8.0", "0.9.0")).toBe(-1);
    expect(compareSemver("0.9.0", "0.8.0")).toBe(1);
    expect(compareSemver("0.6.0", "0.6.0")).toBe(0);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.9.10", "0.9.2")).toBe(1); // numeric, not lexical
  });

  it("strips leading range operators and prerelease tags", () => {
    expect(compareSemver("^0.8.0", "0.8.0")).toBe(0);
    expect(compareSemver("v0.9.0", "0.9.0")).toBe(0);
    expect(compareSemver("0.9.0-rc.1", "0.9.0")).toBe(0); // prerelease ignored
  });
});

describe("isBehind", () => {
  it("is true only when installed < latest and both are known", () => {
    expect(isBehind("0.8.0", "0.9.0")).toBe(true);
    expect(isBehind("0.9.0", "0.9.0")).toBe(false);
    expect(isBehind("0.9.0", "0.8.0")).toBe(false);
    expect(isBehind(null, "0.9.0")).toBe(false); // unknown installed → not behind
    expect(isBehind("0.8.0", null)).toBe(false); // offline → not behind
  });
});

describe("installLatestArgv", () => {
  it("uses add for bun/pnpm/yarn and install for npm", () => {
    expect(installLatestArgv("bun", ["a@1"])).toEqual(["add", "a@1"]);
    expect(installLatestArgv("pnpm", ["a@1"])).toEqual(["add", "a@1"]);
    expect(installLatestArgv("yarn", ["a@1"])).toEqual(["add", "a@1"]);
    expect(installLatestArgv("npm", ["a@1"])).toEqual(["install", "a@1"]);
  });
});

describe("fs-backed helpers", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-versions-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("collectApDeps returns only @pattern-stack/agentic-* deps (deps + devDeps), sorted", () => {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        dependencies: { "@pattern-stack/agentic-runtime": "^0.9.0", zod: "^3.0.0" },
        devDependencies: { "@pattern-stack/agentic-cli": "^0.7.0" },
      }),
    );
    expect(collectApDeps(dir)).toEqual([
      { name: "@pattern-stack/agentic-cli", range: "^0.7.0" },
      { name: "@pattern-stack/agentic-runtime", range: "^0.9.0" },
    ]);
  });

  it("collectApDeps is empty when there is no package.json or no AP deps", () => {
    expect(collectApDeps(dir)).toEqual([]); // no package.json
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { zod: "^3" } }),
    );
    expect(collectApDeps(dir)).toEqual([]);
  });

  it("readInstalledVersion reads node_modules/<pkg>/package.json", () => {
    const pkgDir = path.join(dir, "node_modules", "@pattern-stack", "agentic-runtime");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version: "0.9.0" }));
    expect(readInstalledVersion(dir, "@pattern-stack/agentic-runtime")).toBe("0.9.0");
    expect(readInstalledVersion(dir, "@pattern-stack/agentic-absent")).toBeNull();
  });

  it("readSelfVersion walks UP from a nested dir to the nearest package.json", () => {
    // dist/cli.js → ../package.json, and src/**/x → the package root: both resolve.
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const nested = path.join(dir, "dist", "chunks");
    fs.mkdirSync(nested, { recursive: true });
    expect(readSelfVersion(nested)).toBe("1.2.3");
    expect(readSelfVersion(dir)).toBe("1.2.3");
  });

  it("readSelfVersion returns null when no package.json is found upward", () => {
    // A fresh temp dir with no package.json anywhere up to the walk cap.
    const orphan = path.join(dir, "a", "b", "c");
    fs.mkdirSync(orphan, { recursive: true });
    // No package.json written → null (the walk cap stops it; tmp has none nearby).
    expect(readSelfVersion(orphan)).toBeNull();
  });

  it("detectPackageManager infers from the lockfile", () => {
    expect(detectPackageManager(dir)).toBe("npm"); // default, no lockfile
    fs.writeFileSync(path.join(dir, "bun.lock"), "");
    expect(detectPackageManager(dir)).toBe("bun");
  });

  it("detectPackageManager walks UP to the workspace-root lockfile", () => {
    // The lockfile lives at the repo root; `ap update` runs in a package dir
    // below it (apps/backend). A single-dir check would miss it → wrong npm.
    fs.writeFileSync(path.join(dir, "bun.lock"), "");
    const pkgDir = path.join(dir, "apps", "backend");
    fs.mkdirSync(pkgDir, { recursive: true });
    expect(detectPackageManager(pkgDir)).toBe("bun");
  });

  it("detectPackageManager lets the NEAREST lockfile win over an ancestor", () => {
    fs.writeFileSync(path.join(dir, "bun.lock"), ""); // workspace root: bun
    const pkgDir = path.join(dir, "packages", "standalone");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package-lock.json"), "{}"); // own npm lock
    expect(detectPackageManager(pkgDir)).toBe("npm");
  });
});
