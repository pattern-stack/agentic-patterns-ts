/**
 * ChatPanel — messages thread + input area.
 *
 * Pure presentational organism: takes messages + handlers, renders a
 * scrollable thread with user / assistant bubbles, tool call chips, and
 * a thinking badge. Owns its own input field state.
 */

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ChatMessage, ToolCall } from "../../hooks/useChat";
import { Button } from "../atoms/Button";
import { AlertIcon, BotIcon, SendIcon, SparkleIcon, UserIcon, WrenchIcon } from "../atoms/icons";

interface ChatPanelProps {
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  onSend: (content: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function ChatPanel({
  messages,
  streaming,
  error,
  onSend,
  placeholder = "Ask the agent something…",
  disabled = false,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll on every message update so the streaming cursor stays visible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is a prop; its identity changes on every update from useChat
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const submit = () => {
    const trimmed = input.trim();
    if (!trimmed || streaming || disabled) return;
    onSend(trimmed);
    setInput("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-surface)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {messages.length === 0 && !error && <EmptyState disabled={disabled} />}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {error && <ErrorBanner message={error} />}
        <div ref={bottomRef} />
      </div>

      <div
        style={{
          borderTop: "1px solid var(--border-muted)",
          background: "var(--bg-surface)",
          padding: 12,
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={2}
          style={{
            flex: 1,
            resize: "none",
            fontFamily: "inherit",
            fontSize: 13,
            lineHeight: 1.5,
            background: "var(--bg-inset)",
            color: "var(--fg-default)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 10px",
            outline: "none",
          }}
        />
        <Button
          onClick={submit}
          disabled={disabled || streaming || !input.trim()}
          aria-label="Send message"
        >
          <SendIcon size={14} />
          {streaming ? "…" : "Send"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function EmptyState({ disabled }: { disabled: boolean }) {
  return (
    <div
      style={{
        textAlign: "center",
        color: "var(--fg-muted)",
        fontSize: 13,
        padding: "32px 16px",
      }}
    >
      {disabled ? "Select an agent to start chatting." : "Start a conversation below."}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "rgba(248, 81, 73, 0.08)",
        border: "1px solid var(--red)",
        borderRadius: 6,
        padding: "8px 12px",
        color: "var(--red)",
        fontSize: 12,
      }}
    >
      <AlertIcon size={14} />
      <span>{message}</span>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        flexDirection: isUser ? "row-reverse" : "row",
        alignItems: "flex-start",
      }}
    >
      <Avatar role={message.role} />
      <div
        style={{ maxWidth: "min(640px, 78%)", display: "flex", flexDirection: "column", gap: 6 }}
      >
        {!isUser && message.thinking && <ThinkingChip text={message.thinking} />}
        {message.toolCalls.map((tc) => (
          <ToolCallChip key={tc.id} call={tc} />
        ))}
        {(message.content || !isUser) && (
          <Bubble role={message.role} streaming={message.streaming} content={message.content} />
        )}
        {!isUser && (message.inputTokens !== undefined || message.model) && (
          <Footer message={message} />
        )}
      </div>
    </div>
  );
}

function Avatar({ role }: { role: ChatMessage["role"] }) {
  const isUser = role === "user";
  return (
    <div
      style={{
        width: 28,
        height: 28,
        flexShrink: 0,
        borderRadius: "50%",
        background: isUser ? "var(--bg-surface-hover)" : "var(--accent-emerald-dim)",
        color: isUser ? "var(--fg-muted)" : "var(--accent-emerald)",
        border: "1px solid var(--border-muted)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {isUser ? <UserIcon size={14} /> : <BotIcon size={14} />}
    </div>
  );
}

function Bubble({
  role,
  content,
  streaming,
}: {
  role: ChatMessage["role"];
  content: string;
  streaming?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div
      style={{
        background: isUser ? "var(--bg-surface-hover)" : "var(--bg-canvas)",
        border: `1px solid ${isUser ? "var(--border-muted)" : "var(--border)"}`,
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 13,
        lineHeight: 1.55,
        color: "var(--fg-default)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {content}
      {streaming && <Cursor />}
    </div>
  );
}

function Cursor() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 7,
        height: 14,
        marginLeft: 2,
        background: "var(--accent-emerald)",
        verticalAlign: "-2px",
        animation: "apdash-blink 1s steps(2, start) infinite",
      }}
    />
  );
}

function ThinkingChip({ text }: { text: string }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "flex-start",
        gap: 6,
        background: "rgba(188, 140, 255, 0.08)",
        border: "1px solid var(--purple)",
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 12,
        color: "var(--purple)",
        fontFamily: "var(--font-mono)",
        lineHeight: 1.5,
      }}
    >
      <SparkleIcon size={12} />
      <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text}</span>
    </div>
  );
}

function hasArguments(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return Object.keys(args as Record<string, unknown>).length > 0;
}

function ToolCallChip({ call }: { call: ToolCall }) {
  const state = call.error ? "error" : call.result !== undefined ? "ok" : "pending";
  const stateColor =
    state === "error" ? "var(--red)" : state === "ok" ? "var(--green)" : "var(--yellow)";
  return (
    <div
      style={{
        background: "var(--bg-canvas)",
        border: "1px solid var(--border-muted)",
        borderRadius: 6,
        padding: "6px 10px",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--fg-muted)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <WrenchIcon size={12} />
        <span style={{ color: stateColor }}>●</span>
        <span style={{ color: "var(--fg-default)" }}>{call.name}</span>
        {call.durationMs !== undefined && (
          <span style={{ color: "var(--fg-subtle)" }}>{Math.round(call.durationMs)}ms</span>
        )}
      </div>
      {hasArguments(call.arguments) && (
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--fg-subtle)",
          }}
        >
          {JSON.stringify(call.arguments, null, 2)}
        </pre>
      )}
      {call.error && <span style={{ color: "var(--red)" }}>error: {call.error}</span>}
    </div>
  );
}

function Footer({ message }: { message: ChatMessage }) {
  const parts: string[] = [];
  if (message.model) parts.push(message.model);
  if (message.inputTokens !== undefined) parts.push(`${message.inputTokens} in`);
  if (message.outputTokens !== undefined) parts.push(`${message.outputTokens} out`);
  if (!parts.length) return null;
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--fg-subtle)",
        fontFamily: "var(--font-mono)",
      }}
    >
      {parts.join(" · ")}
    </div>
  );
}
