/**
 * Test fixture — agent file with a malformed runner (neither RunnerLike nor RunnerFactory).
 * Consumed by playground-runner-override.test.ts.
 */

export default {
  id: "bad",
  name: "Bad",
  agent: {
    role: { name: "x" },
    getModel: () => "sonnet",
    getTools: () => [],
    getSystemPrompt: () => "sys",
    renderInitialPrompt: () => "go",
  },
  runner: { notRunOrFactory: true },
};
