/**
 * Test fixture — agent file with no runner export.
 * Consumed by playground-runner-override.test.ts.
 */

export default {
  id: "no-runner",
  name: "No Runner",
  agent: {
    role: { name: "x" },
    getModel: () => "sonnet",
    getTools: () => [],
    getSystemPrompt: () => "sys",
    renderInitialPrompt: () => "go",
  },
};
