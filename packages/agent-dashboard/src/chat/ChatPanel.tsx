/**
 * ChatPanel — the reusable chat ORGANISM. Streaming-first: pass live
 * `ChatMessage[]` (assembled incrementally via model.applyParts / the useChat
 * hook) and it renders the thread, follows the tail with a scroll-lock, and —
 * when given `onSend` — shows the composer.
 *
 * Two sizes from one component:
 *   size="full"     reading-width column for a full console (the ask view).
 *   size="compact"  tight padding / small avatars for an embedded dock, card,
 *                   or sidebar. Fills its parent (give the parent a height).
 *
 * Read-only surfaces (replaying a persisted run) simply omit `onSend` and pass
 * already-complete messages (no `streaming` flag).
 */
import { useEffect, useRef, useState } from 'react';
import './chat.css';
import { ChatComposer } from './ChatComposer';
import { MessageRow } from './MessageRow';
import type { ChatMessage } from './model';

export interface ChatPanelProps {
  messages: ChatMessage[];
  size?: 'full' | 'compact';
  /** Fill a height-bounded parent with an inner scroll (docks/panels). Default
   *  grows with content and lets the page scroll (in-page consoles). */
  fill?: boolean;
  assistantName?: string;
  emptyLabel?: string;
  /** Provide to render the composer + drive sends. Omit for a read-only thread. */
  onSend?: (text: string) => void;
  onAbort?: () => void;
  streaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

const NEAR_BOTTOM_PX = 48;

export function ChatPanel({
  messages,
  size = 'full',
  fill = false,
  assistantName = 'agent',
  emptyLabel = 'No messages yet.',
  onSend,
  onAbort,
  streaming,
  disabled,
  placeholder,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true); // following the tail?

  // Follow the tail while the user is at/near the bottom; release the lock the
  // moment they scroll up so streaming tokens don't yank them back down.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stuck) return;
    el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    setStuck(atBottom);
  };

  const jump = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStuck(true);
  };

  return (
    <div className={`chat-root ${size}${fill ? ' fill' : ''}`} style={{ position: 'relative' }}>
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="chat-empty">{emptyLabel}</div>
        ) : (
          messages.map((m) => <MessageRow key={m.id} message={m} assistantName={assistantName} />)
        )}
      </div>
      {!stuck && messages.length > 0 && (
        <button type="button" className="chat-jump" onClick={jump}>
          ↓ latest
        </button>
      )}
      {onSend && (
        <ChatComposer onSend={onSend} onAbort={onAbort} streaming={streaming} disabled={disabled} placeholder={placeholder} />
      )}
    </div>
  );
}
