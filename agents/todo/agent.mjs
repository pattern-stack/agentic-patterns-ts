import { buildTodoAgent } from "../../packages/agent-runtime/dist/index.js";

export default () => ({
  id: "todo",
  name: "Todo Manager",
  description: "Create, list, complete, update, and delete tasks (in-memory)",
  agent: buildTodoAgent(),
});
