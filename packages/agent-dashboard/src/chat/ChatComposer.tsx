/**
 * ChatComposer — the input molecule. Auto-growing textarea, Enter-to-send
 * (Shift+Enter = newline), Escape to abort an in-flight stream. Send/Stop swap
 * on `streaming`. Optional; ChatPanel renders it only when `onSend` is provided.
 */
import { type KeyboardEvent, useRef, useState } from "react";
import { Button } from "../components/atoms/Button";

export function ChatComposer({
  onSend,
  onAbort,
  streaming,
  disabled,
  placeholder = "Send a message…",
}: {
  onSend: (text: string) => void;
  onAbort?: () => void;
  streaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const submit = () => {
    const t = value.trim();
    if (!t || disabled || streaming) return;
    onSend(t);
    setValue("");
    if (ref.current) ref.current.style.height = "auto";
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && streaming && onAbort) {
      e.preventDefault();
      onAbort();
    }
  };

  return (
    <div className="chat-composer">
      <textarea
        ref={ref}
        value={value}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          setValue(e.target.value);
          grow();
        }}
        onKeyDown={onKeyDown}
      />
      {streaming && onAbort ? (
        <Button variant="ghost" onClick={onAbort}>
          Stop
        </Button>
      ) : (
        <Button variant="primary" onClick={submit} disabled={disabled || !value.trim()}>
          Send
        </Button>
      )}
    </div>
  );
}
