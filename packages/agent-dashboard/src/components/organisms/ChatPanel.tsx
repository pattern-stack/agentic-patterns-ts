/**
 * ChatPanel — messages thread + input area.
 *
 * Renders each assistant message as an ordered list of typed Parts
 * (text / thinking / tool_call / error) so text and tool calls
 * interleave in their arrival order, mirroring pattern-stack/chat-patterns.
 *
 * Defaults match the chat-patterns TUI:
 *   - tool calls   collapsed, click header to expand
 *   - thinking     collapsed with first-line summary, click to expand
 *   - text         markdown-rendered (GFM) with a blinking cursor while
 *                  the part is still streaming
 */

import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, Part } from "../../hooks/useChat";
import { Badge } from "../atoms/Badge";
import { Button } from "../atoms/Button";
import { Spinner } from "../atoms/Spinner";
import { AlertIcon, BotIcon, SendIcon, SparkleIcon, UserIcon, WrenchIcon } from "../atoms/icons";

interface ChatPanelProps {
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  onSend: (content: string) => void;
  onAbort?: () => void;
  placeholder?: string;
  disabled?: boolean;
}

export function ChatPanel({
  messages,
  streaming,
  error,
  onSend,
  onAbort,
  placeholder = "Ask the agent something…",
  disabled = false,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll on every message-state tick so the cursor stays in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages identity changes on every useChat update
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
    } else if (e.key === "Escape" && streaming) {
      e.preventDefault();
      onAbort?.();
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
          gap: 20,
        }}
      >
        {messages.length === 0 && !error && <EmptyState disabled={disabled} />}
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} />
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
        {streaming ? (
          <Button variant="ghost" onClick={onAbort} aria-label="Stop streaming">
            <Spinner size={12} color="var(--fg-muted)" />
            Stop
          </Button>
        ) : (
          <Button onClick={submit} disabled={disabled || !input.trim()} aria-label="Send message">
            <SendIcon size={14} />
            Send
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message row
// ---------------------------------------------------------------------------

function MessageRow({ message }: { message: ChatMessage }) {
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
        style={{
          maxWidth: "min(720px, 82%)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {message.parts.map((part, i) => (
          <PartView
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only and stable by position
            key={i}
            part={part}
            role={message.role}
            isLast={i === message.parts.length - 1}
            streaming={message.streaming ?? false}
          />
        ))}
        {/* Assistant with no parts yet — show a waiting indicator. */}
        {!isUser && message.parts.length === 0 && message.streaming && <WaitingIndicator />}
        {!isUser && message.aborted && (
          <div style={{ fontSize: 11, color: "var(--fg-muted)", fontStyle: "italic" }}>stopped</div>
        )}
        {!isUser && (message.inputTokens !== undefined || message.model) && (
          <MessageFooter message={message} />
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

function MessageFooter({ message }: { message: ChatMessage }) {
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

// ---------------------------------------------------------------------------
// Part renderers
// ---------------------------------------------------------------------------

interface PartViewProps {
  part: Part;
  role: ChatMessage["role"];
  isLast: boolean;
  streaming: boolean;
}

function PartView({ part, role, isLast, streaming }: PartViewProps) {
  switch (part.kind) {
    case "text":
      return <TextPart content={part.content} role={role} showCursor={isLast && streaming} />;
    case "thinking":
      return <ThinkingPart content={part.content} complete={part.complete} />;
    case "tool_call":
      return <ToolCallPart part={part} />;
    case "error":
      return <ErrorPart message={part.message} errorType={part.errorType} />;
    default: {
      const _: never = part;
      void _;
      return null;
    }
  }
}

function TextPart({
  content,
  role,
  showCursor,
}: {
  content: string;
  role: ChatMessage["role"];
  showCursor: boolean;
}) {
  const isUser = role === "user";
  return (
    <div
      style={{
        background: isUser ? "var(--bg-surface-hover)" : "var(--bg-canvas)",
        border: `1px solid ${isUser ? "var(--border-muted)" : "var(--border)"}`,
        borderRadius: 8,
        padding: "10px 14px",
        fontSize: 13,
        lineHeight: 1.55,
        color: "var(--fg-default)",
        wordBreak: "break-word",
      }}
    >
      <Markdown>{content}</Markdown>
      {showCursor && <Cursor />}
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

function ThinkingPart({ content, complete }: { content: string; complete: boolean }) {
  const [expanded, setExpanded] = useState(!complete);
  // Auto-collapse when thinking completes, if the user hasn't interacted.
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const summary = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine || "thinking";

  return (
    <div
      style={{
        background: "rgba(188, 140, 255, 0.06)",
        border: "1px solid var(--purple)",
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 12,
        color: "var(--purple)",
        fontFamily: "var(--font-mono)",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: "inherit",
          padding: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          textAlign: "left",
        }}
      >
        {complete ? (
          <span style={{ width: 12, display: "inline-block", textAlign: "center" }}>
            {expanded ? "▾" : "▸"}
          </span>
        ) : (
          <Spinner size={10} color="var(--purple)" />
        )}
        <SparkleIcon size={11} />
        <span style={{ color: "var(--fg-default)", fontWeight: 500 }}>thinking</span>
        {!expanded && (
          <span
            style={{
              color: "var(--fg-muted)",
              overflow: "hidden",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
              flex: 1,
            }}
          >
            {summary}
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            marginTop: 6,
            paddingLeft: 10,
            borderLeft: "2px solid var(--purple)",
            whiteSpace: "pre-wrap",
            color: "var(--fg-muted)",
            fontStyle: "italic",
            lineHeight: 1.55,
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}

function ToolCallPart({ part }: { part: Extract<Part, { kind: "tool_call" }> }) {
  const [expanded, setExpanded] = useState(false);
  const done = part.result !== undefined || part.error !== undefined;
  const stateTone = part.error ? "red" : done ? "green" : "yellow";
  const stateIcon = part.error ? "✗" : done ? "✓" : "◯";

  return (
    <div
      style={{
        background: "var(--bg-canvas)",
        border: "1px solid var(--border-muted)",
        borderRadius: 6,
        overflow: "hidden",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          background: "transparent",
          border: "none",
          color: "var(--fg-default)",
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: "inherit",
          textAlign: "left",
        }}
      >
        <span style={{ width: 12, display: "inline-block", textAlign: "center" }}>
          {expanded ? "▾" : "▸"}
        </span>
        {done ? (
          <Badge tone={stateTone} variant="outline" style={{ padding: "1px 6px" }}>
            {stateIcon}
          </Badge>
        ) : (
          <Spinner size={10} color="var(--yellow)" />
        )}
        <WrenchIcon size={11} />
        <span style={{ color: "var(--fg-default)" }}>{part.name}</span>
        {part.durationMs !== undefined && (
          <span style={{ color: "var(--fg-subtle)", marginLeft: "auto" }}>
            {Math.round(part.durationMs)}ms
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            borderTop: "1px solid var(--border-muted)",
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            color: "var(--fg-muted)",
          }}
        >
          {hasArguments(part.arguments) && (
            <Section label="input">
              <pre style={sectionPreStyle}>{JSON.stringify(part.arguments, null, 2)}</pre>
            </Section>
          )}
          {part.result !== undefined && (
            <Section label="output">
              <pre style={sectionPreStyle}>{formatResult(part.result)}</pre>
            </Section>
          )}
          {part.error && (
            <Section label="error" tone="red">
              <pre style={{ ...sectionPreStyle, color: "var(--red)" }}>{part.error}</pre>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

const sectionPreStyle = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  color: "var(--fg-muted)",
} as const;

function Section({
  label,
  tone = "muted",
  children,
}: {
  label: string;
  tone?: "muted" | "red";
  children: ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: tone === "red" ? "var(--red)" : "var(--fg-subtle)",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function ErrorPart({ message, errorType }: { message: string; errorType: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        background: "rgba(248, 81, 73, 0.08)",
        border: "1px solid var(--red)",
        borderRadius: 6,
        padding: "8px 12px",
        color: "var(--red)",
        fontSize: 12,
        fontFamily: "var(--font-mono)",
      }}
    >
      <AlertIcon size={14} />
      <span style={{ wordBreak: "break-word" }}>
        <span style={{ fontWeight: 600 }}>{errorType}</span>: {message}
      </span>
    </div>
  );
}

function WaitingIndicator() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        color: "var(--fg-muted)",
        fontSize: 12,
        fontFamily: "var(--font-mono)",
      }}
    >
      <Spinner size={10} />
      thinking…
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
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

function hasArguments(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return Object.keys(args as Record<string, unknown>).length > 0;
}

function formatResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/**
 * Markdown renderer using react-markdown + remark-gfm. Styled with
 * inline overrides rather than CSS so we stay dependency-free on CSS
 * modules / tailwind. Code blocks and inline code use our mono stack.
 */
function Markdown({ children }: { children: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children: c }) => <p style={{ margin: 0 }}>{c}</p>,
          a: ({ href, children: c }) => (
            <a href={href} style={{ color: "var(--accent)" }} target="_blank" rel="noreferrer">
              {c}
            </a>
          ),
          code: ({ className, children: c, ...rest }) => {
            const isBlock = (className ?? "").startsWith("language-");
            if (isBlock) return <code className={className}>{c}</code>;
            return (
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.9em",
                  background: "var(--bg-surface-hover)",
                  border: "1px solid var(--border-muted)",
                  borderRadius: 3,
                  padding: "1px 4px",
                }}
                {...rest}
              >
                {c}
              </code>
            );
          },
          pre: ({ children: c }) => (
            <pre
              style={{
                margin: 0,
                padding: 10,
                background: "var(--bg-inset)",
                border: "1px solid var(--border-muted)",
                borderRadius: 6,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                overflowX: "auto",
                whiteSpace: "pre",
              }}
            >
              {c}
            </pre>
          ),
          ul: ({ children: c }) => <ul style={{ margin: 0, paddingLeft: 20 }}>{c}</ul>,
          ol: ({ children: c }) => <ol style={{ margin: 0, paddingLeft: 20 }}>{c}</ol>,
          li: ({ children: c }) => <li style={{ margin: "2px 0" }}>{c}</li>,
          blockquote: ({ children: c }) => (
            <blockquote
              style={{
                margin: 0,
                paddingLeft: 10,
                borderLeft: "3px solid var(--border)",
                color: "var(--fg-muted)",
              }}
            >
              {c}
            </blockquote>
          ),
          h1: ({ children: c }) => (
            <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>{c}</h1>
          ),
          h2: ({ children: c }) => (
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{c}</h2>
          ),
          h3: ({ children: c }) => (
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{c}</h3>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
