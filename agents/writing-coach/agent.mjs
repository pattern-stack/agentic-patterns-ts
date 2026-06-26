// Convention discovery: export a bare Agent (any name — `rootAgent` is the
// ADK spelling) and the CLI infers id `writing-coach` + name "Writing Coach"
// from the folder. No registration wrapper needed.
import { buildWritingCoachAgent } from "../../packages/agent-runtime/dist/index.js";

export const rootAgent = buildWritingCoachAgent();
