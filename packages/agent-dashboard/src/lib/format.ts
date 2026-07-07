/**
 * Shared formatting helpers (port-map §7.2 shared page kit). Consolidates the
 * hand-copied `relative()`/`shortId()`/`formatDuration()` locals that had
 * drifted across ~10 pages (EvalRunsPage, EvalSetsPage, EvalSetDetailPage,
 * EvalCaseDetailPage, ConversationsPage, ConversationDetailPage, EvalRunDetailPage,
 * chat/atoms.tsx's `RelativeTime`) into one implementation each. Also owns the
 * `statusTone` consolidation (port-map: "5 incompatible copies" — the fold
 * below is a deliberate canonicalization, not a byte-for-byte merge; see the
 * doc comment on `statusTone`).
 */
import type { Tone } from "../components/atoms/Badge";

/** Truncate an id to its first `len` characters (default 8) — run/conversation/eval-run ids. */
export function shortId(id: string | null | undefined, len = 8): string {
  const s = id ?? "";
  return s.length > len ? s.slice(0, len) : s;
}

/**
 * Relative "N ago" formatter. Accepts an ISO date string (the common case —
 * `createdAt`/`tsStart`/... from the API) OR an epoch-ms number (chat's
 * `RelativeTime`, which re-renders off a ticking clock). `<5s` collapses to
 * "now" (chat's nuance); everything else matches the per-page `relative()`
 * copies this replaces.
 */
export function relTime(when: string | number | null | undefined): string {
  if (when === null || when === undefined || when === "") return "—";
  const then = typeof when === "number" ? when : new Date(when).getTime();
  if (Number.isNaN(then)) return String(when);
  const diffSec = Math.round((Date.now() - then) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 5) return "now";
  if (abs < 60) return `${diffSec}s ago`;
  if (abs < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (abs < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

/** Format a raw millisecond duration: `null` → "—"; sub-second → "Nms"; else "N.Ns"/"Ns". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/** Diff two ISO timestamps into a duration string; `null` when either is missing/invalid. */
export function formatDuration(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): string | null {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return formatMs(ms);
}

/** `JSON.stringify(value, null, 2)`, falling back to `String(value)`; `undefined` → "—". */
export function prettyJson(value: unknown): string {
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Canonical status → cockpit tone. The pages this replaces (EvalRunsPage/
 * EvalRunDetailPage/EvalComparePage/EvalSetDetailPage, ConversationsPage/
 * ConversationDetailPage, DashboardPage) each hand-rolled a slightly different
 * mapping for the same handful of status strings — a real inconsistency the
 * port-map calls out (§7.2: "5 incompatible copies"), not just duplication.
 * This picks ONE mapping, matching the majority precedent:
 *   ok | completed          → ok    (done, successful)
 *   active | running | pending → run (in flight — the cockpit's dedicated tone)
 *   error | failed          → err
 *   idle                    → mute  (was warn-toned on DashboardPage only; not a problem state)
 *   anything else           → mute
 */
const STATUS_TONE: Record<string, Tone> = {
  ok: "ok",
  completed: "ok",
  active: "run",
  running: "run",
  pending: "run",
  error: "err",
  failed: "err",
  idle: "mute",
};

export function statusTone(status: string | null | undefined): Tone {
  if (!status) return "mute";
  return STATUS_TONE[status] ?? "mute";
}
