/**
 * `ap run <agentId> [message]` — chat with a single agent from the terminal.
 *
 * Two modes:
 *   • one-shot — `message` provided; stream once, print, exit.
 *   • interactive — no `message`; REPL loop via @clack/prompts.
 *
 * Rendering is raw ANSI (no chalk dep). Events come from the runtime as a
 * discriminated `AgentEvent` union; we project each type to a terminal line.
 *
 * Run-scope context (#268 PR-3): when the registration has an `instantiate`
 * hook, `--context '<json>'` (or the `AP_CONTEXT` env var, or the
 * registration's `instantiateDefaults`) resolves the context the hook runs
 * with, and the CONVERSATION BINDS THE DELIVERED INSTANCE — same posture as
 * `POST /conversations` (`agent-server/src/routes/conversations.ts`), so a
 * chat started from the CLI scopes identically to one started from the
 * dashboard. See `resolveRunContext` below.
 */

import {
  Conversation,
  NodeBackedRunner,
  deriveToolboxExecutor,
  getAgentEventBus,
  isPromotedAgent,
} from "@agentic-patterns/runtime";
import type { AgentEvent } from "@agentic-patterns/runtime";
import { isCancel, text } from "@clack/prompts";
import type { DiscoveredAgent } from "../helpers/discover.js";
import { ExecutionService } from "../services/execution-service.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** All discovered agents; the caller owns discovery. */
  agents: DiscoveredAgent[];
  /** Which agent to chat with. Matched against `AgentRegistration.id`. */
  agentId: string;
  /** If present → one-shot mode; if absent → interactive REPL. */
  message?: string;
  /** Project root for `.env` (credential preflight). Defaults to cwd. */
  configRoot?: string;
  /**
   * Raw JSON string from `--context '<json>'` (#268 PR-3). Highest-precedence
   * source for the `instantiate` hook's context — beats `AP_CONTEXT` env and
   * the registration's `instantiateDefaults`. Ignored (and rejected, see
   * {@link resolveRunContext}) when the agent has no `instantiate` hook.
   */
  context?: string;
}

/**
 * Entry point for the `ap run` command. Returns when the chat session ends.
 * Exits the process non-zero on agent-not-found.
 */
