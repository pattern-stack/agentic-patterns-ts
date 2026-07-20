/**
 * Contract: the installed Codex CLI matches the pinned version and still
 * generates byte-identical STABLE-channel protocol schemas (#321, design §5.2/D7).
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURES, assertPreconditions } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as {
  cliVersion: string;
  minimumSupportedVersion: string;
  aggregateSha256: Record<string, string>;
};

describe("pinned CLI + stable schema fixtures", () => {
  let generated: string;

  beforeAll(() => {
    assertPreconditions();
    generated = mkdtempSync(join(tmpdir(), "codex-schema-regen-"));
    execSync(`codex app-server generate-json-schema --out ${generated}`, { stdio: "pipe" });
  });

  afterAll(() => {
    if (generated) rmSync(generated, { recursive: true, force: true });
  });

  it("installed CLI is the pinned version", () => {
    const version = execSync("codex --version").toString().trim();
    expect(version).toBe(manifest.cliVersion);
  });

  it("regenerated stable schemas match the committed fixtures byte-for-byte", () => {
    const fixtureDir = join(FIXTURES, "schema-stable");
    const fixtureFiles = readdirSync(fixtureDir).filter((f) => f.endsWith(".json"));
    expect(fixtureFiles.length).toBeGreaterThan(30);
    for (const file of fixtureFiles) {
      const fixture = readFileSync(join(fixtureDir, file), "utf8");
      const fresh = readFileSync(join(generated, file), "utf8");
      expect(fresh, `schema drift in ${file}`).toBe(fixture);
    }
  });

  it("aggregate bundle hashes match the manifest (v2 bundle excluded — nondeterministic)", () => {
    // codex_app_server_protocol.v2.schemas.json varies between generator runs
    // in 0.144.6 (definition inclusion is unstable), so it is deliberately NOT
    // pinned — the per-type root files are the deterministic fixture of record.
    expect(Object.keys(manifest.aggregateSha256)).toEqual([
      "codex_app_server_protocol.schemas.json",
    ]);
    for (const [file, expected] of Object.entries(manifest.aggregateSha256)) {
      const digest = createHash("sha256")
        .update(readFileSync(join(generated, file)))
        .digest("hex");
      expect(digest, `aggregate schema drift in ${file}`).toBe(expected);
    }
  });

  it("stable command-approval schema has NO availableDecisions (experimental-only field)", () => {
    // Design §5.5 said availableDecisions is "carried on the request". Reality:
    // it IS emitted on the wire, but it is an EXPERIMENTAL schema field — the
    // stable contract does not include it. See r1-codex-contract.md.
    const schema = JSON.parse(
      readFileSync(
        join(FIXTURES, "schema-stable", "CommandExecutionRequestApprovalParams.json"),
        "utf8",
      ),
    ) as { properties: Record<string, unknown> };
    expect(schema.properties.availableDecisions).toBeUndefined();
    expect(schema.properties.proposedExecpolicyAmendment).toBeDefined();
    expect(schema.properties.proposedNetworkPolicyAmendments).toBeDefined();
  });

  it("command-approval decision vocabulary matches design §5.5", () => {
    const schema = JSON.parse(
      readFileSync(
        join(FIXTURES, "schema-stable", "CommandExecutionRequestApprovalResponse.json"),
        "utf8",
      ),
    ) as {
      definitions: { CommandExecutionApprovalDecision: { oneOf: Array<Record<string, unknown>> } };
    };
    const variants = schema.definitions.CommandExecutionApprovalDecision.oneOf.map((v) => {
      if (v.enum) return (v.enum as string[])[0];
      return Object.keys((v.properties ?? {}) as Record<string, unknown>)[0];
    });
    expect(variants).toEqual([
      "accept",
      "acceptForSession",
      "acceptWithExecpolicyAmendment",
      "applyNetworkPolicyAmendment",
      "decline",
      "cancel",
    ]);
  });

  it("file-change decision vocabulary is the smaller set (no amendments)", () => {
    const schema = JSON.parse(
      readFileSync(
        join(FIXTURES, "schema-stable", "FileChangeRequestApprovalResponse.json"),
        "utf8",
      ),
    ) as { definitions: { FileChangeApprovalDecision: { oneOf: Array<{ enum?: string[] }> } } };
    const variants = schema.definitions.FileChangeApprovalDecision.oneOf.map((v) => v.enum?.[0]);
    expect(variants).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
  });

  it("server-initiated request methods are the pinned set", () => {
    const schema = JSON.parse(
      readFileSync(join(FIXTURES, "schema-stable", "ServerRequest.json"), "utf8"),
    ) as {
      oneOf: Array<{ properties?: { method?: { enum?: string[] } } }>;
    };
    const methods = schema.oneOf.map((v) => v.properties?.method?.enum?.[0]).filter(Boolean);
    expect(methods).toEqual([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
      "item/permissions/requestApproval",
      "item/tool/call",
      "account/chatgptAuthTokens/refresh",
      "attestation/generate",
      "applyPatchApproval",
      "execCommandApproval",
    ]);
  });
});
