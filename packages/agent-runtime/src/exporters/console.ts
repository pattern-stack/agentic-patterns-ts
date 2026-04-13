/**
 * Console exporter - plain text output for agent execution.
 *
 * Provides terminal output via EventBus subscription.
 * Uses a Logger interface to avoid hard dependency on Node globals.
 *
 * Ported from Python: systems/exporters/console.py
 */

import { EventProfile } from "../events/event-profiles.js";
import type {
  ErrorEvent,
  MessageChunkEvent,
  MessageCompleteEvent,
  MessageStartEvent,
  ReasoningEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "../events/types.js";
import { BaseExporter } from "./base.js";

/** Logger interface for console output. */
export interface ConsoleLogger {
  log(message: string): void;
  error(message: string): void;
  write(text: string): void;
}

/** No-op logger that silently discards output. */
function noopLogger(): ConsoleLogger {
  return {
    log: () => {},
    error: () => {},
    write: () => {},
  };
}

/**
 * Console exporter that prints agent events to stdout.
 *
 * Subscribes to UX profile events and renders them as plain text.
 */
export class ConsoleExporter extends BaseExporter {
  override profile = EventProfile.UX;

  private _verbose: boolean;
  private _logger: ConsoleLogger;
  private _contentBuffer: string[] = [];
  private _toolNames = new Map<string, string>();

  constructor(options?: { verbose?: boolean; logger?: ConsoleLogger }) {
    super();
    this._verbose = options?.verbose ?? true;
    this._logger = options?.logger ?? noopLogger();
  }

  /** @internal */
  async _onMessageStart(_event: MessageStartEvent): Promise<void> {
    if (this._verbose) {
      this._logger.log("");
      this._logger.log("-".repeat(60));
      this._logger.log("Agent thinking...");
    }
  }

  /** @internal */
  async _onMessageChunk(event: MessageChunkEvent): Promise<void> {
    this._contentBuffer.push(event.delta);
    this._logger.write(event.delta);
  }

  /** @internal */
  async _onMessageComplete(event: MessageCompleteEvent): Promise<void> {
    // Only render full content if nothing was streamed
    if (this._contentBuffer.length === 0 && event.content) {
      this._logger.log("");
      this._logger.log(event.content);
    }

    this._logger.log(""); // Newline after content

    if (this._verbose) {
      this._logger.log(
        `Tokens: ${event.inputTokens} in / ${event.outputTokens} out | Model: ${event.model}`,
      );
    }

    this._contentBuffer = [];
  }

  /** @internal */
  async _onReasoning(event: ReasoningEvent): Promise<void> {
    if (event.isComplete) return;
    if (this._verbose) {
      const content =
        event.content.length > 500 ? `${event.content.slice(0, 500)}...` : event.content;
      this._logger.log(`[Reasoning] ${content}`);
      this._logger.log("");
    }
  }

  /** @internal */
  async _onToolStart(event: ToolCallStartEvent): Promise<void> {
    this._toolNames.set(event.toolCallId, event.toolName);
    if (this._verbose) {
      this._logger.log(`  Tool: ${event.toolName}...`);
    }
  }

  /** @internal */
  async _onToolEnd(event: ToolCallEndEvent): Promise<void> {
    const toolName = this._toolNames.get(event.toolCallId) ?? event.toolName;
    this._toolNames.delete(event.toolCallId);

    if (this._verbose) {
      if (event.error) {
        this._logger.log(`  Error: ${event.error}`);
      } else {
        this._logger.log(`  Done: ${toolName} (${event.durationMs}ms)`);
      }
    }
  }

  /** @internal */
  async _onError(event: ErrorEvent): Promise<void> {
    this._logger.log("");
    this._logger.error(`Error [${event.errorType}]: ${event.message}`);
  }
}

/**
 * Factory function for console exporter.
 */
export function createConsoleExporter(options?: {
  verbose?: boolean;
  logger?: ConsoleLogger;
}): ConsoleExporter {
  return new ConsoleExporter(options);
}
