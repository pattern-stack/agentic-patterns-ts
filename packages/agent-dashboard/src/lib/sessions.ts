/**
 * SessionsMenu selection logic (port-map §4.2.1) — pulled out of `ChatPage`
 * as a pure, dependency-free helper so it's unit-testable without pulling in
 * the whole page's module graph (chat/useChat, ChatPanel, …). Mirrors
 * `lib/runPicker.ts`'s precedent for the analogous run picker.
 */
import type { ConversationSummary } from "../api/types";

/**
 * Sessions for the SessionsMenu: `GET /admin/conversations` filtered to the
 * currently selected agent, newest-first by `lastMessageAt` (falling back to
 * `startedAt` for a session with no messages yet).
 */
export function sessionsForAgent(
  conversations: ConversationSummary[],
  agentName: string | null | undefined,
): ConversationSummary[] {
  if (!agentName) return [];
  return conversations
    .filter((c) => c.agentName === agentName)
    .slice()
    .sort((a, b) => {
      const at = Date.parse(a.lastMessageAt ?? a.startedAt);
      const bt = Date.parse(b.lastMessageAt ?? b.startedAt);
      return bt - at;
    });
}
