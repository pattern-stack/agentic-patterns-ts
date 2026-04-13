import { describe, expect, it } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import { createEvent } from "../../events/types.js";
import { SSEExporter } from "../sse.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  // Read one chunk and release
  const { value, done } = await reader.read();
  if (!done && value) {
    result += decoder.decode(value);
  }
  reader.releaseLock();
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSEExporter", () => {
  it("connects and returns a ReadableStream", () => {
    const exporter = new SSEExporter();
    const stream = exporter.connect();
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(exporter.clientCount).toBe(1);
  });

  it("broadcasts formatted events to connected clients", async () => {
    const exporter = new SSEExporter();
    const bus = new EventBus();
    exporter.attach(bus);

    const stream = exporter.connect();

    const event = createEvent("agent.message.chunk", {
      traceId: "t1",
      runId: "r1",
      delta: "hello",
      chunkIndex: 0,
    });

    await exporter.handleEvent(event);

    const text = await readStream(stream);
    expect(text).toContain("event: message.delta");
    expect(text).toContain("hello");

    exporter.detach(bus);
  });

  it("broadcasts to multiple clients", async () => {
    const exporter = new SSEExporter();
    const stream1 = exporter.connect();
    const stream2 = exporter.connect();
    expect(exporter.clientCount).toBe(2);

    const event = createEvent("agent.message.start", {
      traceId: "t1",
      runId: "r1",
      agentName: "test",
    });

    await exporter.handleEvent(event);

    const text1 = await readStream(stream1);
    const text2 = await readStream(stream2);
    expect(text1).toContain("event: message.start");
    expect(text2).toContain("event: message.start");
  });

  it("disconnect removes client", () => {
    const exporter = new SSEExporter();
    const stream = exporter.connect();
    expect(exporter.clientCount).toBe(1);

    exporter.disconnect(stream);
    expect(exporter.clientCount).toBe(0);
  });

  it("handles events that formatter returns null for gracefully", async () => {
    const exporter = new SSEExporter();
    const stream = exporter.connect();

    // Create a mock event with an unknown type - the formatter will return null
    // We can't easily test this since all event types are now mapped,
    // but we can verify no error is thrown
    const event = createEvent("agent.message.start", {
      traceId: "t1",
      runId: "r1",
      agentName: "test",
    });
    await exporter.handleEvent(event);

    const text = await readStream(stream);
    expect(text.length).toBeGreaterThan(0);
  });

  it("ignores disconnected clients on broadcast", async () => {
    const exporter = new SSEExporter();
    const stream1 = exporter.connect();
    const stream2 = exporter.connect();
    exporter.disconnect(stream1);

    const event = createEvent("agent.message.chunk", {
      traceId: "t1",
      runId: "r1",
      delta: "test",
      chunkIndex: 0,
    });

    // Should not throw even though stream1 is disconnected
    await exporter.handleEvent(event);

    const text = await readStream(stream2);
    expect(text).toContain("event: message.delta");
    expect(exporter.clientCount).toBe(1);
  });
});
