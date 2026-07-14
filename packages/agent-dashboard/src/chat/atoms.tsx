/**
 * Chat atoms — the smallest themed primitives the chat organism composes from.
 * All token-driven (scoped chat tokens via chat.css class hooks).
 */
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import type { Role } from "./model";

// Re-exported for this file's existing call sites — canonical definition now
// lives in components/kit/Markdown.tsx so non-chat surfaces can reuse it
// without reaching into `chat/`.
export { Markdown } from "../components/kit/Markdown";

/* ── Avatar ─────────────────────────────────────────────────────────────────*/
export function Avatar({ role }: { role: Role }) {
  return (
    <div className={`chat-avatar ${role}`} aria-hidden>
      {role === "assistant" ? "◆" : "›"}
    </div>
  );
}

/* ── Streaming cursor ───────────────────────────────────────────────────────*/
export function Cursor() {
  return <span className="chat-cursor" aria-hidden />;
}

/* ── Bouncing dots (waiting) ────────────────────────────────────────────────*/
export function Dots() {
  return (
    <span className="chat-dots" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

/* ── Relative timestamp (auto-refreshing) ───────────────────────────────────*/
function relative(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(at).toLocaleDateString();
}
export function RelativeTime({ at }: { at?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (at == null) return;
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [at]);
  if (at == null) return null;
  return (
    <time
      className="time"
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
    >
      {relative(at)}
    </time>
  );
}

/* ── CodeBlock (tool io / raw payloads) ─────────────────────────────────────*/
export function CodeBlock({
  text,
  danger,
  copyable,
  maxHeight,
}: {
  text: string;
  danger?: boolean;
  copyable?: boolean;
  maxHeight?: number;
}) {
  const style: CSSProperties | undefined = maxHeight != null ? { maxHeight } : undefined;
  return (
    <pre className={`chat-code${danger ? " danger" : ""}`} style={style}>
      {copyable && <CopyChip text={text} />}
      {text}
    </pre>
  );
}

/* ── Copy chip (reuses the .copy-btn surface) ───────────────────────────────*/
export function CopyChip({ text }: { text: string }) {
  const [label, setLabel] = useState("copy");
  const copy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const t = String(text ?? "").trim();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      setLabel("copied!");
    } catch {
      setLabel("failed");
    }
    setTimeout(() => setLabel("copy"), 1300);
  };
  return (
    <button type="button" className="copy-btn" onClick={copy} title="Copy">
      {label}
    </button>
  );
}

/* ── tiny presentational wrapper used by parts/rows ─────────────────────────*/
export function Stack({ children, gap = 6 }: { children: ReactNode; gap?: number }) {
  return <div style={{ display: "flex", flexDirection: "column", gap }}>{children}</div>;
}
