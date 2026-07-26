/**
 * Render artifacts — the client-facing data channel described by
 * [ADR-0006](../../../../docs/adr/0006-render-artifacts.md).
 *
 * An artifact is something a client can render **directly, without
 * resolution**: no id lookup, no fetch, no round-trip. It travels alongside a
 * run's response and is deliberately INDEPENDENT of what a tool returned to
 * the model — that return value is the tool author's business and the
 * framework has no opinion about it (ADR §1).
 *
 * The separation is the whole point: a tool may hand the model a two-token
 * ref while publishing a 500-row table to the UI. Neither channel taxes the
 * other.
 *
 * ## What this module is NOT
 *
 * It is not a shaping layer. The framework never truncates, paginates or
 * samples `data` — `displayType` is an open string, so the payload is opaque
 * here, and partially reshaping a structure you cannot parse yields invalid
 * output. Producers shape their own data and say so via `truncated`
 * (ADR §4).
 */

import { z } from "zod";

/**
 * Canonical `data` shape for `displayType: "table"`.
 *
 * Column-oriented headers plus positional rows — the shape a table renderer
 * can consume with no further negotiation. Cell values stay `unknown`: a cell
 * may be a string, number, boolean, null, or a nested value the client
 * stringifies.
 */
export const TableArtifactDataSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
});

export type TableArtifactData = z.infer<typeof TableArtifactDataSchema>;

/**
 * A render-ready artifact.
 *
 * `data` is intentionally `unknown` and optional. Optional because an
 * artifact that breached the transport ceiling is published as a MARKER —
 * identity and type, no payload — so a client can honestly show "there was a
 * table here" instead of a convincing half-table (ADR §4).
 */
export const RenderArtifactSchema = z.object({
  /** Correlation handle, e.g. `"crm_table:e891ce…"`. Stable within a run. */
  id: z.string().min(1),
  /**
   * Render hint. Open string, extending the existing `ToolSchema.displayType`
   * convention (`code | diff | bash`) with `table`. Clients MUST degrade
   * gracefully on an unknown type rather than throw.
   */
  displayType: z.string().min(1),
  /** Payload; shape implied by `displayType`. Absent on a ceiling marker. */
  data: z.unknown(),
  /** Optional human label for the rendered block. */
  title: z.string().optional(),
  /**
   * Producer-set advisory: "I shortened this." The framework never inspects
   * or acts on it — it is a message from the producer to the client.
   */
  truncated: z.boolean().optional(),
});

export type RenderArtifact = z.infer<typeof RenderArtifactSchema>;

/**
 * Default transport ceiling (bytes) for a single artifact's serialized form.
 *
 * A sanity bound, NOT a tuning knob. Deliberately set far above any
 * legitimate payload — a ~1M-token context is on the order of a few MB of
 * text, so this sits an order of magnitude above that and should never fire
 * in normal use. It exists solely so a runaway producer cannot wedge a
 * stream. Enforcement lives in the runtime transport; the constant lives here
 * because it is part of the published contract.
 */
export const DEFAULT_ARTIFACT_BYTE_CEILING = 64 * 1024 * 1024;

/** Build a `table` artifact from headers + positional rows. */
export function tableArtifact(
  id: string,
  data: TableArtifactData,
  options?: { readonly title?: string; readonly truncated?: boolean },
): RenderArtifact {
  return Object.freeze({
    id,
    displayType: "table",
    data: Object.freeze({
      columns: Object.freeze([...data.columns]),
      rows: Object.freeze(data.rows.map((r) => Object.freeze([...r]))),
    }) as TableArtifactData,
    ...(options?.title !== undefined ? { title: options.title } : {}),
    ...(options?.truncated !== undefined ? { truncated: options.truncated } : {}),
  });
}

/**
 * Narrow an artifact to one carrying a valid table payload.
 *
 * Returns false for a `table` artifact whose `data` is absent (a ceiling
 * marker) or malformed — callers render the marker or fall back, never crash.
 */
export function isTableArtifact(
  artifact: RenderArtifact,
): artifact is RenderArtifact & { data: TableArtifactData } {
  return (
    artifact.displayType === "table" && TableArtifactDataSchema.safeParse(artifact.data).success
  );
}

/**
 * Reduce an artifact to a ceiling marker: identity and type preserved, payload
 * dropped, `truncated` asserted. Used by the transport when a payload breaches
 * {@link DEFAULT_ARTIFACT_BYTE_CEILING} — a hard drop, never a silent shrink.
 */
export function artifactMarker(artifact: RenderArtifact): RenderArtifact {
  return Object.freeze({
    id: artifact.id,
    displayType: artifact.displayType,
    data: undefined,
    truncated: true,
    ...(artifact.title !== undefined ? { title: artifact.title } : {}),
  });
}
