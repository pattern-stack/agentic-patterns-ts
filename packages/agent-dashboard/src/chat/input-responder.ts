/**
 * InputResponder — the seam that lets an inline `input_request` card (rendered
 * deep in the parts tree) answer a blocked run WITHOUT prop-drilling through
 * `PartView`. `ChatPanel` provides the responder (bound to the live
 * conversation id); the card consumes it via `useInputResponder`.
 *
 * Null on read-only surfaces (session replay) — the card then renders inert.
 */
import { createContext, useContext } from "react";

/** The human's answer to an inline `input_request`. */
export interface InputAnswer {
  decision: "approve" | "deny";
  /** For select/text requests — the chosen option / typed value. */
  value?: string;
}

export type RespondInput = (correlationId: string, answer: InputAnswer) => void | Promise<void>;

export const InputResponderContext = createContext<RespondInput | null>(null);

/** The active responder, or null on a read-only thread. */
export function useInputResponder(): RespondInput | null {
  return useContext(InputResponderContext);
}
