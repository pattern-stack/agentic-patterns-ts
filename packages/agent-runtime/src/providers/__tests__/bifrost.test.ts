/**
 * Pure unit tests for the Bifrost naming module — no network, no fetch stub.
 * Header-wire-shape tests (against a real HybridModelResolver + stubbed
 * fetch) live in `model-resolver.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  BIFROST_DIM_PREFIX,
  BIFROST_GUARDRAILS_HEADER,
  BIFROST_VK_HEADER,
  REQUEST_ID_HEADER,
  bifrostCorrelationHeaders,
  bifrostRunHeaders,
  sanitizeHeaderKey,
  sanitizeHeaderValue,
} from "../bifrost.js";

describe("sanitizeHeaderValue", () => {
  it("passes printable ASCII through untouched", () => {
    expect(sanitizeHeaderValue("planner-agent")).toBe("planner-agent");
  });

  it("replaces non-printable-ASCII chars with -", () => {
    expect(sanitizeHeaderValue("plañner ünïcode")).toBe("pla-ner -n-code");
  });

  it("collapses runs of dashes", () => {
    expect(sanitizeHeaderValue("a\n\n\nb")).toBe("a-b");
  });

  it("trims leading/trailing dashes produced by sanitization", () => {
    // \u0001 (a control char) sanitizes to "-" at each end; assert the trim
    // branch actually strips those (the runs-collapse test above never
    // exercises ^-+|-+$ since its dashes never land at the edges).
    expect(sanitizeHeaderValue("\u0001leading and trailing\u0001")).toBe("leading and trailing");
  });

  it("caps at 128 chars", () => {
    expect(sanitizeHeaderValue("x".repeat(200))).toHaveLength(128);
  });

  it("is deterministic", () => {
    const input = "same input, twice";
    expect(sanitizeHeaderValue(input)).toBe(sanitizeHeaderValue(input));
  });
});

describe("bifrostCorrelationHeaders", () => {
  const base = {
    runId: "run-1",
    traceId: "run-1",
    agentName: "planner",
    modelId: "m",
    modelProvider: "",
  };

  it("returns {} for a direct (non-gateway) provider", () => {
    expect(bifrostCorrelationHeaders({ ...base, modelProvider: "anthropic.messages" })).toEqual({});
  });

  it("returns the full dim set for a gateway-built model", () => {
    const headers = bifrostCorrelationHeaders({ ...base, modelProvider: "gateway.chat" });
    expect(headers[REQUEST_ID_HEADER]).toBe("run-1");
    expect(headers[`${BIFROST_DIM_PREFIX}agent`]).toBe("planner");
    expect(headers[`${BIFROST_DIM_PREFIX}run`]).toBe("run-1");
  });

  it("omits x-bf-dim-trace when traceId === runId", () => {
    const headers = bifrostCorrelationHeaders({ ...base, modelProvider: "gateway.chat" });
    expect(headers[`${BIFROST_DIM_PREFIX}trace`]).toBeUndefined();
  });

  it("includes x-bf-dim-trace when traceId differs from runId", () => {
    const headers = bifrostCorrelationHeaders({
      ...base,
      traceId: "trace-parent",
      modelProvider: "gateway.chat",
    });
    expect(headers[`${BIFROST_DIM_PREFIX}trace`]).toBe("trace-parent");
  });

  it("sanitizes an agent name with spaces/unicode", () => {
    const headers = bifrostCorrelationHeaders({
      ...base,
      agentName: "plañner ünïcode",
      modelProvider: "gateway.chat",
    });
    expect(headers[`${BIFROST_DIM_PREFIX}agent`]).toBe("pla-ner -n-code");
  });

  it("gates on any provider starting with 'gateway.', not just 'gateway.chat' exactly", () => {
    expect(bifrostCorrelationHeaders({ ...base, modelProvider: "gateway.completion" })).not.toEqual(
      {},
    );
  });

  it("does NOT gate in on a bare 'gateway' or a same-prefix-but-different provider", () => {
    expect(bifrostCorrelationHeaders({ ...base, modelProvider: "gateway" })).toEqual({});
    expect(bifrostCorrelationHeaders({ ...base, modelProvider: "gatewayx.chat" })).toEqual({});
  });
});

describe("bifrostRunHeaders", () => {
  it("returns {} for empty input", () => {
    expect(bifrostRunHeaders({})).toEqual({});
  });

  it("joins guardrail ids with a comma", () => {
    expect(bifrostRunHeaders({ guardrailIds: ["pii-strict", "secrets"] })).toEqual({
      [BIFROST_GUARDRAILS_HEADER]: "pii-strict,secrets",
    });
  });

  it("omits the guardrails header when guardrailIds is empty", () => {
    expect(bifrostRunHeaders({ guardrailIds: [] })).toEqual({});
  });

  it("prefixes each dims key with x-bf-dim- and sanitizes the value", () => {
    expect(bifrostRunHeaders({ dims: { customer: "acme ünïcode" } })).toEqual({
      [`${BIFROST_DIM_PREFIX}customer`]: "acme -n-code",
    });
  });

  it("composes guardrails + dims together", () => {
    expect(bifrostRunHeaders({ guardrailIds: ["a", "b"], dims: { customer: "acme" } })).toEqual({
      [BIFROST_GUARDRAILS_HEADER]: "a,b",
      [`${BIFROST_DIM_PREFIX}customer`]: "acme",
    });
  });

  it("sanitizes an invalid dims KEY instead of throwing at fetch time", () => {
    // A raw space/colon/unicode in a header NAME (not just a value) makes
    // Headers/fetch throw a TypeError — this is the caller-supplied-key path,
    // so it must never reach the wire unsanitized.
    expect(() => bifrostRunHeaders({ dims: { "customer id: ünïcode": "acme" } })).not.toThrow();
    expect(bifrostRunHeaders({ dims: { "customer id: ünïcode": "acme" } })).toEqual({
      [`${BIFROST_DIM_PREFIX}customer-id-n-code`]: "acme",
    });
  });

  it("lowercases a mixed-case dims key", () => {
    expect(bifrostRunHeaders({ dims: { Customer: "acme" } })).toEqual({
      [`${BIFROST_DIM_PREFIX}customer`]: "acme",
    });
  });
});

describe("sanitizeHeaderKey", () => {
  it("passes a lowercase alphanumeric-dash key through untouched", () => {
    expect(sanitizeHeaderKey("customer-id")).toBe("customer-id");
  });

  it("lowercases mixed-case input", () => {
    expect(sanitizeHeaderKey("Customer-ID")).toBe("customer-id");
  });

  it("replaces anything outside [a-z0-9-] with -, including spaces/colons/unicode", () => {
    expect(sanitizeHeaderKey("customer id: ünïcode")).toBe("customer-id-n-code");
  });

  it("collapses runs of dashes and trims leading/trailing dashes", () => {
    expect(sanitizeHeaderKey(" :: customer :: ")).toBe("customer");
  });

  it("caps at 128 chars", () => {
    expect(sanitizeHeaderKey("x".repeat(200))).toHaveLength(128);
  });

  it("is deterministic", () => {
    const input = "Same Input, Twice";
    expect(sanitizeHeaderKey(input)).toBe(sanitizeHeaderKey(input));
  });
});

describe("header name constants", () => {
  it("match the Bifrost wire contract", () => {
    expect(BIFROST_VK_HEADER).toBe("x-bf-vk");
    expect(BIFROST_GUARDRAILS_HEADER).toBe("x-bf-guardrail-ids");
    expect(BIFROST_DIM_PREFIX).toBe("x-bf-dim-");
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });
});
