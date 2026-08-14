// Registration wrapper carrying a session `scope` (#308) — a hand-rolled
// duck-typed fake mimicking `SessionScope`'s public surface (`.schema`,
// `.redactKeys`, `.parse`, `.toJsonSchema`). No `@pattern-stack/agentic-core`
// import: fixtures prove the STRUCTURAL check discovery performs, not a
// real Zod round-trip (that belongs to core/server tests).
const mk = () => ({ role: {}, mission: {}, awareness: {}, background: {} });
const fakeScope = {
  schema: { type: "object" },
  redactKeys: ["secret"],
  defaults: { tenant: "acme" },
  parse: (value) => ({ tenant: "acme", ...value }),
  toJsonSchema: () => ({ type: "object", properties: { tenant: { type: "string" } } }),
};
export default {
  id: "session-scoped",
  name: "Session Scoped Agent",
  agent: mk(),
  scope: fakeScope,
};
