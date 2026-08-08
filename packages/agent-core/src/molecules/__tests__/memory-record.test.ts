import { describe, expect, it } from "vitest";
import {
  AwarenessTargetPayloadSchema,
  ExampleTargetPayloadSchema,
  MemoryHitSchema,
  type MemoryRecordInput,
  MemoryRecordSchema,
  MemoryScopeSchema,
  MemorySearchQuerySchema,
  MemoryStoreCapabilitiesSchema,
  MemoryTargetSchema,
  ProvenanceSchema,
  StoredMemoryTargetSchema,
  UnknownMemoryTargetSchema,
  canonicalMemoryScope,
  isKnownTarget,
  memoryRecord,
  readStoredMemoryRecord,
  targetPayloadSchema,
} from "../memory-record.js";

const minimalRecord: MemoryRecordInput = {
  id: "mem_1",
  scope: { tenant: "acme" },
  kind: "fact",
  content: "The user prefers dark mode.",
  createdAt: "2026-08-07T00:00:00Z",
  updatedAt: "2026-08-07T00:00:00Z",
};

describe("MemoryScopeSchema", () => {
  it("accepts an empty scope", () => {
    expect(MemoryScopeSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a flat string map", () => {
    expect(MemoryScopeSchema.safeParse({ tenant: "acme", user: "u_42" }).success).toBe(true);
  });

  it("rejects non-string values", () => {
    expect(MemoryScopeSchema.safeParse({ n: 1 }).success).toBe(false);
  });
});

describe("canonicalMemoryScope", () => {
  it("sorts keys lexicographically", () => {
    const canonical = canonicalMemoryScope({ user: "u", tenant: "t" });
    expect(Object.keys(canonical)).toEqual(["tenant", "user"]);
  });

  it("returns a frozen copy without mutating the input", () => {
    const input = { user: "u", tenant: "t" };
    const canonical = canonicalMemoryScope(input);
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.keys(input)).toEqual(["user", "tenant"]);
  });
});

