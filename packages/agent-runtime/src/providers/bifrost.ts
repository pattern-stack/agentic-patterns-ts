/**
 * Bifrost gateway naming — headers, correlation, response-side awareness, and
 * per-run composition.
 *
 * Quarantined here (rather than in `model-resolver.ts` / `agent-runner.ts`)
 * so the runner and {@link GatewayConfig} stay vendor-generic: any
 * OpenAI-compatible gateway can use `GatewayConfig.headers`, but Bifrost's
 * specific header names, correlation semantics, and response-side (#407)
 * error classification / redaction detection live in one small module.
 *
 * Three mechanisms, split by lifetime:
 *   - Static injection (vk + default guardrails) is derived by
 *     `buildFromGateway` (`model-resolver.ts`) at provider-creation time, from
 *     `GatewayConfig.virtualKey`/`virtualKeyEnv`/`guardrailIds`.
 *   - Per-request injection (correlation dims + per-run guardrail override) is
 *     computed here: {@link bifrostCorrelationHeaders} is the factory
 *     `createRunner` wires into `AgentRunner`'s `requestHeaders` option;
 *     {@link bifrostRunHeaders} is the caller-facing composer for
 *     `RunOptions.requestHeaders`.
 *   - Response-side awareness (#407): {@link classifyBifrostError} parses a
 *     thrown `APICallError`'s raw `responseBody` into a typed `Bifrost*`
 *     error; {@link scanRedactionPlaceholders} detects in-band redaction
 *     placeholders; {@link bifrostMetadataExtractor} captures Bifrost's
 *     `extra_fields`/`bifrost_metadata` via the SDK's `metadataExtractor` seam.
 */

import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";
import { z } from "zod";

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
const TRIM_DASHES = /^-+|-+$/g;

/**
 * Make a string safe to use as an HTTP header value: replace non-printable-ASCII
 * chars with `-`, collapse runs of dashes, trim leading/trailing dashes, and cap
 * at {@link MAX_HEADER_VALUE_LENGTH} chars. Deterministic — same input always
 * yields the same output.
 */
export function sanitizeHeaderValue(value: string): string {
  const replaced = value.replace(NON_PRINTABLE_ASCII, "-").replace(REPEATED_DASHES, "-");
  const trimmed = replaced.replace(TRIM_DASHES, "");
  return trimmed.slice(0, MAX_HEADER_VALUE_LENGTH);
}

// Header NAMES are a stricter token than values: restrict to lowercase
// alphanumerics + dashes so a caller-supplied `dims` key can never produce an
// invalid header name (fetch/Headers throws a TypeError on e.g. spaces,
// colons, or unicode in a header name — unlike an invalid VALUE, which most
// runtimes just pass through byte-for-byte).
const INVALID_HEADER_KEY_CHARS = /[^a-z0-9-]/g;

/**
 * Make a string safe to use as (a suffix of) an HTTP header NAME: lowercase,
 * replace anything outside `[a-z0-9-]` with `-`, collapse runs of dashes, trim
 * leading/trailing dashes, and cap at {@link MAX_HEADER_VALUE_LENGTH} chars.
 * Deterministic — same input always yields the same output.
 */
