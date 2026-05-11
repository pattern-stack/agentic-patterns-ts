/**
 * REST client for the historical event endpoints.
 *
 * These are used by pages that want to hydrate from the durable event log
 * before layering live SSE on top — so a fresh page load shows yesterday's
 * sessions instead of starting empty.
 */

import type { StreamEvent } from "../hooks/useEventStream";

/** Shape returned by GET /admin/events/recent. */
interface RecentEventsResponse {
  events: PersistedEventRow[];
}

interface PersistedEventRow {
  id: number;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface FetchRecentOptions {
  /** Filter to a single event type (e.g. `"claude_code.hook"`). */
  type?: string;
  /** Lower bound on `timestamp` (ISO). Defaults to 7 days ago. */
  since?: Date;
  /** Max rows returned. Server clamps to [1, 10000]. Default 1000. */
  limit?: number;
  /** Override default base URL (mostly for tests). */
  baseUrl?: string;
}

/**
 * Fetch recent persisted events and translate them into the same `StreamEvent`
 * shape `useEventStream` produces. Returns `[]` when the server reports the
 * store is not configured (503) so consumers can degrade gracefully.
 */
export async function fetchRecentEvents(opts: FetchRecentOptions = {}): Promise<StreamEvent[]> {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.since) params.set("since", opts.since.toISOString());
  if (opts.limit) params.set("limit", String(opts.limit));

  const base = opts.baseUrl ?? "";
  const url = `${base}/admin/events/recent${params.size ? `?${params}` : ""}`;

  const res = await fetch(url);
  if (res.status === 503) return [];
  if (!res.ok) throw new Error(`fetchRecentEvents: HTTP ${res.status}`);

  const body = (await res.json()) as RecentEventsResponse;
  // Server returns DESC; the page assumes ASC arrival order, so reverse.
  const rows = [...body.events].reverse();
  return rows.map((row) => ({
    id: `hist-${row.id}`,
    type: row.type,
    data: row.data,
    timestamp: row.timestamp,
  }));
}
