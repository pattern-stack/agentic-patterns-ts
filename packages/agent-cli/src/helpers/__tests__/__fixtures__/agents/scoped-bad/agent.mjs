// `contextRedactKeys` with a non-string entry — the whole declaration must be
// DROPPED (same defensive style as `instantiateDefaults`), never partially
// salvaged, so a malformed declaration degrades to "no redaction" rather than
// redacting an arbitrary subset silently.
const mk = () => ({ role: {}, mission: {}, awareness: {}, background: {} });
export default {
  id: "scoped-bad",
  name: "Scoped Bad",
  agent: mk(),
  contextRedactKeys: ["ok", 42, "also-ok"],
};
