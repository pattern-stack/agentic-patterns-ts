/**
 * MessageRow — one message: avatar + attribution + the dispatched parts + an
 * optional model/token footer. Streaming-first: an empty still-streaming
 * assistant message (no renderable text yet) shows the waiting indicator
 * instead of an empty bubble.
 */
import { Avatar, Dots, RelativeTime } from "./atoms";
import { type ChatMessage, coalesceStateParts } from "./model";
import { PartView } from "./parts";

/** Format a USD cost: sub-cent values keep 4 decimals, else 2 (#324). */
function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function MessageFooter({ message }: { message: ChatMessage }) {
  const bits: string[] = [];
  if (message.model) bits.push(message.model);
  if (message.inputTokens != null) bits.push(`${message.inputTokens.toLocaleString()} in`);
  if (message.outputTokens != null) bits.push(`${message.outputTokens.toLocaleString()} out`);
  // #324: run cost when the harness reported it (CC runs).
  if (message.costUsd != null) bits.push(formatCost(message.costUsd));
  if (!bits.length) return null;
  return <div className="chat-footer">{bits.join(" · ")}</div>;
}

export function WaitingIndicator({ label = "thinking" }: { label?: string }) {
  return (
    <div className="chat-waiting">
      <Dots />
      <span>{label}…</span>
    </div>
  );
}

export function MessageRow({
  message,
  assistantName = "agent",
  showAttribution = true,
}: {
  message: ChatMessage;
  assistantName?: string;
  showAttribution?: boolean;
}) {
  const { role, streaming } = message;
  // #226: render-time view — 3+ consecutive same-site state frames fold into
  // one `state_group` summary card (load-bearing for Loop / parallel-drop
  // runs). Pure function of the parts; the message itself is untouched.
  const parts = coalesceStateParts(message.parts);
  // index of the last text part — used to decide the waiting affordance below
  // (an assistant turn streaming with no text part yet).
  const lastTextIdx = (() => {
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i]?.kind === "text") return i;
    return -1;
  })();
  // An assistant turn that has started streaming but produced no renderable text
  // yet (e.g. only tool calls running, or nothing at all) → waiting affordance.
  const onlyToolsOrEmpty = streaming && lastTextIdx === -1;

  return (
    <div className={`chat-row ${role}`}>
      <Avatar role={role} />
      <div className="chat-body">
        {showAttribution && (
          <div className="chat-attr">
            <span className="name">{role === "assistant" ? assistantName : "You"}</span>
            <RelativeTime at={message.at} />
          </div>
        )}
        {parts.map((part, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only and stable by position.
          <PartView key={i} part={part} role={role} />
        ))}
        {onlyToolsOrEmpty && (
          <WaitingIndicator
            label={parts.some((p) => p.kind === "tool_call") ? "running tools" : "thinking"}
          />
        )}
        {role === "assistant" && !streaming && <MessageFooter message={message} />}
      </div>
    </div>
  );
}
