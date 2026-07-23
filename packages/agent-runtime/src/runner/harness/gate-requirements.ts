/**
 * Run-start gate/harness compatibility check (design §5.2, B-2).
 *
 * At run start the base collects `requires` declarations from the configured
 * gate chain and compares them to the harness probe's `enforcement` matrix +
 * `features.inputRewrite`. Any gap fails LOUD before the session starts, naming
 * the offending gate AND the operation class (or the rewrite feature). Existing
 * gates declare nothing → no requirements → never affected.
 *
 * Network policy is deliberately NOT checkable here — it is a run-configuration
 * concern set at session start against the probe's `sandbox` record (§5.2).
 */

import type { Gate } from "../../gates/base.js";
import type { HarnessProbeResult } from "./types.js";

export class GateRequirementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateRequirementError";
  }
}

/**
 * Throw {@link GateRequirementError} if any gate's declared requirements are
 * unmet by the probe. Returns silently when the chain is compatible.
 */
export function assertGateRequirements(
  gates: readonly Gate[],
  probe: HarnessProbeResult,
  harnessName: string,
): void {
  for (const gate of gates) {
    const requires = gate.requires;
    if (!requires) continue;

    for (const cls of requires.interceptClasses ?? []) {
      const enforcement = probe.enforcement[cls];
      if (enforcement !== "enforcing") {
        throw new GateRequirementError(
          `Gate "${gate.name}" requires interception of operation class "${cls}", but harness "${harnessName}" declares it "${enforcement}". The run cannot start: the gate's policy would not be enforceable on this harness.`,
        );
      }
    }

    if (requires.rewrite && !probe.features.inputRewrite) {
      throw new GateRequirementError(
        `Gate "${gate.name}" requires tool-input rewrite, but harness "${harnessName}" does not support it (features.inputRewrite = false). The run cannot start.`,
      );
    }
  }
}
