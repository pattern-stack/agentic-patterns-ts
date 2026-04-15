/**
 * `ap run <agentId> [message]` — chat with a single agent from the terminal.
 *
 * Two modes:
 *   • one-shot — `message` provided; stream once, print, exit.
 *   • interactive — no `message`; REPL loop via @clack/prompts.
 *
 * Rendering is raw ANSI (no chalk dep). Events come from the runtime as a
 * discriminated `AgentEvent` union; we project each type to a terminal line.
 */

import {
  Conversation,
  createRunner,
  createToolboxExecutor,
  getAgentEventBus,
} from "@pattern-stack/agent-runtime";
import type { AgentEvent } from "@pattern-stack/agent-runtime";
import { isCancel, text } from "@clack/prompts";
import type { DiscoveredAgent } from "../helpers/discover.js";

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

  const eventBus = getAgentEventBus();
  const { runner } = await createRunner({ eventBus, verbose: false });

  const conversation = new Conversation(reg.agent, runner, {
    toolExecutor: createToolboxExecutor(reg.agent),
  });

  if (opts.message !== undefined) {
    await streamOnce(conversation, opts.message);
    return;
  }

  await runRepl(conversation, reg);
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
