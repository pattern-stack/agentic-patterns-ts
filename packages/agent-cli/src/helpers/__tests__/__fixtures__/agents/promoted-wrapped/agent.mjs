// AgentLike-shaped agent inside a legacy registration wrapper.
const mk = () => ({
  role: { name: "Promoted Pipe" },
  getModel: () => "sonnet",
  getTools: () => [],
  getSystemPrompt: () => "Promoted pipeline: pipe",
  renderInitialPrompt: () => "Promoted pipeline: pipe",
  __promotedNode: {},
});
export default () => ({ id: "wrapped-promoted", name: "Wrapped Promoted", agent: mk() });
