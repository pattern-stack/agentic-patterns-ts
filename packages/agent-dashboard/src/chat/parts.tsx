/**
 * Part renderers — one component per `Part` kind, plus a dispatcher. Adding a
 * new part kind = add a case here; nothing else changes.
 */
import { useState } from "react";
import { CodeBlock, Cursor, Markdown } from "./atoms";
import { type InputAnswer, useInputResponder } from "./input-responder";
import type { Part } from "./model";

const fmt = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};
const preview = (s: string, n = 72): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/* ── text ───────────────────────────────────────────────────────────────────*/
function TextPart({
  content,
  role,
  streaming,
}: { content: string; role: "user" | "assistant"; streaming?: boolean }) {
  // User text is plain (no markdown surprises); assistant text is markdown.
  if (role === "user") {
    return (
      <div className={`chat-bubble ${role}`}>
        <span style={{ whiteSpace: "pre-wrap" }}>{content}</span>
        {streaming && <Cursor />}
      </div>
    );
  }
  return (
    <div className={`chat-bubble ${role}`} style={{ position: "relative" }}>
      <Markdown content={content} className="chat-bubble assistant" />
      {streaming && <Cursor />}
    </div>
  );
}

/* ── thinking ───────────────────────────────────────────────────────────────*/
function ThinkingPart({ content, complete }: { content: string; complete: boolean }) {
  const empty = !content.trim();
  // Redacted/signature-only thinking: a non-interactive chip, not a fake toggle.
  if (complete && empty) {
    return (
      <div
        className="chat-thinking"
        style={{ padding: "6px 11px", fontSize: "var(--fz-tiny)", color: "var(--mute)" }}
      >
        <span className="glyph">✦</span> reasoned privately
      </div>
    );
  }
  return (
    <details className="chat-thinking" open={!complete}>
      <summary>
        <span className="glyph">✦</span>
        {complete ? "Thought" : "Thinking…"}
        {complete && content.trim() && (
          <span style={{ color: "var(--mute)" }}>· {preview(content.replace(/\s+/g, " "))}</span>
        )}
      </summary>
      <div className="thinking-body">{content}</div>
    </details>
  );
}

/* ── tool call ──────────────────────────────────────────────────────────────*/
function ToolCallPart({ part }: { part: Extract<Part, { kind: "tool_call" }> }) {
  const running = part.result === undefined && !part.error;
  const status = part.error ? "err" : running ? "running" : "ok";
  const badge = part.rejected ? "⊘" : part.error ? "✗" : running ? "⋯" : "✓";
  const args = fmt(part.arguments);
  const out = fmt(part.result);
  return (
    <details className={`chat-tool ${status}`} open={!!part.error}>
      <summary>
        <span aria-hidden>{badge}</span>
        <span className="tool-name">{part.name}</span>
        {part.durationMs != null && <span className="tool-dur">{part.durationMs}ms</span>}
      </summary>
      <div className="tool-io">
        {args && (
          <div>
            <div className="io-label">input</div>
            <CodeBlock text={args} copyable maxHeight={180} />
          </div>
        )}
        {part.error ? (
          <div>
            <div className="io-label">{part.rejected ? "rejected" : "error"}</div>
            <CodeBlock text={part.error} danger />
          </div>
        ) : (
          out && (
            <div>
              <div className="io-label">output</div>
              <CodeBlock text={out} copyable maxHeight={240} />
            </div>
          )
        )}
      </div>
    </details>
  );
}

