declare function setTimeout(callback: () => void, ms: number): number;

import { beforeEach, describe, expect, it } from "vitest";
import { InProcessTransport, matchSubject } from "../in-process.js";
import type { TransportMessage } from "../types.js";

describe("matchSubject", () => {
  it("matches exact subjects", () => {
    expect(matchSubject("agency.crm", "agency.crm")).toBe(true);
    expect(matchSubject("agency.crm", "agency.sales")).toBe(false);
  });

  it("wildcard * matches single token", () => {
    expect(matchSubject("agency.*", "agency.crm")).toBe(true);
    expect(matchSubject("agency.*", "agency.crm.run")).toBe(false);
    expect(matchSubject("agency.*.run", "agency.crm.run")).toBe(true);
    expect(matchSubject("agency.*.run", "agency.crm.stop")).toBe(false);
  });

  it("wildcard > matches trailing tokens", () => {
    expect(matchSubject("agency.>", "agency.crm")).toBe(true);
    expect(matchSubject("agency.>", "agency.crm.run.123")).toBe(true);
    expect(matchSubject("agency.>", "other.crm")).toBe(false);
  });

  it("combined wildcards", () => {
    expect(matchSubject("agency.*.run.*.agent.bob", "agency.crm.run.123.agent.bob")).toBe(true);
    expect(matchSubject("agency.*.run.*.agent.bob", "agency.crm.run.123.agent.alice")).toBe(false);
  });
});

describe("InProcessTransport", () => {
  let transport: InProcessTransport;

  beforeEach(() => {
    transport = new InProcessTransport();
  });

  it("connects and closes", async () => {
    expect(transport.connected).toBe(false);
    await transport.connect();
    expect(transport.connected).toBe(true);
    await transport.close();
    expect(transport.connected).toBe(false);
  });

  it("ensureStream is a no-op", async () => {
    await transport.connect();
    // Should not throw
    await transport.ensureStream("TEST", ["test.>"]);
  });

  it("publish delivers to matching subscribers", async () => {
    await transport.connect();
    const received: TransportMessage[] = [];

    await transport.subscribe("agency.crm", (msg) => {
      received.push(msg);
    });

    const data = new Uint8Array([1, 2, 3]);
    await transport.publish("agency.crm", data);

    expect(received).toHaveLength(1);
    expect(received[0]!.data).toEqual(data);
    expect(received[0]!.subject).toBe("agency.crm");
  });

  it("publish does not deliver to non-matching subscribers", async () => {
    await transport.connect();
    const received: TransportMessage[] = [];

    await transport.subscribe("agency.crm", (msg) => {
      received.push(msg);
    });

    await transport.publish("agency.sales", new Uint8Array([1]));

    expect(received).toHaveLength(0);
  });

  it("supports wildcard subscriptions", async () => {
    await transport.connect();
    const received: TransportMessage[] = [];

    await transport.subscribe("agency.*._broadcast", (msg) => {
      received.push(msg);
    });

    await transport.publish("agency.crm._broadcast", new Uint8Array([1]));
    await transport.publish("agency.sales._broadcast", new Uint8Array([2]));
    await transport.publish("agency.crm.run.123", new Uint8Array([3]));

    expect(received).toHaveLength(2);
  });

  it("close clears all subscriptions", async () => {
    await transport.connect();
    const received: TransportMessage[] = [];

    await transport.subscribe("test", (msg) => {
      received.push(msg);
    });

    await transport.close();
    // Reconnect and publish - old subscriber should not receive
    await transport.connect();
    await transport.publish("test", new Uint8Array([1]));

    expect(received).toHaveLength(0);
  });

  it("ack is a no-op", async () => {
    await transport.connect();
    let message: TransportMessage | undefined;

    await transport.subscribe("test", (msg) => {
      message = msg;
    });

    await transport.publish("test", new Uint8Array([1]));
    // Should not throw
    await message!.ack();
  });

  it("request throws when no handler matches", async () => {
    await transport.connect();
    await expect(transport.request("test.unknown", new Uint8Array([1]))).rejects.toThrow(
      "No handler for request on test.unknown",
    );
  });

  it("supports async callbacks", async () => {
    await transport.connect();
    const received: string[] = [];

    await transport.subscribe("test", async (msg) => {
      // Simulate async work
      await new Promise<void>((r) => {
        const id = setTimeout(r, 1);
        void id;
      });
      const text = Array.from(msg.data, (b) => String.fromCharCode(b)).join("");
      received.push(text);
    });

    const data = new Uint8Array(Array.from("hello", (c) => c.charCodeAt(0)));
    await transport.publish("test", data);

    expect(received).toEqual(["hello"]);
  });
});
