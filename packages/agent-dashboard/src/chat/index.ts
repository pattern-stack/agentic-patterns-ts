/**
 * Chat organism — public surface. Import from here:
 *
 *   import { ChatPanel, useChat } from "../chat";
 *
 * ChatPanel    — the organism (size="full" | "compact"; optional composer).
 * useChat       — streaming-first driver over the framework SSE transport.
 * model         — Part / ChatMessage types + the applyParts reducer + folders.
 */
export { ChatPanel, type ChatPanelProps } from './ChatPanel';
export { useChat, type UseChatResult } from './useChat';
export { MessageRow, WaitingIndicator } from './MessageRow';
export { ChatComposer } from './ChatComposer';
export {
  type ChatMessage,
  type Part,
  type Role,
  applyParts,
  eventsToAssistantMessage,
  textMessage,
} from './model';
