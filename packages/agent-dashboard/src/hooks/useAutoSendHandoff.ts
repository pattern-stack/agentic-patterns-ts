/**
 * useAutoSendHandoff — the `/actions` Run → chat hand-off, consumed exactly
 * once.
 *
 * A quick action spends real tokens, so the prompt travels in router
 * navigation STATE rather than the URL, and this hook BURNS it on arrival:
 * the value is copied into component state and the history entry is rewritten
 * without it (`replace`, `state: null`). Two failure modes that a query param
 * (or an un-burned state) would have:
 *
 *   - refresh — the browser restores `history.state` for the current entry, so
 *     an un-burned prompt would re-run the agent on every reload;
 *   - Back — returning to this entry would hand the same prompt over again.
 *
 * After the burn both find nothing left to send. The returned value stays put
 * for the life of the mount so the consumer can guard its own once-per-prompt
 * fire (see `ChatPage`'s `autoSentRef`).
 */
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** The shape `/actions` navigates with: `navigate(path, { state: { autoSend } })`. */
export interface AutoSendState {
  autoSend?: string;
}

export function useAutoSendHandoff(): string | null {
  const location = useLocation();
  const navigate = useNavigate();
  const incoming = (location.state as AutoSendState | null)?.autoSend ?? null;
  const [prompt, setPrompt] = useState<string | null>(incoming);

  useEffect(() => {
    if (!incoming) return;
    setPrompt(incoming);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [incoming, location.pathname, location.search, navigate]);

  return prompt;
}
