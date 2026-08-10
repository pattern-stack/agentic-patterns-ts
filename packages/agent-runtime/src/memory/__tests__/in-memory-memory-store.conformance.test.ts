import { runMemoryStoreConformance } from "../conformance.js";
import { InMemoryMemoryStore } from "../store.js";

// Top-level await — vitest ESM test files support it; the suite registers
// during collection.
await runMemoryStoreConformance(() => new InMemoryMemoryStore(), {
  label: "InMemoryMemoryStore",
});
