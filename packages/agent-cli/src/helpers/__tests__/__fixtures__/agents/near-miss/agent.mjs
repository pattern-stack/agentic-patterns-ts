// `nearMiss` satisfies neither isAgentShape (no mission/awareness/background)
// nor isAgentLikeShape (no getModel/getSystemPrompt/renderInitialPrompt) — must
// be skipped. `real` is a valid Agent-shaped export alongside it, so discovery
// still succeeds for the file overall (one skipped, one found).
export const nearMiss = { role: { name: "just-a-name" } };
const mk = () => ({ role: {}, mission: {}, awareness: {}, background: {} });
export const real = mk();
