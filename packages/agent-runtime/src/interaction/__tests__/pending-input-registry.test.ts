import { describe, expect, it, vi } from "vitest";
import { PendingInputRegistry } from "../pending-input-registry.js";

describe("PendingInputRegistry", () => {
  it("resolves a pending request with the human's answer", async () => {
    const registry = new PendingInputRegistry();
    const answer = registry.create("call-1");
    expect(registry.has("call-1")).toBe(true);
    expect(registry.size).toBe(1);

    const ok = registry.resolve("call-1", { decision: "approve" });
    expect(ok).toBe(true);
    await expect(answer).resolves.toEqual({ decision: "approve" });
    expect(registry.has("call-1")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("carries a select/text value through", async () => {
    const registry = new PendingInputRegistry();
    const answer = registry.create("pick-1", { kind: "select" });
    registry.resolve("pick-1", { decision: "approve", value: "option-b" });
    await expect(answer).resolves.toEqual({ decision: "approve", value: "option-b" });
  });

  it("returns false when resolving an unknown / already-settled id", () => {
    const registry = new PendingInputRegistry();
    expect(registry.resolve("nope", { decision: "deny" })).toBe(false);
    registry.create("call-1");
    registry.resolve("call-1", { decision: "approve" });
    // second resolve finds nothing pending
    expect(registry.resolve("call-1", { decision: "approve" })).toBe(false);
  });

  it("auto-denies (fail closed) on timeout", async () => {
    vi.useFakeTimers();
    try {
      const registry = new PendingInputRegistry();
      const answer = registry.create("slow-1", { timeoutMs: 1000 });
      vi.advanceTimersByTime(1000);
      await expect(answer).resolves.toEqual({ decision: "deny", timedOut: true });
      expect(registry.has("slow-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout when answered before it fires", async () => {
    vi.useFakeTimers();
    try {
      const registry = new PendingInputRegistry();
      const answer = registry.create("race-1", { timeoutMs: 1000 });
      registry.resolve("race-1", { decision: "approve" });
      vi.advanceTimersByTime(5000);
      await expect(answer).resolves.toEqual({ decision: "approve" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("denyAll settles every pending request (fail closed on teardown)", async () => {
    const registry = new PendingInputRegistry();
    const a = registry.create("a");
    const b = registry.create("b");
    const n = registry.denyAll();
    expect(n).toBe(2);
    await expect(a).resolves.toEqual({ decision: "deny" });
    await expect(b).resolves.toEqual({ decision: "deny" });
    expect(registry.size).toBe(0);
  });

  it("a duplicate correlationId settles both awaiters on one resolve", async () => {
    const registry = new PendingInputRegistry();
    const first = registry.create("dup");
    const second = registry.create("dup");
    registry.resolve("dup", { decision: "approve" });
    await expect(first).resolves.toEqual({ decision: "approve" });
    await expect(second).resolves.toEqual({ decision: "approve" });
  });
});
