// Registration wrapper carrying a `memory` declaration (#444) — a
// hand-rolled duck-typed fake mimicking `MemoryStore`'s method surface. No
// `@pattern-stack/agentic-runtime` import: fixtures prove the STRUCTURAL check
// discovery performs (isMemoryDeclShape), not real store behavior.
const mk = () => ({ role: {}, mission: {}, awareness: {}, background: {} });
export const fakeStore = {
  write: async () => [],
  search: async () => [],
  get: async () => null,
  invalidate: async () => {},
  delete: async () => {},
  capabilities: () => ({ search: "keyword" }),
};
export default {
  id: "memory-decl",
  name: "Memory Declaring Agent",
  agent: mk(),
  memory: {
    store: fakeStore,
    scope: (ctx) => ({ user: String(ctx?.user ?? "local"), agent: "memory-decl" }),
    budgetChars: 2000,
  },
};
