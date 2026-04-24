/**
 * Test fixture — agent file exporting an explicit RunnerLike.
 * Consumed by playground-runner-override.test.ts.
 */

export default {
  id: "explicit",
  name: "Explicit",
  agent: {
    role: { name: "x" },
    getModel: () => "sonnet",
    getTools: () => [],
    getSystemPrompt: () => "sys",
    renderInitialPrompt: () => "go",
  },
  runner: {
    async run() {
      return {
        response: "",
        inputTokens: 0,
        outputTokens: 0,
        toolCallsCount: 0,
        iterations: 0,
        finishReason: "stop",
      };
    },
    async *stream() {},
  },
};
