/**
 * Decision validation (design §5.4 D4, corrected by R-1 C1).
 *
 * The base validates a {@link HarnessDecision} against a native ask BEFORE
 * `session.respond()` — four checks, not one:
 *   1. KIND          — the decision kind is in the ADAPTER-DECLARED per-request-type
 *                      vocabulary. NOT the wire's `availableDecisions`, which R-1
 *                      proved is an experimental-schema UI ordering hint the server
 *                      does not enforce (C1): validating against it would wrongly
 *                      reject legitimate `deny`/`allowSession` replies.
 *   2. COMPATIBILITY — every `ruleRef` resolves to a proposal on THIS request
 *                      whose `nativeKind` is applicable to the operation.
 *   3. SCOPE         — the decision's scope ∈ each referenced proposal's `allowedScopes`.
 *   4. AUTHORIZATION — `scope: "durable"` additionally requires the D13 durable
 *                      feature flag (and, once #307 lands, an authenticated actor).
 *
 * B-2 lands the helper + its unit tests as the seam; B-3 (#328) wires it into the
 * live transport → `respond()` path.
 */

import type { HarnessDecision, NativeProposal, OperationClass } from "../../gates/decisions.js";
import type { AskRequestType, DecisionVocabulary } from "./types.js";

export type DecisionValidation =
  | { ok: true }
  | {
      ok: false;
      code: "kind" | "compatibility" | "scope" | "authorization";
      message: string;
    };

export interface DecisionValidationInput {
  readonly decision: HarnessDecision;
  /** The native ask's request type — selects the vocabulary row (C1 step 1). */
  readonly requestType: AskRequestType;
  /** The adapter-declared vocabulary (C1) — the validation authority for step 1. */
  readonly vocabulary: DecisionVocabulary;
  /** The proposals carried on THIS request (compatibility/scope checks). */
  readonly proposals: readonly NativeProposal[];
  /** The operation class the ask covers (compatibility check). */
  readonly operation: OperationClass;
  /** D13 durable feature-flag state (authorization check). */
  readonly durableEnabled: boolean;
}

/**
 * Whether a proposal's `nativeKind` can apply to an operation class. Provisional
 * (B-2): permissive but not blind. CC permission updates apply to any class;
 * Codex exec-policy amendments to command-like classes; network-policy
 * amendments to any (network is an effect that can occur under any class, §5.2).
 * Tightened as B-4 lands Codex reality.
 */
function isProposalApplicable(proposal: NativeProposal, operation: OperationClass): boolean {
  switch (proposal.nativeKind) {
    case "cc-permission-update":
      return true;
    case "codex-execpolicy-amendment":
      return operation === "shell" || operation === "file-change" || operation === "local-tool";
    case "codex-networkpolicy-amendment":
      return true;
    default:
      return false;
  }
}

/**
 * Run the four-check validation. Returns the first failure, or `{ ok: true }`.
 */
export function validateDecision(input: DecisionValidationInput): DecisionValidation {
  const { decision, requestType, vocabulary, proposals, operation, durableEnabled } = input;

  // 1. KIND — against the adapter-declared vocabulary (C1), never availableDecisions.
  const allowed = vocabulary[requestType] ?? [];
  if (!allowed.includes(decision.kind)) {
    return {
      ok: false,
      code: "kind",
      message:
        `decision kind "${decision.kind}" is not in the "${requestType}" vocabulary ` +
        `[${allowed.join(", ") || "<none>"}]`,
    };
  }

  // Only `allowWithRules` references proposals + carries a scope needing checks
  // 2–4. Every other kind passes once its kind is in vocabulary.
  if (decision.kind !== "allowWithRules") {
    return { ok: true };
  }

  const byId = new Map(proposals.map((p) => [p.id, p]));
  for (const ref of decision.ruleRefs) {
    const proposal = byId.get(ref.proposalId);
    // 2. COMPATIBILITY — ref resolves to a proposal on this request, applicable
    //    to the operation.
    if (!proposal) {
      return {
        ok: false,
        code: "compatibility",
        message: `ruleRef "${ref.proposalId}" does not resolve to a proposal on this request`,
      };
    }
    if (!isProposalApplicable(proposal, operation)) {
      return {
        ok: false,
        code: "compatibility",
        message:
          `proposal "${proposal.id}" (${proposal.nativeKind}) is not applicable to ` +
          `operation "${operation}"`,
      };
    }
    // 3. SCOPE — the decision's scope must be offered by each referenced proposal.
    if (!proposal.allowedScopes.includes(decision.scope)) {
      return {
        ok: false,
        code: "scope",
        message:
          `scope "${decision.scope}" is not in proposal "${proposal.id}" allowedScopes ` +
          `[${proposal.allowedScopes.join(", ")}]`,
      };
    }
  }

  // 4. AUTHORIZATION — durable rules require the D13 flag (+ #307 actor later).
  if (decision.scope === "durable" && !durableEnabled) {
    return {
      ok: false,
      code: "authorization",
      message:
        'scope "durable" requires the D13 durable-decisions feature flag, which is off ' +
        "(enabled only with an authenticated actor once #307 lands)",
    };
  }

  return { ok: true };
}
