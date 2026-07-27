/**
 * Env-loading tests for the project-config helper: the `.env.local` over
 * `.env` layering, first-wins precedence against a real `process.env`, and the
 * unresolved-secret-reference guard that keeps `secret://` / `op://` strings
 * from masquerading as credentials.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../config.js";

/** Keys these tests write; cleared before and after each case. */
const KEYS = [
  "AP_TEST_PLAIN",
  "AP_TEST_LAYERED",
  "AP_TEST_PREEXISTING",
  "AP_TEST_SECRET_REF",
  "AP_TEST_OP_REF",
  "AP_TEST_QUOTED",
];

let root: string;

function clearKeys(): void {
  for (const k of KEYS) delete process.env[k];
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-env-"));
  clearKeys();
});

afterEach(() => {
  clearKeys();
  fs.rmSync(root, { recursive: true, force: true });
});

function write(name: string, body: string): void {
  fs.writeFileSync(path.join(root, name), body);
}

describe("loadDotEnv", () => {
  it("is a no-op when neither file exists", () => {
    expect(() => loadDotEnv(root)).not.toThrow();
    expect(process.env.AP_TEST_PLAIN).toBeUndefined();
  });

  it("parses .env, skipping comments, blanks, and lines without '='", () => {
    write(".env", "# a comment\n\nAP_TEST_PLAIN=hello\nnot-an-assignment\n");
    loadDotEnv(root);
    expect(process.env.AP_TEST_PLAIN).toBe("hello");
  });

  it("strips surrounding quotes from values", () => {
    write(".env", 'AP_TEST_QUOTED="quoted value"\n');
    loadDotEnv(root);
    expect(process.env.AP_TEST_QUOTED).toBe("quoted value");
  });

  it("lets .env.local win over .env", () => {
    write(".env", "AP_TEST_LAYERED=from-env\n");
    write(".env.local", "AP_TEST_LAYERED=from-env-local\n");
    loadDotEnv(root);
    expect(process.env.AP_TEST_LAYERED).toBe("from-env-local");
  });

  it("still loads .env-only keys when .env.local exists", () => {
    write(".env", "AP_TEST_PLAIN=hello\n");
    write(".env.local", "AP_TEST_LAYERED=from-env-local\n");
    loadDotEnv(root);
    expect(process.env.AP_TEST_PLAIN).toBe("hello");
    expect(process.env.AP_TEST_LAYERED).toBe("from-env-local");
  });

  it("never overwrites a value already in process.env", () => {
    process.env.AP_TEST_PREEXISTING = "from-shell";
    write(".env", "AP_TEST_PREEXISTING=from-env\n");
    write(".env.local", "AP_TEST_PREEXISTING=from-env-local\n");
    loadDotEnv(root);
    expect(process.env.AP_TEST_PREEXISTING).toBe("from-shell");
  });

  it("skips unresolved secret:// and op:// references", () => {
    write(
      ".env",
      "AP_TEST_SECRET_REF=secret://AP_TEST_SECRET_REF\n" +
        "AP_TEST_OP_REF=op://vault/item/password\n",
    );
    loadDotEnv(root);
    // Unset, not empty: a non-empty placeholder would satisfy credential
    // preflight and fail later against the provider.
    expect(process.env.AP_TEST_SECRET_REF).toBeUndefined();
    expect(process.env.AP_TEST_OP_REF).toBeUndefined();
  });

  it("prefers a resolved .env.local value over a .env reference", () => {
    write(".env", "AP_TEST_SECRET_REF=secret://AP_TEST_SECRET_REF\n");
    write(".env.local", "AP_TEST_SECRET_REF=sk-resolved\n");
    loadDotEnv(root);
    expect(process.env.AP_TEST_SECRET_REF).toBe("sk-resolved");
  });

  it("is idempotent across repeated calls", () => {
    write(".env", "AP_TEST_PLAIN=hello\n");
    loadDotEnv(root);
    loadDotEnv(root);
    expect(process.env.AP_TEST_PLAIN).toBe("hello");
  });
});
