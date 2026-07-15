// Registration wrapper carrying `contextRedactKeys` (#268 PR-3) — declares
// which top-level `instantiate` context keys should render as "[redacted]"
// downstream (the playground threads this into the server's
// AgentRegistration; `ap run` applies it directly to its own scope banner).
const mk = () => ({ role: {}, mission: {}, awareness: {}, background: {} });
export default {
  id: "scoped",
  name: "Scoped Agent",
  agent: mk(),
  instantiate: async () => mk(),
  instantiateDefaults: { tenant: "acme" },
  contextRedactKeys: ["userId", "secret"],
};
