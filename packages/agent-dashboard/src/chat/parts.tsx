/**
 * Part renderers — one component per `Part` kind, plus a dispatcher. Adding a
 * new part kind = add a case here; nothing else changes.
 */
import { CodeBlock, Cursor, Markdown } from "./atoms";
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
    case "error":
      return <ErrorPart errorType={part.errorType} message={part.message} />;
    default:
      return null;
  }
}