describe("ProvenanceSchema", () => {
  it("accepts an empty provenance", () => {
    expect(ProvenanceSchema.safeParse({}).success).toBe(true);
  });

  it("accepts full provenance", () => {
    const parsed = ProvenanceSchema.safeParse({
      conversationId: "conv_1",
      runId: "run_1",
      author: "agent",
      at: "2026-08-07T00:00:00Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-string at", () => {
    expect(ProvenanceSchema.safeParse({ at: 1723 }).success).toBe(false);
  });
});

describe("MemoryTargetSchema", () => {
  it("accepts a background target", () => {
    const parsed = MemoryTargetSchema.safeParse({
      primitive: "background",
      section: "conventions",
      key: "commit-style",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a background target with an unknown section", () => {
    const parsed = MemoryTargetSchema.safeParse({
      primitive: "background",
      section: "trivia",
      key: "k",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a background target with an empty key", () => {
    const parsed = MemoryTargetSchema.safeParse({
      primitive: "background",
      section: "conventions",
      key: "",
    });
    expect(parsed.success).toBe(false);
  });

  it.each(["heuristics", "constraints", "escalationTriggers"] as const)(
    "accepts a judgment target with slot %s",
    (slot) => {
      const parsed = MemoryTargetSchema.safeParse({
        primitive: "judgment",
        domain: "code-review",
        slot,
      });
      expect(parsed.success).toBe(true);
    },
  );

  it("rejects a judgment target with an unknown slot", () => {
    const parsed = MemoryTargetSchema.safeParse({
      primitive: "judgment",
      domain: "code-review",
      slot: "vibes",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts an example target", () => {
    const parsed = MemoryTargetSchema.safeParse({
      primitive: "example",
      judgmentDomain: "code-review",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an example target missing judgmentDomain", () => {
    expect(MemoryTargetSchema.safeParse({ primitive: "example" }).success).toBe(false);
  });

  it("accepts bare awareness and recovery targets, stripping extra keys", () => {
    expect(MemoryTargetSchema.safeParse({ primitive: "awareness" }).success).toBe(true);
    expect(MemoryTargetSchema.safeParse({ primitive: "recovery" }).success).toBe(true);
    const awareness = MemoryTargetSchema.safeParse({ primitive: "awareness", extra: 1 });
    expect(awareness.success).toBe(true);
    if (awareness.success) expect(awareness.data).toEqual({ primitive: "awareness" });
    const recovery = MemoryTargetSchema.safeParse({ primitive: "recovery", extra: 1 });
    expect(recovery.success).toBe(true);
    if (recovery.success) expect(recovery.data).toEqual({ primitive: "recovery" });
  });

  it("accepts a manual target", () => {
    const parsed = MemoryTargetSchema.safeParse({
      primitive: "manual",
      capability: "crm",
      section: "workflows",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a manual target with a non-workflows section", () => {
    const parsed = MemoryTargetSchema.safeParse({
      primitive: "manual",
      capability: "crm",
      section: "other",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a locked-tier primitive", () => {
    expect(MemoryTargetSchema.safeParse({ primitive: "persona" }).success).toBe(false);
  });
});

describe("payload validation per target arm", () => {
  it("parses an example target with a valid payload", () => {
    const parsed = MemoryRecordSchema.safeParse({
      ...minimalRecord,
      target: { primitive: "example", judgmentDomain: "code-review" },
      payload: { scenario: "PR touches auth", good: "Flag for security review" },
    });
    expect(parsed.success).toBe(true);
  });

  it("fails an example target whose payload is missing good, at path payload", () => {
    const parsed = MemoryRecordSchema.safeParse({
      ...minimalRecord,
      target: { primitive: "example", judgmentDomain: "code-review" },
      payload: { scenario: "x" },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["payload"]);
      expect(parsed.error.issues[0]?.message).toContain('"example"');
    }
  });

  it("parses an awareness target with a valid payload", () => {
    const parsed = MemoryRecordSchema.safeParse({
      ...minimalRecord,
      target: { primitive: "awareness" },
      payload: { name: "billing", description: "Billing state", accessMethod: "crm_lookup" },
    });
    expect(parsed.success).toBe(true);
  });

  it("fails an awareness target with an incomplete payload", () => {
    const parsed = MemoryRecordSchema.safeParse({
      ...minimalRecord,
      target: { primitive: "awareness" },
      payload: { name: "x" },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["payload"]);
    }
  });

  it("parses an example target without a payload — candidate cannot promote but is storable", () => {
    const parsed = MemoryRecordSchema.safeParse({
      ...minimalRecord,
      target: { primitive: "example", judgmentDomain: "code-review" },
    });
    expect(parsed.success).toBe(true);
  });

  it("parses a background target with an arbitrary payload — prose arm, payload opaque", () => {
    const parsed = MemoryRecordSchema.safeParse({
      ...minimalRecord,
      target: { primitive: "background", section: "conventions", key: "k" },
      payload: { anything: true },
    });
    expect(parsed.success).toBe(true);
  });

  it("parses an untargeted record with an arbitrary payload", () => {
    const parsed = MemoryRecordSchema.safeParse({
      ...minimalRecord,
      payload: { anything: true },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("MemoryRecordSchema", () => {
  it("parses a minimal record", () => {
    expect(MemoryRecordSchema.safeParse(minimalRecord).success).toBe(true);
  });

  it("rejects an empty id", () => {
    expect(MemoryRecordSchema.safeParse({ ...minimalRecord, id: "" }).success).toBe(false);
  });

  it("rejects empty content", () => {
    expect(MemoryRecordSchema.safeParse({ ...minimalRecord, content: "" }).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(MemoryRecordSchema.safeParse({ ...minimalRecord, kind: "opinion" }).success).toBe(false);
  });

  it("accepts a full record", () => {
    const parsed = MemoryRecordSchema.safeParse({
      ...minimalRecord,
      tags: ["ui", "preference"],
      provenance: { conversationId: "conv_1", runId: "run_1", author: "agent" },
      invalidAt: "2026-08-08T00:00:00Z",
      supersededBy: "mem_2",
      expiresAt: "2027-01-01T00:00:00Z",
      supports: [{ conversationId: "conv_2", runId: "run_2", at: "2026-08-07T12:00:00Z" }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("memoryRecord factory", () => {
  it("returns a value satisfying MemoryRecordSchema", () => {
    const record = memoryRecord(minimalRecord);
    expect(MemoryRecordSchema.safeParse(record).success).toBe(true);
  });

  it("throws on invalid input", () => {
    expect(() => memoryRecord({ ...minimalRecord, content: "" })).toThrow();
  });

  it("deep-freezes the record and every nested container", () => {
    const record = memoryRecord({
      ...minimalRecord,
      scope: { user: "u", tenant: "t" },
      tags: ["ui"],
      target: { primitive: "example", judgmentDomain: "code-review" },
      payload: { scenario: "s", good: "g" },
      supports: [{ conversationId: "conv_1", at: "2026-08-07T00:00:00Z" }],
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.scope)).toBe(true);
    expect(Object.isFrozen(record.tags)).toBe(true);
    expect(Object.isFrozen(record.target)).toBe(true);
    expect(Object.isFrozen(record.supports)).toBe(true);
    expect(Object.isFrozen(record.supports?.[0])).toBe(true);
    expect(Object.isFrozen(record.payload)).toBe(true);
  });

  it("freezes descendants of an already-frozen payload container", () => {
    const payload = Object.freeze({ scenario: "s", good: "g", nested: { tags: ["a"] } });
    const record = memoryRecord({
      ...minimalRecord,
      target: { primitive: "example", judgmentDomain: "code-review" },
      payload,
    });
    const inner = (record.payload as { nested: { tags: string[] } }).nested;
    expect(Object.isFrozen(inner)).toBe(true);
    expect(Object.isFrozen(inner.tags)).toBe(true);
  });

  it("stores scope with sorted keys regardless of input order", () => {
    const record = memoryRecord({ ...minimalRecord, scope: { user: "u", tenant: "t" } });
    expect(Object.keys(record.scope)).toEqual(["tenant", "user"]);
  });

  it("omits absent optionals", () => {
    const record = memoryRecord(minimalRecord);
    expect("tags" in record).toBe(false);
  });
});

describe("MemorySearchQuerySchema", () => {
  it("applies defaults for limit and includeInvalidated", () => {
    const parsed = MemorySearchQuerySchema.parse({ scope: {} });
    expect(parsed.limit).toBe(10);
    expect(parsed.includeInvalidated).toBe(false);
  });

  it("rejects a missing scope", () => {
    expect(MemorySearchQuerySchema.safeParse({}).success).toBe(false);
  });

  it("rejects a negative limit", () => {
    expect(MemorySearchQuerySchema.safeParse({ scope: {}, limit: -1 }).success).toBe(false);
  });

  it("rejects a fractional limit", () => {
    expect(MemorySearchQuerySchema.safeParse({ scope: {}, limit: 2.5 }).success).toBe(false);
  });

  it("accepts limit 0 — store behavior is pinned by the conformance kit later", () => {
    expect(MemorySearchQuerySchema.safeParse({ scope: {}, limit: 0 }).success).toBe(true);
  });

  it("accepts known kinds and rejects unknown ones", () => {
    expect(MemorySearchQuerySchema.safeParse({ scope: {}, kinds: ["profile"] }).success).toBe(true);
    expect(MemorySearchQuerySchema.safeParse({ scope: {}, kinds: ["nope"] }).success).toBe(false);
  });
});

describe("MemoryHitSchema", () => {
  it("accepts a hit with and without a score", () => {
    expect(MemoryHitSchema.safeParse({ record: minimalRecord }).success).toBe(true);
    expect(MemoryHitSchema.safeParse({ record: minimalRecord, score: 0.87 }).success).toBe(true);
  });
});

describe("MemoryStoreCapabilitiesSchema", () => {
  it.each(["keyword", "semantic", "hybrid"] as const)("accepts search mode %s", (search) => {
    expect(MemoryStoreCapabilitiesSchema.safeParse({ search }).success).toBe(true);
  });

  it("rejects an unknown search mode", () => {
    expect(MemoryStoreCapabilitiesSchema.safeParse({ search: "vector" }).success).toBe(false);
  });
});

describe("targetPayloadSchema", () => {
  it("returns the example payload schema for example targets", () => {
    expect(targetPayloadSchema({ primitive: "example", judgmentDomain: "d" })).toBe(
      ExampleTargetPayloadSchema,
    );
  });

  it("returns the awareness payload schema for awareness targets", () => {
    expect(targetPayloadSchema({ primitive: "awareness" })).toBe(AwarenessTargetPayloadSchema);
  });

  it("returns undefined for prose arms", () => {
    expect(
      targetPayloadSchema({ primitive: "background", section: "conventions", key: "k" }),
    ).toBeUndefined();
    expect(
      targetPayloadSchema({ primitive: "judgment", domain: "d", slot: "heuristics" }),
    ).toBeUndefined();
    expect(targetPayloadSchema({ primitive: "recovery" })).toBeUndefined();
    expect(
      targetPayloadSchema({ primitive: "manual", capability: "crm", section: "workflows" }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tolerant stored-`target` read — ADR-0009 Decision 14
// ---------------------------------------------------------------------------
// The defect: `target` is persisted and every read path reconstructs through
// `MemoryRecordSchema.parse`, so ONE row whose target no longer parses made the
// whole partition's search throw. These pin the two halves of the fix — the
// tolerant arm (data preserved) and the degrade-not-detonate reader (data
// dropped, loudly) — and, just as importantly, pin that the WRITE side did not
// move.

describe("UnknownMemoryTargetSchema", () => {
  it("accepts any object with a non-empty string primitive, preserving extra keys", () => {
    const parsed = UnknownMemoryTargetSchema.safeParse({
      primitive: "background",
      section: "userProfile",
      key: "name",
      nested: { a: [1, 2] },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      primitive: "background",
      section: "userProfile",
      key: "name",
      nested: { a: [1, 2] },
    });
  });

  it.each([[42], ["background"], [null], [[]], [{}], [{ primitive: 7 }], [{ primitive: "" }]])(
    "rejects %j — not an object with a string primitive",
    (value) => {
      expect(UnknownMemoryTargetSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("StoredMemoryTargetSchema", () => {
  it("parses a known arm through MemoryTargetSchema first (exact shape, no extra keys invented)", () => {
    const known = { primitive: "judgment", domain: "code-review", slot: "heuristics" };
    const parsed = StoredMemoryTargetSchema.safeParse(known);
    expect(parsed.success && parsed.data).toEqual(known);
  });

  it("falls through to the tolerant arm for an unrecognised SECTION on a known primitive", () => {
    const future = { primitive: "background", section: "userProfile", key: "name" };
    expect(MemoryTargetSchema.safeParse(future).success).toBe(false);
    expect(StoredMemoryTargetSchema.safeParse(future).success).toBe(true);
  });

  it("falls through to the tolerant arm for an unrecognised PRIMITIVE", () => {
    expect(StoredMemoryTargetSchema.safeParse({ primitive: "persona" }).success).toBe(true);
  });
});

describe("isKnownTarget", () => {
  it("is true for every known arm", () => {
    expect(isKnownTarget({ primitive: "background", section: "conventions", key: "k" })).toBe(true);
    expect(isKnownTarget({ primitive: "awareness" })).toBe(true);
  });

  it("is false for an unrecognised arm and for undefined", () => {
    expect(isKnownTarget({ primitive: "background", section: "userProfile", key: "k" })).toBe(
      false,
    );
    expect(isKnownTarget({ primitive: "persona" })).toBe(false);
    expect(isKnownTarget(undefined)).toBe(false);
  });
});

describe("MemoryRecordSchema — tolerant target (ADR-0009 D14)", () => {
  it("accepts a record whose stored target uses an unrecognised vocabulary", () => {
    const parsed = MemoryRecordSchema.safeParse({
      ...minimalRecord,
      target: { primitive: "background", section: "userProfile", key: "name" },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.target).toEqual({
      primitive: "background",
      section: "userProfile",
      key: "name",
    });
  });

  it("still REJECTS a target that is not a readable object — that is the reader's job, not the schema's", () => {
    expect(MemoryRecordSchema.safeParse({ ...minimalRecord, target: 42 }).success).toBe(false);
  });

  it("never validates payload against an unrecognised arm", () => {
    // `example` requires a payload shape; `exampleV2` is unknown, so nothing is
    // required — this reader cannot know what a vocabulary it has never seen wants.
    expect(
      MemoryRecordSchema.safeParse({
        ...minimalRecord,
        target: { primitive: "exampleV2", judgmentDomain: "d" },
        payload: { totally: "unrelated" },
      }).success,
    ).toBe(true);
    expect(
      MemoryRecordSchema.safeParse({
        ...minimalRecord,
        target: { primitive: "example", judgmentDomain: "d" },
        payload: { totally: "unrelated" },
      }).success,
    ).toBe(false);
  });
});

describe("targetPayloadSchema — unrecognised arms", () => {
  it("returns undefined rather than throwing on an unrecognised arm", () => {
    expect(targetPayloadSchema({ primitive: "somethingNew" })).toBeUndefined();
    expect(
      targetPayloadSchema({ primitive: "background", section: "userProfile", key: "k" }),
    ).toBeUndefined();
  });
});

describe("readStoredMemoryRecord", () => {
  it("returns a known-target record unchanged, with no degradation report", () => {
    const target = { primitive: "background", section: "conventions", key: "k" } as const;
    const read = readStoredMemoryRecord({ ...minimalRecord, target });
    expect(read.degraded).toBeUndefined();
    expect(read.record.target).toEqual(target);
    expect(Object.isFrozen(read.record)).toBe(true);
  });

  it("PRESERVES an unrecognised-but-readable target and reports nothing", () => {
    // A reader at version N-1 meeting a row written at version N is the
    // expected steady state, not an incident — warning on it would be noise.
    const future = { primitive: "background", section: "userProfile", key: "name" };
    const read = readStoredMemoryRecord({ ...minimalRecord, target: future });
    expect(read.degraded).toBeUndefined();
    expect(read.record.target).toEqual(future);
  });

  it.each([
    ["a number", 42],
    ["a bare string", "background"],
    ["null", null],
    ["an array", ["background"]],
    ["an object with no primitive", { section: "conventions" }],
    ["a non-string primitive", { primitive: 7 }],
    ["an empty-string primitive", { primitive: "" }],
  ])("degrades to target-less and REPORTS when the target is %s", (_name, target) => {
    // The strict factory is what a store used to call here.
    expect(() => memoryRecord({ ...minimalRecord, target } as MemoryRecordInput)).toThrow();

    const read = readStoredMemoryRecord({ ...minimalRecord, target });
    expect(read.record.target).toBeUndefined();
    expect(read.record.content).toBe(minimalRecord.content);
    expect(read.degraded).toEqual({
      id: "mem_1",
      field: "target",
      reason: expect.stringContaining("stored target is not readable"),
    });
  });

  it("carries the record id in the report, so a caller can act on the right row", () => {
    const read = readStoredMemoryRecord({ ...minimalRecord, id: "mem_bad", target: 42 });
    expect(read.degraded?.id).toBe("mem_bad");
  });

  it("THROWS on corruption in any other field — degradation is scoped to target, deliberately", () => {
    expect(() => readStoredMemoryRecord({ ...minimalRecord, content: "" })).toThrow();
    expect(() => readStoredMemoryRecord({ ...minimalRecord, kind: "vibes" as never })).toThrow();
  });

  it("THROWS when the target is readable but the PAYLOAD is invalid — the target is not at fault", () => {
    expect(() =>
      readStoredMemoryRecord({
        ...minimalRecord,
        target: { primitive: "example", judgmentDomain: "d" },
        payload: { scenario: "" },
      }),
    ).toThrow();
  });

  it("deep-freezes the tolerated target, exactly as the strict factory would", () => {
    const read = readStoredMemoryRecord({
      ...minimalRecord,
      target: { primitive: "persona", nested: { a: 1 } },
    });
    expect(Object.isFrozen(read.record.target)).toBe(true);
  });
});
