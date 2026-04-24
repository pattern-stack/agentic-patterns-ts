/**
 * Test fixture — agent file exporting a RunnerFactory.
 * Consumed by playground-runner-override.test.ts.
 */

export default () => ({
  id: "factory",
  name: "Factory",
  agent: {
    role: { name: "x" },
    getModel: () => "sonnet",
    getTools: () => [],
    getSystemPrompt: () => "sys",
    renderInitialPrompt: () => "go",
  },
  runner: {
    forConversation(_id) {
      return {
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
      };
    },
  },
});
