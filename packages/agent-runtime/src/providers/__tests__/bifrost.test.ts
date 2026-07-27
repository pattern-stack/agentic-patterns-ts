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
    expect(sanitizeHeaderValue("leading and trailing")).toBe("leading and trailing");
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

  it("gates on any provider starting with 'gateway', not just 'gateway.chat' exactly", () => {
    expect(bifrostCorrelationHeaders({ ...base, modelProvider: "gateway.completion" })).not.toEqual(
      {},
    );
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
});

describe("header name constants", () => {
  it("match the Bifrost wire contract", () => {
    expect(BIFROST_VK_HEADER).toBe("x-bf-vk");
    expect(BIFROST_GUARDRAILS_HEADER).toBe("x-bf-guardrail-ids");
    expect(BIFROST_DIM_PREFIX).toBe("x-bf-dim-");
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });
});
