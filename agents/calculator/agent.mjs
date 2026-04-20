import { buildCalculatorAgent } from "../../packages/agent-runtime/dist/index.js";

export default () => ({
  id: "calculator",
  name: "Calculator",
  description:
    "8 math operations — add, subtract, multiply, divide, power, sqrt, percentage, modulo",
  agent: buildCalculatorAgent(),
});
