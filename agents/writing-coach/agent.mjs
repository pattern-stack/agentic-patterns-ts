import { buildWritingCoachAgent } from "../../packages/agent-runtime/dist/index.js";

export default () => ({
  id: "writing-coach",
  name: "Writing Coach",
  description: "Actionable feedback on clarity, structure, and style — no tools, pure reasoning",
  agent: buildWritingCoachAgent(),
});
