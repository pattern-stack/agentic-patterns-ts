/**
 * Observability bootstrap — one place that wires the EventBus, collector,
 * admin service, and SSE exporter that the server / playground commands
 * share. Keeps all three in lockstep.
 */

import {
  AgentEventBus,
  InMemoryAdminService,
  InMemoryEventCollector,
  SSEExporter,
} from "@pattern-stack/agentic-runtime";

export interface ObservabilityStack {
  eventBus: AgentEventBus;
  collector: InMemoryEventCollector;
  adminService: InMemoryAdminService;
  sseExporter: SSEExporter;
}

/** Build a fresh observability stack and wire its exporters to the bus. */
export function buildObservabilityStack(): ObservabilityStack {
  const eventBus = new AgentEventBus();

  const collector = new InMemoryEventCollector();
  collector.attach(eventBus);

  const adminService = new InMemoryAdminService(collector);

  const sseExporter = new SSEExporter();
  sseExporter.attach(eventBus);

  return { eventBus, collector, adminService, sseExporter };
}
