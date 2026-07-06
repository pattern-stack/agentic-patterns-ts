// Registration wrapper carrying an `evals` declaration — one valid ref, one
// richer valid ref, and two malformed entries (no setId / not an object) that
// normalization must drop without failing discovery.
const mk = () => ({ role: {}, mission: {}, awareness: {}, background: {} });
export default {
  id: "graded",
  name: "Graded Agent",
  description: "carries a declared eval mapping",
  agent: mk(),
  evals: [
    { setId: "xd-interpret", grades: "scope shape", step: "interpret", scorer: "none" },
    { setId: "e2e-answer" },
    { grades: "orphan — no setId" },
    "not-an-object",
  ],
};
