// AgentLike-shaped only (no mission/awareness/background) — mirrors a real
// asAgent() PromotedAgent's structural surface without importing runtime.
const mk = () => ({
  role: { name: "Promoted Pipe" },
  getModel: () => "sonnet",
  getTools: () => [],
  getSystemPrompt: () => "Promoted pipeline: pipe",
  renderInitialPrompt: () => "Promoted pipeline: pipe",
  __promotedNode: {},
});
export default mk();
