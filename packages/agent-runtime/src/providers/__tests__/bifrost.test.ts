/**
 * Pure unit tests for the Bifrost naming module — no network, no fetch stub.
 * Header-wire-shape tests (against a real HybridModelResolver + stubbed
 * fetch) live in `model-resolver.test.ts`.
 */

import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";
import { describe, expect, it } from "vitest";

import {
  BIFROST_DIM_PREFIX,
  BIFROST_GUARDRAILS_HEADER,
  BIFROST_VK_HEADER,
  BifrostError,
  BifrostGuardrailViolationError,
  BifrostProviderBlockedError,
  BifrostVirtualKeyBlockedError,
  BifrostVirtualKeyRequiredError,
  MAX_ERROR_MESSAGE_LENGTH,
  REDACTION_PLACEHOLDER_PATTERN,
  REQUEST_ID_HEADER,
  attributionFromProviderMetadata,
  bifrostCorrelationHeaders,
  bifrostMetadataExtractor,
  bifrostRunHeaders,
  classifyBifrostError,
  hasBifrostRedactionMetadata,
  sanitizeHeaderKey,
  sanitizeHeaderValue,
  scanRedactionPlaceholders,
  truncateMessage,
  violationSummaryMessage,
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

// ---------------------------------------------------------------------------
// classifyBifrostError (#407)
// ---------------------------------------------------------------------------

/** Build an `APICallError` the way the SDK does: `responseBody` is the raw
 *  JSON string; `data` (the parsed-and-schema-stripped shape) is deliberately
 *  NOT populated here — fact 2, classification must parse `responseBody`. */
function apiCallError(opts: {
  statusCode: number;
  responseBody: string;
  message?: string;
}): APICallError {
  return new APICallError({
    message: opts.message ?? "API call failed",
    url: "https://gw.example/v1/chat/completions",
    requestBodyValues: {},
    statusCode: opts.statusCode,
    responseBody: opts.responseBody,
    isRetryable: false,
  });
}

// Live-captured wire shapes (issue #406, 2026-07-27; virtual_key_blocked
// 2026-07-29 — see spec 407 § Verified SDK + wire facts, fact 8).
const LIVE_401_BODY = JSON.stringify({
  type: "virtual_key_required",
  is_bifrost_error: false,
  status_code: 401,
  error: { message: "virtual key is required. Provide a virtual key via the x-bf-vk header." },
});
const LIVE_403_PROVIDER_BLOCKED_BODY = JSON.stringify({
  type: "provider_blocked",
  is_bifrost_error: false,
  status_code: 403,
  error: { message: "Provider 'gemini' is not allowed for this virtual key" },
  extra_fields: {
    provider: "gemini",
    original_model_requested: "gemini-pro",
    resolved_model_used: "gemini-pro",
    request_type: "chat_completion",
  },
});
const LIVE_403_VK_BLOCKED_BODY = JSON.stringify({
  type: "virtual_key_blocked",
  is_bifrost_error: false,
  status_code: 403,
  error: { message: "Virtual key has expired" },
  extra_fields: {
    routing_info: {},
    provider: "openai",
    original_model_requested: "gpt-4o-mini",
    resolved_model_used: "gpt-4o-mini",
    request_type: "chat_completion",
  },
});
// PROVISIONAL fixture (docs-derived, not live-captured — see spec 407
// § Provisional-shape discipline).
const PROVISIONAL_446_BODY = JSON.stringify({
  type: "guardrail_violation",
  is_bifrost_error: true,
  status_code: 446,
  error: {
    message: "Request blocked by guardrail: pii-strict",
    guardrail_id: "pii-strict",
    category: "pii",
    severity: "high",
    action: "block",
  },
});

describe("classifyBifrostError", () => {
  it("401 virtual_key_required → BifrostVirtualKeyRequiredError (live-captured)", () => {
    const e = apiCallError({ statusCode: 401, responseBody: LIVE_401_BODY });
    const classified = classifyBifrostError(e);
    expect(classified).toBeInstanceOf(BifrostVirtualKeyRequiredError);
    expect(classified?.statusCode).toBe(401);
    expect(classified?.message).toBe(
      "virtual key is required. Provide a virtual key via the x-bf-vk header.",
    );
    expect(classified?.cause).toBe(e);
  });

  it("403 provider_blocked → BifrostProviderBlockedError with extra_fields attribution (live-captured)", () => {
    const e = apiCallError({ statusCode: 403, responseBody: LIVE_403_PROVIDER_BLOCKED_BODY });
    const classified = classifyBifrostError(e);
    expect(classified).toBeInstanceOf(BifrostProviderBlockedError);
    expect(classified?.statusCode).toBe(403);
    expect(classified?.message).toBe("Provider 'gemini' is not allowed for this virtual key");
    expect(classified?.provider).toBe("gemini");
    expect(classified?.originalModelRequested).toBe("gemini-pro");
    expect(classified?.resolvedModelUsed).toBe("gemini-pro");
  });

  it("403 virtual_key_blocked → BifrostVirtualKeyBlockedError (live-captured 2026-07-29)", () => {
    const e = apiCallError({ statusCode: 403, responseBody: LIVE_403_VK_BLOCKED_BODY });
    const classified = classifyBifrostError(e);
    expect(classified).toBeInstanceOf(BifrostVirtualKeyBlockedError);
    expect(classified).not.toBeInstanceOf(BifrostProviderBlockedError);
    expect(classified?.statusCode).toBe(403);
    expect(classified?.message).toBe("Virtual key has expired");
    expect(classified?.provider).toBe("openai");
  });

  it("446 guardrail_violation → BifrostGuardrailViolationError with detail fields — PROVISIONAL fixture (docs-derived)", () => {
    const e = apiCallError({ statusCode: 446, responseBody: PROVISIONAL_446_BODY });
    const classified = classifyBifrostError(e);
    expect(classified).toBeInstanceOf(BifrostGuardrailViolationError);
    const violation = classified as BifrostGuardrailViolationError;
    expect(violation.statusCode).toBe(446);
    expect(violation.guardrailId).toBe("pii-strict");
    expect(violation.category).toBe("pii");
    expect(violation.severity).toBe("high");
    expect(violation.action).toBe("block");
  });

  it("statusCode 446 alone (no recognized error.type) still classifies as a guardrail violation — PROVISIONAL", () => {
    const body = JSON.stringify({ status_code: 446, error: { message: "blocked" } });
    const e = apiCallError({ statusCode: 446, responseBody: body });
    expect(classifyBifrostError(e)).toBeInstanceOf(BifrostGuardrailViolationError);
  });

  it("guardrail detail absent (shape drift) still classifies successfully — PROVISIONAL fields are all optional", () => {
    const body = JSON.stringify({ type: "guardrail_violation", error: { message: "blocked" } });
    const e = apiCallError({ statusCode: 446, responseBody: body });
    const classified = classifyBifrostError(e);
    expect(classified).toBeInstanceOf(BifrostGuardrailViolationError);
    const violation = classified as BifrostGuardrailViolationError;
    expect(violation.guardrailId).toBeUndefined();
  });

  it("unwraps RetryError.lastError before classifying (fact 5, multi-attempt shape)", () => {
    const inner = apiCallError({ statusCode: 401, responseBody: LIVE_401_BODY });
    const retryErr = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [inner, inner, inner],
    });
    const classified = classifyBifrostError(retryErr);
    expect(classified).toBeInstanceOf(BifrostVirtualKeyRequiredError);
    expect(classified?.cause).toBe(inner);
  });

  it("APICallError with non-JSON responseBody → undefined", () => {
    const e = apiCallError({ statusCode: 500, responseBody: "not json" });
    expect(classifyBifrostError(e)).toBeUndefined();
  });

  it("APICallError with non-Bifrost JSON body → undefined (regression guard: generic gateway errors untouched)", () => {
    const body = JSON.stringify({ error: { message: "rate limited" } });
    const e = apiCallError({ statusCode: 429, responseBody: body });
    expect(classifyBifrostError(e)).toBeUndefined();
  });

  it("plain Error → undefined", () => {
    expect(classifyBifrostError(new Error("boom"))).toBeUndefined();
  });

  it("non-error value → undefined (never throws)", () => {
    expect(() => classifyBifrostError("boom")).not.toThrow();
    expect(classifyBifrostError("boom")).toBeUndefined();
    expect(classifyBifrostError(undefined)).toBeUndefined();
    expect(classifyBifrostError(null)).toBeUndefined();
  });

  it("base BifrostError for is_bifrost_error:true with an unrecognized type", () => {
    const body = JSON.stringify({
      type: "something_new",
      is_bifrost_error: true,
      status_code: 418,
    });
    const e = apiCallError({ statusCode: 418, responseBody: body });
    const classified = classifyBifrostError(e);
    expect(classified).toBeInstanceOf(BifrostError);
    expect(classified).not.toBeInstanceOf(BifrostVirtualKeyRequiredError);
    expect(classified).not.toBeInstanceOf(BifrostProviderBlockedError);
    expect(classified).not.toBeInstanceOf(BifrostGuardrailViolationError);
  });
});