/* ── agent step (delegation) ─────────────────────────────────────────────────*/
function AgentStepPart({
  part,
  role,
  streaming,
}: {
  part: Extract<Part, { kind: "agent_step" }>;
  role: "user" | "assistant";
  streaming?: boolean;
}) {
  const running = part.result === undefined && !part.error;
  const status = part.error ? "err" : running ? "running" : "ok";
  const badge = part.error ? "✗" : running ? "⋯" : "✓";
  const args = fmt(part.arguments);
  const out = fmt(part.result);
  return (
    <details className={`chat-tool chat-step ${status}`} open={running || !!part.error}>
      <summary>
        <span aria-hidden>◆</span>
        <span className="tool-name">{part.name}</span>
        <span className="step-kind">agent{part.agentName ? ` · ${part.agentName}` : ""}</span>
        {part.durationMs != null && <span className="tool-dur">{part.durationMs}ms</span>}
        <span aria-hidden>{badge}</span>
      </summary>
      <div className="tool-io">
        {args && (
          <div>
            <div className="io-label">input</div>
            <CodeBlock text={args} copyable maxHeight={180} />
          </div>
        )}
        {part.error ? (
          <div>
            <div className="io-label">error</div>
            <CodeBlock text={part.error} danger />
          </div>
        ) : (
          out && (
            <div>
              <div className="io-label">output</div>
              <CodeBlock text={out} copyable maxHeight={240} />
            </div>
          )
        )}
        {part.children.length > 0 && (
          <div className="step-children">
            <div className="io-label">tools called</div>
            {part.children.map((child, i) => (
              <PartView
                key={child.kind === "tool_call" ? child.id : i}
                part={child}
                role={role}
                streaming={streaming}
              />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

/* ── human-input request (approval / select / text) ──────────────────────────*/
function InputRequestPart({ part }: { part: Extract<Part, { kind: "input_request" }> }) {
  const respond = useInputResponder();
  const [answered, setAnswered] = useState<InputAnswer | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const answer = async (a: InputAnswer) => {
    if (answered || busy || !respond) return;
    setBusy(true);
    try {
      await respond(part.correlationId, a);
      setAnswered(a);
    } finally {
      setBusy(false);
    }
  };

  const args = fmt(part.arguments);
  const resolved =
    answered &&
    (answered.decision === "deny"
      ? "⊘ Denied"
      : answered.value !== undefined
        ? `✓ ${answered.value}`
        : "✓ Approved");

  return (
    <div className={`chat-approval${answered ? " resolved" : ""}`}>
      <div className="approval-head">
        <span aria-hidden>⏸</span>
        <span className="approval-prompt">{part.prompt}</span>
        {part.toolName && <span className="approval-tool">{part.toolName}</span>}
      </div>
      {args && (
        <div className="approval-args">
          <CodeBlock text={args} copyable maxHeight={140} />
        </div>
      )}
      {resolved ? (
        <div className="approval-resolved">{resolved}</div>
      ) : !respond ? (
        <div className="approval-readonly">Awaiting a decision (read-only view).</div>
      ) : part.inputKind === "select" ? (
        <div className="approval-actions">
          {(part.options ?? []).map((opt) => (
            <button
              key={opt}
              type="button"
              className="approval-btn"
              disabled={busy}
              onClick={() => answer({ decision: "approve", value: opt })}
            >
              {opt}
            </button>
          ))}
          <button
            type="button"
            className="approval-btn deny"
            disabled={busy}
            onClick={() => answer({ decision: "deny" })}
          >
            Cancel
          </button>
        </div>
      ) : part.inputKind === "text" ? (
        <form
          className="approval-actions"
          onSubmit={(e) => {
            e.preventDefault();
            answer({ decision: "approve", value: text });
          }}
        >
          <input
            className="approval-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a response…"
          />
          <button type="submit" className="approval-btn" disabled={busy || !text.trim()}>
            Send
          </button>
        </form>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            className="approval-btn approve"
            disabled={busy}
            onClick={() => answer({ decision: "approve" })}
          >
            Approve
          </button>
          <button
            type="button"
            className="approval-btn deny"
            disabled={busy}
            onClick={() => answer({ decision: "deny" })}
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

/* ── error ──────────────────────────────────────────────────────────────────*/
function ErrorPart({ errorType, message }: { errorType: string; message: string }) {
  return (
    <div className="chat-error">
      <span aria-hidden>⚠</span>
      <span>
        <strong style={{ fontFamily: "var(--font-mono)" }}>{errorType}</strong>
        {message ? ` — ${message}` : ""}
      </span>
    </div>
  );
}

/* ── dispatcher ─────────────────────────────────────────────────────────────*/
export function PartView({
  part,
  role,
  streaming,
}: {
  part: Part;
  role: "user" | "assistant";
  streaming?: boolean;
}) {
  switch (part.kind) {
    case "text":
      return <TextPart content={part.content} role={role} streaming={streaming} />;
    case "thinking":
      return <ThinkingPart content={part.content} complete={part.complete} />;
    case "tool_call":
      return <ToolCallPart part={part} />;
    case "agent_step":
      return <AgentStepPart part={part} role={role} streaming={streaming} />;
    case "input_request":
      return <InputRequestPart part={part} />;
    case "error":
      return <ErrorPart errorType={part.errorType} message={part.message} />;
    default:
      return null;
  }
}
