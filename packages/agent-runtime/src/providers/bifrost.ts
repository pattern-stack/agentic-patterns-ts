/**
 * Bifrost gateway naming — headers, correlation, and per-run composition.
 *
 * Quarantined here (rather than in `model-resolver.ts` / `agent-runner.ts`)
 * so the runner and {@link GatewayConfig} stay vendor-generic: any
 * OpenAI-compatible gateway can use `GatewayConfig.headers`, but Bifrost's
 * specific header names, correlation semantics, and (later, #407) response-side
 * helpers live in one small module.
 *
 * Two mechanisms, split by lifetime:
 *   - Static injection (vk + default guardrails) is derived by
 *     `buildFromGateway` (`model-resolver.ts`) at provider-creation time, from
 *     `GatewayConfig.virtualKey`/`virtualKeyEnv`/`guardrailIds`.
 *   - Per-request injection (correlation dims + per-run guardrail override) is
 *     computed here: {@link bifrostCorrelationHeaders} is the factory
 *     `createRunner` wires into `AgentRunner`'s `requestHeaders` option;
 *     {@link bifrostRunHeaders} is the caller-facing composer for
 *     `RunOptions.requestHeaders`.
 */

import type { RunHeadersContext } from "../runner/agent-runner.js";

// ---------------------------------------------------------------------------
// Header names
// ---------------------------------------------------------------------------

/** Bifrost virtual-key header — the governed-instance entry ticket. */
export const BIFROST_VK_HEADER = "x-bf-vk";
/** Bifrost guardrail-selection header (comma-joined profile ids). */
export const BIFROST_GUARDRAILS_HEADER = "x-bf-guardrail-ids";
/** Prefix for Bifrost's free-form run-correlation dimension headers. */
export const BIFROST_DIM_PREFIX = "x-bf-dim-";
/** Standard request-correlation header, set to the minted runId. */
export const REQUEST_ID_HEADER = "x-request-id";

// ---------------------------------------------------------------------------
// Header-value sanitization
// ---------------------------------------------------------------------------

const MAX_HEADER_VALUE_LENGTH = 128;
// Printable ASCII only (0x20-0x7E); anything else (unicode, control chars) is
// replaced with `-`. Agent role names are arbitrary strings
// (`AgentLike.role.name`), so this can't assume ASCII input.
const NON_PRINTABLE_ASCII = /[^\x20-\x7E]/g;
const REPEATED_DASHES = /-{2,}/g;

/**
 * Make a string safe to use as an HTTP header value: replace non-printable-ASCII
 * chars with `-`, collapse runs of dashes, trim leading/trailing dashes, and cap
 * at {@link MAX_HEADER_VALUE_LENGTH} chars. Deterministic — same input always
 * yields the same output.
 */
export function sanitizeHeaderValue(value: string): string {
  const replaced = value.replace(NON_PRINTABLE_ASCII, "-").replace(REPEATED_DASHES, "-");
  const trimmed = replaced.replace(/^-+|-+$/g, "");
  return trimmed.slice(0, MAX_HEADER_VALUE_LENGTH);
}

// ---------------------------------------------------------------------------
// Per-run correlation (runner factory)
// ---------------------------------------------------------------------------

/**
 * The `requestHeaders` factory `createRunner` wires automatically whenever a
 * gateway is configured (see `AgentRunnerOptions.requestHeaders`).
 *
 * Self-gates on `ctx.modelProvider`: gateway-built models carry provider
 * `"gateway.chat"` (from `createOpenAICompatible({ name: "gateway" })`), so
 * profile-pinned ids that escape-hatch to a direct provider never receive
 * `x-bf-*` headers. Returns `{}` for any non-gateway provider.
 *
 * Dims fire for ANY gateway-built model, not just Bifrost — `x-bf-dim-*` on a
 * non-Bifrost gateway (LiteLLM, OpenRouter) is inert but visible; the
 * alternative (gating on `virtualKey`) would silently drop correlation for a
 * Basic-fronted, ungoverned Bifrost.
 */
export function bifrostCorrelationHeaders(ctx: RunHeadersContext): Record<string, string> {
  if (!ctx.modelProvider?.startsWith("gateway")) return {};

  const headers: Record<string, string> = {
    [REQUEST_ID_HEADER]: ctx.runId,
    [`${BIFROST_DIM_PREFIX}agent`]: sanitizeHeaderValue(ctx.agentName),
    [`${BIFROST_DIM_PREFIX}run`]: ctx.runId,
  };
  // `effectiveTraceId` defaults to `runId` when the caller doesn't pass one —
  // omit the redundant dim in that (common) case.
  if (ctx.traceId !== ctx.runId) {
    headers[`${BIFROST_DIM_PREFIX}trace`] = ctx.traceId;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Caller-facing per-run header composer
// ---------------------------------------------------------------------------

/**
 * Compose `RunOptions.requestHeaders` for a per-run guardrail override and/or
 * extra correlation dims, without callers needing to memorize Bifrost's header
 * names. Per-call headers beat the gateway's static default
 * (`GatewayConfig.guardrailIds`) via `@ai-sdk/openai-compatible`'s
 * `combineHeaders`.
 *
 * @example
 * ```ts
 * await runner.run(agent, message, {
 *   requestHeaders: bifrostRunHeaders({ guardrailIds: ["pii-strict"] }),
 * });
 * ```
 */
export function bifrostRunHeaders(opts: {
  guardrailIds?: readonly string[];
  dims?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.guardrailIds?.length) {
    headers[BIFROST_GUARDRAILS_HEADER] = opts.guardrailIds.join(",");
  }
  for (const [key, value] of Object.entries(opts.dims ?? {})) {
    headers[`${BIFROST_DIM_PREFIX}${key}`] = sanitizeHeaderValue(value);
  }
  return headers;
}