export async function runRunCommand(opts: RunOptions): Promise<void> {
  const reg = opts.agents.find((a) => a.id === opts.agentId);
  if (!reg) {
    const available = opts.agents.map((a) => a.id).join(", ") || "(none)";
    process.stderr.write(
      `${red(`agent "${opts.agentId}" not found`)}\n  available: ${available}\n`,
    );
    process.exit(1);
  }

  // Resolve run-scope context BEFORE any runner/model work (#268 PR-3) — a
  // malformed `--context`/`AP_CONTEXT`, or context supplied to a hook-less
  // agent, fails loud right here, never reaching credential preflight or a
  // model call. Precedence: flag > `AP_CONTEXT` env > `instantiateDefaults`,
  // mirroring `POST /conversations`' `effectiveContext` (`agent-server/src/
  // routes/conversations.ts`).
  const contextResolution = resolveRunContext(reg, opts.context);
  if (!contextResolution.ok) {
    process.stderr.write(`${red(`error: ${contextResolution.error}`)}\n`);
    process.exit(1);
  }
  const { context: effectiveContext } = contextResolution;

  const eventBus = getAgentEventBus();
  const svc = new ExecutionService({ configRoot: opts.configRoot ?? process.cwd() });
  const { runner: llmRunner } = await svc.resolveRunner({ eventBus, verbose: false }, opts.agents);
  // A promoted registration (asAgent()) runs its node instead of LLM-looping;
  // the shared LLM runner still drives any nested AgentSteps as its inner runner.
  // Thread `eventBus` so a promoted agent's stream() lifecycle is bus-visible
  // too (parity with `llmRunner`, which already got it via resolveRunner()).
  // NOTE: keyed on the DECLARED `reg.agent`, not the delivered instance below —
  // `instantiate`'s contract is "runnable by this registration's runner"
  // (#268 Decision 1), so the runner shape is registration-fixed regardless
  // of which context-resolved instance ends up bound.
  const runner = isPromotedAgent(reg.agent) ? new NodeBackedRunner(llmRunner, eventBus) : llmRunner;

  // Delivered-instance binding (#268): a hook-bearing registration binds the
  // CONTEXT-RESOLVED instance, never the declared one — the declared
  // instance's pinned scope is the bug #268 fixes (same posture as
  // `POST /conversations`). Hook rejection fails loud; it never falls back to
  // the declared instance, whose scope would be silently wrong.
  let agentToBind = reg.agent;
  if (typeof reg.instantiate === "function") {
    try {
      agentToBind = await reg.instantiate(effectiveContext);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${red(`error: instantiate failed: ${message}`)}\n`);
      process.exit(1);
    }
    // Fail loud on a contract-violating hook (#268 Decision 1: "runnable by
    // this registration's runner"). The runner above is keyed on the
    // DECLARED agent, so a kind mismatch is silent-wrong in one direction
    // (declared-plain → delivered-promoted gets LLM-looped; the pipeline
    // never executes) even though it throws loud in the other (declared-
    // promoted → delivered-plain, deep inside NodeBackedRunner). Catch both
    // at the seam instead.
    const kindCheck = checkInstantiateKindMatch(reg.agent, agentToBind);
    if (!kindCheck.ok) {
      process.stderr.write(`${red(`error: ${kindCheck.error}`)}\n`);
      process.exit(1);
    }
    process.stdout.write(`${dim(formatScopeBanner(effectiveContext, reg.contextRedactKeys))}\n`);
  }

  // DERIVE, don't force-create: a PromotedAgent (asAgent()) has no role
  // capabilities, so `createToolboxExecutor` would return a truthy-but-EMPTY
  // executor that throws `Tool "X" not found` for every call — and, as a set
  // `RunOptions.toolExecutor`, would BEAT the AgentStep-level fallback that
  // arms the nested agent's own tools. `deriveToolboxExecutor` returns
  // `undefined` for a capability-less agent, restoring that per-agent
  // derivation; real-capability agents still get their executor here.
  // Derived from the BOUND (delivered-or-declared) instance, not always
  // `reg.agent` — a hook-bearing registration's delivered instance is the one
  // whose tools actually execute (#268, mirrors `conversations.ts`).
  const conversation = new Conversation(agentToBind, runner, {
    toolExecutor: deriveToolboxExecutor(agentToBind),
  });

  if (opts.message !== undefined) {
    await streamOnce(conversation, opts.message);
    return;
  }

  await runRepl(conversation, reg);
}

// ---------------------------------------------------------------------------
// Run-scope context (#268 PR-3)
// ---------------------------------------------------------------------------

/** Result of resolving `ap run`'s context source, discriminated on `ok`. */
export type RunContextResolution =
  | {
      readonly ok: true;
      /** Whether the registration has an `instantiate` hook to run the context through. */
      readonly hasHook: boolean;
      readonly context: Record<string, unknown> | undefined;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve the context `ap run` hands to `reg.instantiate`, precedence
 * `--context` flag > `AP_CONTEXT` env (both raw JSON strings) >
 * `reg.instantiateDefaults` — mirroring `POST /conversations`'
 * `effectiveContext` (`agent-server/src/routes/conversations.ts`), so a chat
 * started from the CLI scopes identically to one started from the dashboard.
 *
 * Pure and synchronous by design: `runRunCommand` calls this BEFORE any
 * runner/model work, so a malformed flag/env value, or a context supplied to
 * a hook-less agent, fails loud pre-run rather than after paying for
 * credential preflight or a model call.
 *
 * Validation order mirrors the server's `POST /conversations` grammar:
 * JSON-parse → object-shape → hook-presence — same two 400s, translated to a
 * CLI `ok: false`.
 */
export function resolveRunContext(
  reg: Pick<DiscoveredAgent, "instantiate" | "instantiateDefaults">,
  contextFlag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RunContextResolution {
  const hasHook = typeof reg.instantiate === "function";
  // Normalize blank to absent: a present-but-empty/whitespace `AP_CONTEXT`
  // (e.g. a stray `export AP_CONTEXT=` in a .env) must fall back to
  // instantiateDefaults/no-context exactly like an UNSET source — `??` alone
  // would let `""` through to `JSON.parse`, which throws, hard-blocking
  // every `ap run` (including hook-less agents that never opted into context
  // at all) on a value nobody meant to set. The `--context` flag path is
  // already immune (cli.ts only threads it when `values.context` is truthy).
  const raw = (contextFlag ?? env.AP_CONTEXT)?.trim() || undefined;

  if (raw === undefined) {
    // No explicit source — hook-bearing registrations fall back to their
    // declared defaults (shallow-copied: `reg.instantiateDefaults` is ONE
    // shared object across every `ap run` invocation against this
    // registration; a hook that mutates its argument must not corrupt it for
    // the next run, mirror of the server-side fix in conversations.ts).
    return {
      ok: true,
      hasHook,
      context: hasHook && reg.instantiateDefaults ? { ...reg.instantiateDefaults } : undefined,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `--context (or AP_CONTEXT) is not valid JSON: ${message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "--context (or AP_CONTEXT) must be a JSON object" };
  }
  if (!hasHook) {
    return {
      ok: false,
      error: "agent has no instantiate hook — --context/AP_CONTEXT is not accepted",
    };
  }
  return { ok: true, hasHook, context: parsed as Record<string, unknown> };
}

/**
 * Verify a hook's delivered instance is the same structural KIND (promoted
 * `asAgent()` pipeline vs. plain core `Agent`) as the registration's declared
 * `agent` (#268 Decision 1: "must return an agent runnable by this
 * registration's runner"). `runRunCommand` selects the runner off the
 * DECLARED instance — so a kind-mismatched hook is silent-wrong in one
 * direction (declared plain → delivered promoted: LLM-looped, the pipeline
 * never actually runs) even though the inverse throws loud, but deep inside
 * `NodeBackedRunner` rather than at this seam. Exported for testing.
 */
export function checkInstantiateKindMatch(
  declared: unknown,
  delivered: unknown,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  const declaredPromoted = isPromotedAgent(declared);
  const deliveredPromoted = isPromotedAgent(delivered);
  if (declaredPromoted === deliveredPromoted) return { ok: true };
  const kind = (promoted: boolean) => (promoted ? "promoted" : "plain");
  return {
    ok: false,
    error: `instantiate must return an instance runnable by the registration's runner — declared ${kind(declaredPromoted)}, delivered ${kind(deliveredPromoted)}`,
  };
}

/**
 * Redact declared top-level keys before display — CLI mirror of
 * `agent-server/src/routes/conversations.ts`'s `redactContext` (#268
 * Decision 3): structure survives, value dropped, never silent. `undefined`
 * context, no declared keys, or none of them present → passthrough.
 */
export function redactContextForDisplay(
  context: Record<string, unknown> | undefined,
  keys: readonly string[] | undefined,
): Record<string, unknown> | undefined {
  if (context === undefined || !keys || keys.length === 0) return context;
  const present = keys.filter((k) => k in context);
  if (present.length === 0) return context;
  const redacted = { ...context };
  for (const k of present) redacted[k] = "[redacted]";
  return redacted;
}

/**
 * The one-line `scope: <compact json>` banner printed when the registration
 * has an `instantiate` hook — redacted per `contextRedactKeys`. Plain text;
 * the caller applies ANSI dimming.
 */
export function formatScopeBanner(
  context: Record<string, unknown> | undefined,
  redactKeys: readonly string[] | undefined,
): string {
  const redacted = redactContextForDisplay(context, redactKeys);
  return `scope: ${JSON.stringify(redacted ?? null)}`;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function streamOnce(conversation: Conversation, message: string): Promise<void> {
  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    await renderStream(conversation.stream(message), controller.signal);
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function runRepl(conversation: Conversation, reg: DiscoveredAgent): Promise<void> {
  const banner = `chatting with ${bold(reg.agent.role.name)} ${dim("·")} ${dim(
    "type /exit to quit",
  )}`;
  process.stdout.write(`${banner}\n\n`);

  for (;;) {
    const input = await text({ message: "you" });
    if (isCancel(input)) {
      process.stdout.write(`${dim("bye.")}\n`);
      return;
    }
    const line = (input as string).trim();
    if (line === "") continue;
    if (line === "/exit" || line === "/quit") {
      process.stdout.write(`${dim("bye.")}\n`);
      return;
    }

    const controller = new AbortController();
    const onSigint = (): void => {
      controller.abort();
    };
    process.on("SIGINT", onSigint);
    try {
      await renderStream(conversation.stream(line), controller.signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\n${red(`error: ${msg}`)}\n`);
    } finally {
      process.off("SIGINT", onSigint);
    }
    process.stdout.write("\n");
  }
}

// ---------------------------------------------------------------------------
// Event rendering
// ---------------------------------------------------------------------------

/**
 * Drain an AgentEvent stream to the terminal. Honours `signal` so Ctrl+C in
 * interactive mode can abort the current exchange.
 */
async function renderStream(
  stream: AsyncGenerator<AgentEvent>,
  signal: AbortSignal,
): Promise<void> {
  let inThinking = false;
  for await (const event of stream) {
    if (signal.aborted) {
      // Drop the rest; the runner will eventually settle.
      await safeReturn(stream);
      process.stdout.write(`\n${yellow("aborted.")}\n`);
      return;
    }
    inThinking = renderEvent(event, inThinking);
  }
}

/**
 * Render a single event. Returns the updated `inThinking` flag so the caller
 * can close a reasoning block cleanly when the next non-thinking event fires.
 */
function renderEvent(event: AgentEvent, inThinking: boolean): boolean {
  switch (event.type) {
    case "agent.message.start":
      process.stdout.write(`${bold("assistant")}: `);
      return inThinking;

    case "agent.message.chunk":
      process.stdout.write(event.delta);
      return inThinking;

    case "agent.thinking.start":
      process.stdout.write(`\n  ${dim("💭 thinking…")}\n`);
      return true;

    case "agent.reasoning":
      if (event.isComplete) {
        process.stdout.write("\n");
        return false;
      }
      process.stdout.write(`  ${dim(`💭 ${event.content}`)}\n`);
      return true;

    case "agent.tool.start": {
      const args = formatArgs(event.arguments);
      process.stdout.write(`\n  ${cyan(`🔧 ${event.toolName}(${args})`)}\n`);
      return inThinking;
    }

    case "agent.tool.end": {
      if (event.error) {
        process.stdout.write(`     ${red(`✗ ${event.error}`)}\n`);
      } else {
        const preview = previewResult(event.result);
        process.stdout.write(`     ${dim(`→ ${preview}`)}\n`);
      }
      return inThinking;
    }

    case "agent.message.complete": {
      const footer = `${event.model} · ${event.inputTokens}↓ ${event.outputTokens}↑`;
      process.stdout.write(`\n${dim(footer)}\n`);
      return inThinking;
    }

    case "agent.error":
      process.stdout.write(`\n  ${red(`⚠ ${event.errorType}: ${event.message}`)}\n`);
      return inThinking;

    default:
      // Ignore iteration/llm/conversation/tool.intent/tool.rejected/etc.
      return inThinking;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Best-effort early-terminate of an async generator without throwing. */
async function safeReturn(stream: AsyncGenerator<AgentEvent>): Promise<void> {
  try {
    await stream.return(undefined);
  } catch {
    // swallow — abort path is best-effort
  }
}

/** Render a tool-call args object compactly; fall back to JSON.stringify. */
function formatArgs(args: Record<string, unknown>): string {
  try {
    const entries = Object.entries(args);
    if (entries.length === 0) return "";
    const parts = entries.map(([k, v]) => `${k}=${shortJson(v)}`);
    const joined = parts.join(", ");
    return joined.length > 120 ? `${joined.slice(0, 117)}...` : joined;
  } catch {
    return "…";
  }
}

/** Collapse a tool result into a single readable line. */
function previewResult(result: unknown): string {
  const s = typeof result === "string" ? result : shortJson(result);
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

function shortJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
function cyan(s: string): string {
  return `\x1b[36m${s}\x1b[0m`;
}
function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}
