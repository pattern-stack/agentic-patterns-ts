/**
 * Dual-copy hazard: a playground routinely loads TWO copies of this package in
 * one process (the CLI's install + the consumer's node_modules). A pad minted
 * by one copy fails the other copy's `instanceof ObservedScratchpad` check and
 * misses its module-scoped WeakMap brands — which historically stripped
 * backpack observability SILENTLY (drops landed in the shared pack, but no
 * `agent.backpack.*` event ever emitted).
 *
 * A Proxy whose getPrototypeOf trap hides the class simulates the foreign
 * copy's identity loss: `instanceof` fails exactly as it does cross-copy,
 * while the object-attached `Symbol.for` brand still resolves.
 */

import type { ToolExecutionContext } from "@pattern-stack/agentic-core";
import { describe, expect, it } from "vitest";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { BaseEvent } from "../../events/types.js";
import type { BackpackSpec } from "../backpack.js";
import { openBackpack, readBackpack } from "../observed-backpack.js";
import { ObservedScratchpad } from "../observed-scratchpad.js";
import { createScratchpad } from "../slot.js";
import { createStateEmitter } from "../state-events.js";

interface Row {
  readonly id: string;
  readonly label: string;
}

const spec: BackpackSpec<Row, Row, readonly Row[], string> = {
  key: "cross-copy",
  expand: (raw) => raw,
  identify: (row) => row.id,
  finalize: (entries) => entries,
};

function harness() {
  const bus = new AgentEventBus();
  const drops: BaseEvent[] = [];
  bus.subscribe("agent.backpack.drop", (e) => {
    drops.push(e);
  });
  const pad = new ObservedScratchpad(
    createStateEmitter(bus, { traceId: "trace-cc", runId: "run-cc" }),
  );
  // The foreign-copy stand-in: same object, class identity hidden.
  const foreignPad = new Proxy(pad, { getPrototypeOf: () => Object.prototype });
  return { drops, pad, foreignPad };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("observed backpack — cross-copy pad detection (object brand, not instanceof)", () => {
  it("sanity: the proxy defeats instanceof the way a foreign copy's class does", () => {
    const { pad, foreignPad } = harness();
    expect(pad instanceof ObservedScratchpad).toBe(true);
    expect(foreignPad instanceof ObservedScratchpad).toBe(false);
  });

  it("tool-side: openBackpack on a foreign-copy pad still emits agent.backpack.drop", async () => {
    const { drops, foreignPad } = harness();
    const ctx = { host: { scratchpad: foreignPad } } as ToolExecutionContext;

    const pack = openBackpack(ctx, spec);
    expect(pack).toBeDefined();
    pack?.drop({ id: "t1", label: "one" }, "tool");
    await tick();

    expect(drops).toHaveLength(1);
    expect((drops[0] as BaseEvent & { accepted?: number }).accepted).toBe(1);
  });

  it("pad-side: readBackpack on a foreign-copy pad still emits agent.backpack.drop", async () => {
    const { drops, foreignPad } = harness();

    readBackpack(foreignPad, spec, "cross-copy-test").drop({ id: "t2", label: "two" }, "seed");
    await tick();

    expect(drops).toHaveLength(1);
  });

  it("a plain unobserved pad stays emission-free (no false brand)", async () => {
    const { drops } = harness();
    const plain = createScratchpad();

    readBackpack(plain, spec, "plain-pad").drop({ id: "t3", label: "three" });
    await tick();

    expect(drops).toHaveLength(0);
  });
});