// ---------------------------------------------------------------------------
// truncateMessage / violationSummaryMessage (#407 Gate 2.5 quality fix round)
// ---------------------------------------------------------------------------

describe("truncateMessage", () => {
  it("passes a short message through unchanged", () => {
    expect(truncateMessage("Virtual key has expired")).toBe("Virtual key has expired");
  });

  it("caps at MAX_ERROR_MESSAGE_LENGTH and marks truncation explicitly", () => {
    const long = "x".repeat(MAX_ERROR_MESSAGE_LENGTH + 50);
    const truncated = truncateMessage(long);
    expect(truncated.startsWith("x".repeat(MAX_ERROR_MESSAGE_LENGTH))).toBe(true);
    expect(truncated).toContain("[truncated]");
    expect(truncated.length).toBeLessThan(long.length);
  });

  it("respects a custom cap", () => {
    expect(truncateMessage("hello world", 5)).toBe("hello… [truncated]");
  });
});

describe("violationSummaryMessage", () => {
  it("prefers a structured summary over the raw message when detail fields are present", () => {
    const err = new BifrostGuardrailViolationError("Request blocked by guardrail: pii-strict", {
      statusCode: 446,
      envelope: {},
      cause: new Error("cause"),
      guardrailId: "pii-strict",
      category: "pii",
      severity: "high",
    });
    const summary = violationSummaryMessage(err);
    expect(summary).toBeDefined();
    expect(summary).toContain("pii");
    expect(summary).toContain("high");
    expect(summary).toContain("pii-strict");
    // Never the raw provider text — the trust-boundary point of this helper.
    expect(summary).not.toBe(err.message);
  });

  it("returns undefined when no structured detail field is present (shape drift) — caller falls back to the capped raw message", () => {
    const err = new BifrostGuardrailViolationError("blocked", {
      statusCode: 446,
      envelope: {},
      cause: new Error("cause"),
    });
    expect(violationSummaryMessage(err)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// scanRedactionPlaceholders (#407)
// ---------------------------------------------------------------------------

describe("scanRedactionPlaceholders", () => {
  it("counts placeholders by entity type", () => {
    expect(scanRedactionPlaceholders("[EMAIL-1] x [EMAIL-2] [PHONE_NUMBER-1]")).toEqual({
      EMAIL: 2,
      PHONE_NUMBER: 1,
    });
  });

  it("returns undefined when there's no match", () => {
    expect(scanRedactionPlaceholders("plain text, nothing redacted")).toBeUndefined();
  });

  it("ignores lowercase markdown-style refs like [link-1]", () => {
    expect(scanRedactionPlaceholders("see [link-1] for details")).toBeUndefined();
  });

  it("is callable repeatedly without lastIndex state leaking across calls", () => {
    const text = "[EMAIL-1]";
    expect(scanRedactionPlaceholders(text)).toEqual({ EMAIL: 1 });
    expect(scanRedactionPlaceholders(text)).toEqual({ EMAIL: 1 });
  });

  it("documents the false-positive caveat: matches legitimate uppercase citations too", () => {
    // Permissive by design (spec 407 § Open question 1) — the caller must not
    // treat a raw hit as confirmed PII (see hasBifrostRedactionMetadata).
    expect(scanRedactionPlaceholders("See [RFC-2119] and [ISSUE-407].")).toEqual({
      RFC: 1,
      ISSUE: 1,
    });
  });

  it("REDACTION_PLACEHOLDER_PATTERN is a global regex (source used to build a fresh instance each call)", () => {
    expect(REDACTION_PLACEHOLDER_PATTERN.global).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bifrostMetadataExtractor / attributionFromProviderMetadata /
// hasBifrostRedactionMetadata (#407)
// ---------------------------------------------------------------------------

describe("bifrostMetadataExtractor", () => {
  it("extractMetadata picks extra_fields under the gateway key", async () => {
    const parsedBody = {
      extra_fields: {
        provider: "openai",
        original_model_requested: "gpt-4o",
        resolved_model_used: "gpt-4o-mini",
      },
    };
    const result = await bifrostMetadataExtractor.extractMetadata({ parsedBody });
    expect(result).toEqual({
      gateway: {
        provider: "openai",
        original_model_requested: "gpt-4o",
        resolved_model_used: "gpt-4o-mini",
      },
    });
  });

  it("extractMetadata returns undefined for a non-Bifrost body (non-Bifrost gateways see no delta)", async () => {
    expect(
      await bifrostMetadataExtractor.extractMetadata({ parsedBody: { choices: [] } }),
    ).toBeUndefined();
  });

  it("extractMetadata picks up bifrost_metadata — PROVISIONAL (docs-derived)", async () => {
    const parsedBody = { extra_fields: {}, bifrost_metadata: { redacted: true } };
    const result = await bifrostMetadataExtractor.extractMetadata({ parsedBody });
    expect(result?.gateway?.bifrost_metadata).toEqual({ redacted: true });
  });

  it("createStreamExtractor accumulates fields across chunks", () => {
    const extractor = bifrostMetadataExtractor.createStreamExtractor();
    extractor.processChunk({ extra_fields: { provider: "openai" } });
    extractor.processChunk({ extra_fields: { resolved_model_used: "gpt-4o-mini" } });
    expect(extractor.buildMetadata()).toEqual({
      gateway: { provider: "openai", resolved_model_used: "gpt-4o-mini" },
    });
  });

  it("createStreamExtractor returns undefined when no chunk carried Bifrost fields", () => {
    const extractor = bifrostMetadataExtractor.createStreamExtractor();
    extractor.processChunk({ choices: [] });
    expect(extractor.buildMetadata()).toBeUndefined();
  });
});

describe("attributionFromProviderMetadata", () => {
  it("reads provider/requestedModel/servedModel off the gateway key", () => {
    const pm = {
      gateway: {
        provider: "openai",
        original_model_requested: "gpt-4o",
        resolved_model_used: "gpt-4o-mini",
      },
    };
    expect(attributionFromProviderMetadata(pm)).toEqual({
      provider: "openai",
      requestedModel: "gpt-4o",
      servedModel: "gpt-4o-mini",
    });
  });

  it("returns undefined for undefined/non-gateway providerMetadata", () => {
    expect(attributionFromProviderMetadata(undefined)).toBeUndefined();
    expect(attributionFromProviderMetadata({})).toBeUndefined();
    expect(attributionFromProviderMetadata({ anthropic: {} })).toBeUndefined();
  });
});

describe("hasBifrostRedactionMetadata", () => {
  it("true when the gateway key carries bifrost_metadata", () => {
    expect(hasBifrostRedactionMetadata({ gateway: { bifrost_metadata: {} } })).toBe(true);
  });

  it("false when absent", () => {
    expect(hasBifrostRedactionMetadata({ gateway: { provider: "openai" } })).toBe(false);
    expect(hasBifrostRedactionMetadata(undefined)).toBe(false);
    expect(hasBifrostRedactionMetadata({})).toBe(false);
  });
});
