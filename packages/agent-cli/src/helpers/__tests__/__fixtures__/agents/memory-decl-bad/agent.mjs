// Registration wrapper with a MALFORMED `memory` declaration (#444): the
// store is missing `search`/`invalidate` — the all-or-nothing structural
// check must drop the whole declaration, never partially salvage it.
const mk = () => ({ role: {}, mission: {}, awareness: {}, background: {} });
export default {
  id: "memory-decl-bad",
  name: "Memory Declaring Agent (bad)",
  agent: mk(),
  memory: {
    store: { write: async () => [] },
    scope: { user: "dug" },
  },
};
