/**
 * MessageRow — one message: avatar + attribution + the dispatched parts + an
 * optional model/token footer. Streaming-first: the live cursor rides the last
 * text part, and an empty still-streaming assistant message shows the waiting
 * indicator instead of an empty bubble.
 */
import { Avatar, Dots, RelativeTime } from "./atoms";
import { type ChatMessage, coalesceStateParts } from "./model";
import { PartView } from "./parts";

function MessageFooter({ message }: { message: ChatMessage }) {
  const bits: string[] = [];
  if (message.model) bits.push(message.model);
  if (message.inputTokens != null) bits.push(`${message.inputTokens.toLocaleString()} in`);
  if (message.outputTokens != null) bits.push(`${message.outputTokens.toLocaleString()} out`);
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
  // index of the last text part — the only one that carries the live cursor.
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
