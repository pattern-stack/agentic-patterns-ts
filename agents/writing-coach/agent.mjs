// Convention discovery: export a bare Agent under any name (`rootAgent` is the
// conventional one) and the CLI infers id `writing-coach` + name "Writing Coach"
// from the folder. No registration wrapper needed.
import { buildWritingCoachAgent } from "../../packages/agent-runtime/dist/index.js";

export const rootAgent = buildWritingCoachAgent();
