/**
 * Shared runStructured() error classes (#547).
 *
 * `RunCancelledError` moved here verbatim from `agent-runner.ts` so the
 * harness-agnostic `CodingAgentRunner` base can throw the same class
 * `AgentRunner` throws on abort — parity without a runtime-layer import of
 * `agent-runner.ts` (same layer 7, no cycle).
 */

/**
 * Thrown by `runStructured()` when `RunOptions.abortSignal` fires before a
 * schema-valid `object` exists to return. Unlike `stream()`/`run()` — whose
 * result shapes have no required "output" field, so they can return an
 * honest empty/cancelled result — `StructuredRunResult<T>` REQUIRES a
 * schema-valid `object: T`; there is no honest value to fabricate on abort.
 * Throwing (rather than the D1 return-never-throw posture) is the only
 * type-safe option here. `err.name === "RunCancelledError"` (or
 * `instanceof`) distinguishes this from a genuine schema/model failure.
 */
export class RunCancelledError extends Error {
  constructor(message = "runStructured aborted before a result was available") {
    super(message);
    this.name = "RunCancelledError";
  }
}

/**
 * The canonical run `finishReason` for "the harness exhausted its structured
 * -output retry budget" (#547) — spelled once, read by the CC translator and
 * the hint table below.
 */
export const FINISH_REASON_STRUCTURED_OUTPUT_RETRIES = "max-structured-output-retries";

/**
 * Thrown by the `CodingAgentRunner` harness path (#547) when a run finished
 * with no `structured_output` payload. `finishReason` is the mapped harness
 * reason, so the failure modes are separable by field, not regex.
 */
export class StructuredOutputUnavailableError extends Error {
  readonly finishReason: string;
  constructor(finishReason: string) {
    super(
      `runStructured: the harness finished without structured output (finishReason="${finishReason}")${STRUCTURED_OUTPUT_HINTS[finishReason] ?? ""}`,
    );
    // `_emitError` publishes `errorType: error.name` — without this the bus sees "Error".
    this.name = "StructuredOutputUnavailableError";
    this.finishReason = finishReason;
  }
}

const STRUCTURED_OUTPUT_HINTS: Readonly<Record<string, string>> = {
  [FINISH_REASON_STRUCTURED_OUTPUT_RETRIES]:
    " — the model did not produce schema-conformant output within the CLI's retry budget; simplify the schema or the task",
  stop: " — the model ended the turn without calling the StructuredOutput carrier; if the CLI logged 'Init JSON schema rejected', the JSON Schema was not accepted",
};
