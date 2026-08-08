// Companion — the playground's generalist assistant with cross-session
// memory (#445). Pairs `buildCompanionAgent` (scope-bound MemoryToolbox +
// recall awareness) with the #444 server wiring (`memory: { store, scope }`
// → turn-1 recall) over the SAME store instance, so toolbox writes and
// recall never diverge.
//
// Store: `loadMemoryStore()` — persistent SQLite at
// `$AP_MEMORY_DB_PATH` | `~/.local/state/ap/memory.db` (soft-degrades to
// in-memory with a reason when no sqlite driver resolves).
//
// Identity: `AP_USER` (default "local") names the memory partition's user
// key. Per-conversation override: `POST /conversations` with
// `context: { user: "guest" }` — the instantiate hook rebinds the toolbox
// and the #444 wiring re-derives the recall partition from the same context.
//
// Runner reality (Gate 2.5 B1/B3): the playground resolves the runner from
// env. With a provider key (e.g. ANTHROPIC_API_KEY) you get AgentRunner —
// full event vocabulary, memory_save emits agent.memory.write. The bare
// claude-CLI fallback (no keys) runs with NATIVE CC TOOLS DISABLED and
// executes tools without a ToolExecutionContext, so memory WRITES still
// land but their events don't emit. A capable "CC daily driver" profile
// (web/files/shell + memory) needs a runner-selection seam the CLI doesn't
// expose yet — tracked as follow-up work, not claimed here.
import { buildCompanionAgent, loadMemoryStore } from "../../packages/agent-runtime/dist/index.js";

const memory = await loadMemoryStore();
process.stderr.write(
  memory.unavailable
    ? `[companion] memory DEGRADED to in-memory (nothing persists): ${memory.reason}\n`
    : `[companion] memory: ${memory.reason}\n`,
);

// `||` not `??` (Gate 2.5 N2, the sqlite-store.ts precedent): an empty
// AP_USER= line in .env means UNSET, never a silent "" partition.
const defaultUser = process.env.AP_USER || "local";

/** Memory partition for a conversation context (reserved agent key, ADR-0008 D8). */
const memoryScopeOf = (ctx) => ({
  user: typeof ctx?.user === "string" && ctx.user.length > 0 ? ctx.user : defaultUser,
  agent: "companion",
});

export default () => ({
  id: "companion",
  name: "Companion",
  description:
    "Generalist personal assistant with cross-session memory — the memory-layer dogfood instrument",
  agent: buildCompanionAgent({ store: memory.store, scope: memoryScopeOf() }),
  // Per-conversation delivery (ADR-0004): rebind the memory partition to the
  // conversation's context, so `context: { user: "guest" }` reads/writes
  // guest's partition — never the default user's.
  instantiate: async (ctx) =>
    buildCompanionAgent({ store: memory.store, scope: memoryScopeOf(ctx) }),
  instantiateDefaults: { user: defaultUser },
  // #444 server wiring: turn-1 recall over the same store + partition.
  memory: { store: memory.store, scope: memoryScopeOf },
});
