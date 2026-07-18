// `scope` with `.parse` as a non-function — the WHOLE declaration must be
// DROPPED (same defensive style as `contextRedactKeys`/`instantiateDefaults`),
// never partially trusted, so a malformed scope degrades to "no scope"
// rather than threading a broken value into the server.
const mk = () => ({ role: {}, mission: {}, awareness: {}, background: {} });
export default {
  id: "session-scoped-bad",
  name: "Session Scoped Bad",
  agent: mk(),
  scope: {
    schema: { type: "object" },
    redactKeys: ["secret"],
    parse: "not-a-function",
    toJsonSchema: () => ({}),
  },
};
