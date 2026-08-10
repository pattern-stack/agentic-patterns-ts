import { describe, expect, it } from "vitest";

import { TRIGGER_KINDS, TriggerSource, TriggerSourceSchema } from "../trigger-source.js";

const FIRED_AT = "2026-08-08T09:00:00.000Z";

describe("TriggerSource", () => {
  it("constructs with the minimal shape (kind + firedAt) and freezes", () => {
    const t = new TriggerSource({ kind: "manual", firedAt: FIRED_AT });
    expect(t.data.kind).toBe("manual");
    expect(t.data.firedAt).toBe(FIRED_AT);
    expect(Object.isFrozen(t.data)).toBe(true);
  });

  it("rejects an unknown kind and a non-ISO firedAt", () => {
    expect(() => new TriggerSource({ kind: "cron" as never, firedAt: FIRED_AT })).toThrow();
    expect(() => new TriggerSource({ kind: "schedule", firedAt: "yesterday" })).toThrow();
  });

  it("accepts an offset ISO timestamp (hosts in non-UTC zones)", () => {
    const t = new TriggerSource({ kind: "schedule", firedAt: "2026-08-08T09:00:00-04:00" });
    expect(t.data.firedAt).toBe("2026-08-08T09:00:00-04:00");
  });

  it("carries the optional host fields verbatim", () => {
    const t = new TriggerSource({
      kind: "schedule",
      sourceId: "sched-row-1",
      label: "morning-brief",
      firedAt: FIRED_AT,
      correlationId: "job-run-42",
      summary: "Daily 09:00 workspace brief.",
    });
    expect(t.data.sourceId).toBe("sched-row-1");
    expect(t.data.correlationId).toBe("job-run-42");
  });

  it("toPrompt() names the kind, label, and time — and appends the summary", () => {
    const t = new TriggerSource({
      kind: "schedule",
      label: "morning-brief",
      firedAt: FIRED_AT,
      summary: "Daily 09:00 workspace brief.",
    });
    expect(t.toPrompt()).toMatchInlineSnapshot(`
      "This run was started by a schedule ('morning-brief') at 2026-08-08T09:00:00.000Z.
      Daily 09:00 workspace brief."
    `);
  });

  it("toPrompt() stays compact without optionals, for every kind", () => {
    for (const kind of TRIGGER_KINDS) {
      const line = new TriggerSource({ kind, firedAt: FIRED_AT }).toPrompt();
      expect(line).toContain("This run was started by ");
      expect(line).toContain(FIRED_AT);
      expect(line.split("\n")).toHaveLength(1);
    }
  });

  it("schema round-trips through plain JSON (host boundary)", () => {
    const wire = JSON.parse(
      JSON.stringify({ kind: "webhook", sourceId: "dlv-9", firedAt: FIRED_AT }),
    );
    const parsed = TriggerSourceSchema.parse(wire);
    expect(parsed.kind).toBe("webhook");
  });
});