export function sanitizeHeaderKey(key: string): string {
  const replaced = key
    .toLowerCase()
    .replace(INVALID_HEADER_KEY_CHARS, "-")
    .replace(REPEATED_DASHES, "-");
  const trimmed = replaced.replace(TRIM_DASHES, "");
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
  // `.` (not just the "gateway" prefix) so a hypothetical direct provider
  // literally named e.g. "gatewayx" can never accidentally self-gate in —
  // "gateway.chat" is createOpenAICompatible's actual `${name}.${modelType}` shape.
  if (!ctx.modelProvider?.startsWith("gateway.")) return {};

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
    headers[`${BIFROST_DIM_PREFIX}${sanitizeHeaderKey(key)}`] = sanitizeHeaderValue(value);
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Response-side error classification (#407)
// ---------------------------------------------------------------------------

/**
 * Tolerant envelope schema for Bifrost's error response body — every field
 * optional, so a malformed or non-Bifrost body classifies as `undefined`
 * rather than throwing (see {@link classifyBifrostError}). Covers the two
 * live-captured 4xx shapes (issue #406, 2026-07-27; 403 `virtual_key_blocked`
 * live-captured 2026-07-29 — "Virtual key has expired") plus the guardrail
 * detail fields, which are PROVISIONAL (docs-derived, not live-captured —
 * see spec 407 § Provisional-shape discipline). Bifrost nests guardrail
 * detail under `error` per docs; kept lenient enough to also find it
 * top-level until live capture pins the exact location.
 */
const BifrostErrorEnvelopeSchema = z.object({
  type: z.string().optional(),
  is_bifrost_error: z.boolean().optional(),
  status_code: z.number().optional(),
  error: z
    .object({
      message: z.string().optional(),
      type: z.string().optional(),
      code: z.string().optional(),
      // PROVISIONAL (docs-derived, not live-captured — see spec 407 § validation)
      guardrail_id: z.string().optional(),
      category: z.string().optional(),
      severity: z.string().optional(),
      action: z.string().optional(),
    })
    .optional(),
  extra_fields: z
    .object({
      provider: z.string().optional(),
      original_model_requested: z.string().optional(),
      resolved_model_used: z.string().optional(),
      request_type: z.string().optional(),
    })
    .optional(),
  // PROVISIONAL (docs-derived, not live-captured — see spec 407 § validation):
  // top-level fallback location for the 446 guardrail detail.
  guardrail_id: z.string().optional(),
  category: z.string().optional(),
  severity: z.string().optional(),
  action: z.string().optional(),
});

type BifrostErrorEnvelope = z.infer<typeof BifrostErrorEnvelopeSchema>;

interface BifrostErrorOptions {
  readonly statusCode?: number;
  readonly bifrostType?: string;
  readonly provider?: string;
  readonly originalModelRequested?: string;
  readonly resolvedModelUsed?: string;
  readonly envelope: unknown;
  readonly cause: unknown;
}

/**
 * Base class for every typed Bifrost gateway error. `cause` is always the
 * original `APICallError` (unwrapped from a `RetryError` first, when the SDK
 * wrapped it — see {@link classifyBifrostError}, fact 5). `envelope` is the
 * raw parsed `responseBody`, verbatim, for callers that need a field this
 * class doesn't surface directly.
 */
export class BifrostError extends Error {
  readonly statusCode?: number;
  readonly bifrostType?: string;
  readonly provider?: string;
  readonly originalModelRequested?: string;
  readonly resolvedModelUsed?: string;
  readonly envelope: unknown;

  constructor(message: string, opts: BifrostErrorOptions) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.statusCode = opts.statusCode;
    this.bifrostType = opts.bifrostType;
    this.provider = opts.provider;
    this.originalModelRequested = opts.originalModelRequested;
    this.resolvedModelUsed = opts.resolvedModelUsed;
    this.envelope = opts.envelope;
  }
}

/** 401, `error.type: "virtual_key_required"` — no virtual key supplied.
 *  Live-captured (issue #406, 2026-07-27). */
export class BifrostVirtualKeyRequiredError extends BifrostError {}

/** 403, `error.type: "provider_blocked"` — the resolved provider is not
 *  allowed for this virtual key. Live-captured (issue #406, 2026-07-27). */
export class BifrostProviderBlockedError extends BifrostError {}

/** 403, `error.type: "virtual_key_blocked"` — the virtual key itself is
 *  blocked/expired/revoked (distinct from {@link BifrostProviderBlockedError}:
 *  the KEY is the problem, not the provider choice). Live-captured
 *  (2026-07-29, `error.message: "Virtual key has expired"`). */
export class BifrostVirtualKeyBlockedError extends BifrostError {}

/** 446, or `error.type: "guardrail_violation"` — a configured guardrail
 *  blocked the request. PROVISIONAL (docs-derived, not live-captured — see
 *  spec 407 § Provisional-shape discipline). Every detail field is optional:
 *  classification must succeed even if they're absent or the guardrail
 *  detail moves before live validation pins it. */
export class BifrostGuardrailViolationError extends BifrostError {
  readonly guardrailId?: string;
  readonly category?: string;
  readonly severity?: string;
  readonly action?: string;

  constructor(
    message: string,
    opts: BifrostErrorOptions & {
      guardrailId?: string;
      category?: string;
      severity?: string;
      action?: string;
    },
  ) {
    super(message, opts);
    this.guardrailId = opts.guardrailId;
    this.category = opts.category;
    this.severity = opts.severity;
    this.action = opts.action;
  }
}

// ---------------------------------------------------------------------------
// Message trust boundary (#407 Gate 2.5 quality note)
// ---------------------------------------------------------------------------

/**
 * TRUST BOUNDARY: Bifrost's free-text `error.message` is NOT guaranteed to
 * be redaction-safe — unlike the counts-only `agent.guardrail.redaction`
 * channel (entity TYPE + count, never raw values), a guardrail's message is
 * provider-authored prose that could in principle echo triggering content
 * (e.g. a hypothetical "blocked: detected SSN 123-45-6789"). Every raw
 * message forwarded onto an event is capped at this length as a defensive
 * measure; the widely-surfaced `agent.guardrail.violation` event additionally
 * prefers {@link violationSummaryMessage}'s structured summary over the raw
 * text entirely when one is available.
 */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/** Cap `message` at {@link MAX_ERROR_MESSAGE_LENGTH}, marking truncation
 *  explicitly rather than silently clipping. */
export function truncateMessage(message: string, max: number = MAX_ERROR_MESSAGE_LENGTH): string {
  return message.length > max ? `${message.slice(0, max)}… [truncated]` : message;
}

/**
 * A safe, structured-field-derived summary for a guardrail violation —
 * PREFERRED over the gateway's free-text message on the
 * `agent.guardrail.violation` event (see {@link MAX_ERROR_MESSAGE_LENGTH}'s
 * trust-boundary note). `undefined` when no structured field is available to
 * summarize from (all of `guardrailId`/`category`/`severity` are
 * PROVISIONAL/optional) — the caller falls back to the capped raw message.
 */
export function violationSummaryMessage(err: BifrostGuardrailViolationError): string | undefined {
  const bits: string[] = [];
  if (err.category) bits.push(err.category);
  if (err.severity) bits.push(err.severity);
  if (err.guardrailId) bits.push(err.guardrailId);
  return bits.length > 0 ? `Guardrail policy violation: ${bits.join(" / ")}` : undefined;
}

/**
 * Maps a live-captured `error.type` string to its typed error class — the
 * SINGLE SOURCE OF TRUTH {@link RECOGNIZED_BIFROST_TYPES} and
 * {@link classifyBifrostError}'s dispatch both derive from (Gate 2.5 quality
 * nit: previously enumerated separately in two places, able to drift). A 5th
 * live-captured type needs editing in exactly this one place.
 *
 * `guardrail_violation` is deliberately NOT a key here — it's handled
 * separately via `isGuardrail446` in `classifyBifrostError`, since a bare 446
 * status also routes there regardless of `type`.
 */
const BIFROST_ERROR_CLASS_BY_TYPE: Readonly<
  Record<string, new (message: string, opts: BifrostErrorOptions) => BifrostError>
> = {
  virtual_key_required: BifrostVirtualKeyRequiredError,
  provider_blocked: BifrostProviderBlockedError,
  virtual_key_blocked: BifrostVirtualKeyBlockedError,
};

/** `error.type` values Bifrost is known to send (live-captured except
 *  `guardrail_violation`, PROVISIONAL). Anything else still classifies (via
 *  `is_bifrost_error` or a 446 status) into the base {@link BifrostError}.
 *  Derived from {@link BIFROST_ERROR_CLASS_BY_TYPE} + the guardrail type, so
 *  the two enumerations can't drift apart. */
const RECOGNIZED_BIFROST_TYPES = new Set([
  ...Object.keys(BIFROST_ERROR_CLASS_BY_TYPE),
  "guardrail_violation",
]);

/** Extract the guardrail detail fields, preferring the (docs-specified)
 *  nested `error.*` location and falling back to top-level — PROVISIONAL,
 *  see {@link BifrostGuardrailViolationError}. */
function guardrailDetail(envelope: BifrostErrorEnvelope) {
  return {
    guardrailId: envelope.error?.guardrail_id ?? envelope.guardrail_id,
    category: envelope.error?.category ?? envelope.category,
    severity: envelope.error?.severity ?? envelope.severity,
    action: envelope.error?.action ?? envelope.action,
  };
}

/**
 * Classify a thrown error into a typed {@link BifrostError}, or `undefined`
 * when it isn't one — the caller falls back to today's generic error path.
 * NEVER throws (fact-checked against every input shape the runner can hand
 * it: a `RetryError`, a bare `APICallError`, a plain `Error`, a non-error).
 *
 * Per fact 5, 401/403/446 are non-retryable: the SDK throws the raw
 * `APICallError` on the first attempt in the common case, but this
 * defensively unwraps `RetryError.lastError` too (the multi-attempt shape).
 * Per fact 2, `APICallError.data` has the Bifrost envelope stripped by
 * openai-compatible's default error schema — classification parses the raw
 * `responseBody` string instead.
 */
export function classifyBifrostError(e: unknown): BifrostError | undefined {
  try {
    const unwrapped = RetryError.isInstance(e) ? e.lastError : e;
    if (!APICallError.isInstance(unwrapped)) return undefined;
    if (typeof unwrapped.responseBody !== "string") return undefined;

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(unwrapped.responseBody);
    } catch {
      return undefined;
    }

    const result = BifrostErrorEnvelopeSchema.safeParse(parsedBody);
    if (!result.success) return undefined;
    const envelope = result.data;

    const statusCode = envelope.status_code ?? unwrapped.statusCode;
    const isGuardrail446 = statusCode === 446 || envelope.type === "guardrail_violation";
    const recognizedType =
      envelope.type !== undefined && RECOGNIZED_BIFROST_TYPES.has(envelope.type);
    const isBifrost = envelope.is_bifrost_error === true || recognizedType || isGuardrail446;
    if (!isBifrost) return undefined;

    const message = envelope.error?.message ?? unwrapped.message;
    const base: BifrostErrorOptions = {
      statusCode,
      bifrostType: envelope.type,
      provider: envelope.extra_fields?.provider,
      originalModelRequested: envelope.extra_fields?.original_model_requested,
      resolvedModelUsed: envelope.extra_fields?.resolved_model_used,
      envelope: parsedBody,
      cause: unwrapped,
    };

    if (isGuardrail446) {
      return new BifrostGuardrailViolationError(message, { ...base, ...guardrailDetail(envelope) });
    }
    const ErrorClass =
      (envelope.type !== undefined ? BIFROST_ERROR_CLASS_BY_TYPE[envelope.type] : undefined) ??
      BifrostError;
    return new ErrorClass(message, base);
  } catch {
    // Classification must never throw — any unexpected shape falls back to
    // the caller's generic error path.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Redaction placeholder detection (#407)
// ---------------------------------------------------------------------------

/**
 * Matches Bifrost/Presidio's in-band redaction placeholders, e.g. `[EMAIL-1]`,
 * `[PHONE_NUMBER-2]`. Uppercase-only entity names keep ordinary markdown
 * (`[link-1]`) from matching, but the pattern is still PERMISSIVE: it also
 * matches legitimate uppercase-acronym citations a model might emit verbatim
 * (`[RFC-2119]`, `[ISSUE-407]`, `[ADR-0006]`). The payload this feeds
 * ({@link scanRedactionPlaceholders}'s counts-by-type, never raw values)
 * leaks nothing on a false positive, but a consumer that badges "redacted"
 * off `source: "placeholders"` ALONE is showing a possibly-false claim —
 * prefer gating any user-visible badge on metadata confirmation
 * (`source: "both"` / `"metadata"`) instead. See spec 407 § Open question 1.
 */
export const REDACTION_PLACEHOLDER_PATTERN = /\[([A-Z][A-Z0-9_]*)-(\d+)\]/g;

/**
 * Count in-band redaction placeholders in `text` by entity type — e.g.
 * `"[EMAIL-1] x [EMAIL-2] [PHONE_NUMBER-1]"` → `{ EMAIL: 2, PHONE_NUMBER: 1 }`.
 * `undefined` when there's no match. NEVER returns raw matched values, only
 * counts. See {@link REDACTION_PLACEHOLDER_PATTERN} for the false-positive
 * caveat.
 */
export function scanRedactionPlaceholders(
  text: string,
): Readonly<Record<string, number>> | undefined {
  const counts: Record<string, number> = {};
  // A fresh RegExp instance per call — the exported pattern is a module-level
  // `g` regex; reusing it directly would carry `lastIndex` state across calls.
  const pattern = new RegExp(
    REDACTION_PLACEHOLDER_PATTERN.source,
    REDACTION_PLACEHOLDER_PATTERN.flags,
  );
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const entityType = match[1];
    if (entityType !== undefined) {
      counts[entityType] = (counts[entityType] ?? 0) + 1;
    }
    match = pattern.exec(text);
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

// ---------------------------------------------------------------------------
// Metadata extraction + attribution (#407)
// ---------------------------------------------------------------------------

/**
 * Pick the Bifrost-named fields off a parsed response body (success or
 * per-chunk), verbatim. `bifrost_metadata` is PROVISIONAL (docs-derived, not
 * live-captured — see spec 407 § Provisional-shape discipline); `extra_fields`
 * members are the same shape the error envelope carries (fact 8).
 */
function pickBifrostMetadata(parsedBody: unknown): Record<string, unknown> | undefined {
  if (!parsedBody || typeof parsedBody !== "object") return undefined;
  const body = parsedBody as Record<string, unknown>;
  const extraFields = (body.extra_fields ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof extraFields.provider === "string") out.provider = extraFields.provider;
  if (typeof extraFields.original_model_requested === "string") {
    out.original_model_requested = extraFields.original_model_requested;
  }
  if (typeof extraFields.resolved_model_used === "string") {
    out.resolved_model_used = extraFields.resolved_model_used;
  }
  if (typeof extraFields.request_type === "string") out.request_type = extraFields.request_type;
  // PROVISIONAL (docs-derived, not live-captured — see spec 407 § validation)
  if ("bifrost_metadata" in body) out.bifrost_metadata = body.bifrost_metadata;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Structurally compatible with `@ai-sdk/openai-compatible`'s
 * `MetadataExtractor` — defined WITHOUT importing that type, so this
 * barrel-exported module takes no compile-time dependency on the optional
 * peer (fact 3/4, Approach C). Wired as the `metadataExtractor` key in
 * `buildFromGateway`'s settings literal (`model-resolver.ts`) — the seam
 * #406 reserved. Pure read-only extraction: absent fields → `undefined` →
 * non-Bifrost gateways see no `providerMetadata` delta.
 */
export const bifrostMetadataExtractor = {
  extractMetadata: async ({
    parsedBody,
  }: {
    parsedBody: unknown;
  }): Promise<Record<string, Record<string, unknown>> | undefined> => {
    const gateway = pickBifrostMetadata(parsedBody);
    return gateway ? { gateway } : undefined;
  },
  createStreamExtractor: () => {
    // PROVISIONAL: docs describe the final chunk carrying these fields; this
    // accumulates across every chunk so an earlier or later placement still
    // survives to `buildMetadata()`. See spec 407 § Provisional-shape
    // discipline.
    let accumulated: Record<string, unknown> | undefined;
    return {
      processChunk(parsedChunk: unknown): void {
        const gateway = pickBifrostMetadata(parsedChunk);
        if (gateway) accumulated = { ...accumulated, ...gateway };
      },
      buildMetadata(): Record<string, Record<string, unknown>> | undefined {
        return accumulated ? { gateway: accumulated } : undefined;
      },
    };
  },
};

/**
 * Whether a `providerMetadata` object carries Bifrost's redaction
 * confirmation (`bifrost_metadata`, via {@link bifrostMetadataExtractor}).
 * PROVISIONAL signal (docs-derived — see § Provisional-shape discipline):
 * used to gate a `guardrail.redaction` event's `source` between a raw
 * placeholder-scan hit (`"placeholders"`, permissive — see
 * {@link REDACTION_PLACEHOLDER_PATTERN}'s false-positive caveat) and a
 * metadata-confirmed one (`"metadata"`/`"both"`). Dashboard consumers should
 * prefer gating any user-visible "redacted" badge on this confirmation
 * rather than a placeholder-only hit.
 */
export function hasBifrostRedactionMetadata(pm: unknown): boolean {
  if (!pm || typeof pm !== "object") return false;
  const gateway = (pm as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") return false;
  return "bifrost_metadata" in (gateway as Record<string, unknown>);
}

/** Which provider actually served a gateway response — surfaced from
 *  `extra_fields`/`bifrost_metadata` via {@link bifrostMetadataExtractor}. */
export interface GatewayAttribution {
  readonly provider?: string;
  readonly requestedModel?: string;
  readonly servedModel?: string;
}

/**
 * Read {@link GatewayAttribution} off a `generateText`/stream result's
 * `providerMetadata` (the `"gateway"` key {@link bifrostMetadataExtractor}
 * populates). `undefined` for a non-gateway model, or a gateway that never
 * populated the key.
 */
export function attributionFromProviderMetadata(pm: unknown): GatewayAttribution | undefined {
  if (!pm || typeof pm !== "object") return undefined;
  const gateway = (pm as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") return undefined;
  const g = gateway as Record<string, unknown>;
  const provider = typeof g.provider === "string" ? g.provider : undefined;
  const requestedModel =
    typeof g.original_model_requested === "string" ? g.original_model_requested : undefined;
  const servedModel = typeof g.resolved_model_used === "string" ? g.resolved_model_used : undefined;
  if (provider === undefined && requestedModel === undefined && servedModel === undefined) {
    return undefined;
  }
  return { provider, requestedModel, servedModel };
}
