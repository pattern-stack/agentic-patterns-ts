/**
 * ExpectationCards — the question-bundle gold-expectation card grid.
 *
 * Parses `expected.ground_truth.expectations` (the exporter/seed shape:
 * `{ id, kind:"deterministic"|"judge", required, weight, text, source }`)
 * defensively — malformed entries are dropped, an empty parse renders a muted
 * note (never fake data). `parseExpectations` / `parseGoldenResponse` are the
 * ONE place the bundle `expected` blob is read; `BundleSetView` (counts) and
 * `BundleCaseView` (cards + golden) both import them.
 *
 * Note: the seed carries each expectation's resolved source label on
 * `expectation.source` (a plain string, e.g. "Pricing call 2026-06-12") — that
 * label renders as the card's source chip.
 */

import { Badge } from "../../../../components/atoms/Badge";
import { Chip } from "../../../../components/atoms/Chip";

export interface GoldExpectation {
  id: string;
  kind: "deterministic" | "judge";
  required: boolean;
  weight?: number;
  text?: string;
  source?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** The fixture's gold expectations, or `[]` when the blob is absent/malformed. */
export function parseExpectations(expected: unknown): GoldExpectation[] {
  if (!isRecord(expected)) return [];
  const gt = expected.ground_truth;
  if (!isRecord(gt) || !Array.isArray(gt.expectations)) return [];
  const out: GoldExpectation[] = [];
  for (const e of gt.expectations) {
    if (!isRecord(e) || typeof e.id !== "string") continue;
    out.push({
      id: e.id,
      kind: e.kind === "judge" ? "judge" : "deterministic",
      required: e.required === true,
      weight: typeof e.weight === "number" && Number.isFinite(e.weight) ? e.weight : undefined,
      text: typeof e.text === "string" ? e.text : undefined,
      source: typeof e.source === "string" ? e.source : undefined,
    });
  }
  return out;
}

/** The fixture's golden response markdown, or `null` when absent. */
export function parseGoldenResponse(expected: unknown): string | null {
  if (!isRecord(expected)) return null;
  const gt = expected.ground_truth;
  if (!isRecord(gt)) return null;
  return typeof gt.golden_response === "string" ? gt.golden_response : null;
}

const cardStyle = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 12,
  display: "flex",
  flexDirection: "column" as const,
  gap: 8,
  background: "var(--bg-surface)",
};

/** Card grid over a fixture's gold expectations. */
export function ExpectationCards({
  expectations,
}: {
  expectations: readonly GoldExpectation[];
}) {
  if (expectations.length === 0) {
    return (
      <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
        No gold expectations recorded on this fixture.
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
        gap: 10,
      }}
    >
      {expectations.map((e) => (
        <div key={e.id} style={cardStyle}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{e.id}</span>
            <Badge tone={e.required ? "yellow" : "muted"}>
              {e.required ? "required" : "optional"}
            </Badge>
            <Badge tone={e.kind === "judge" ? "purple" : "green"}>{e.kind}</Badge>
            {e.weight !== undefined && <Chip tone="mono">weight {e.weight}</Chip>}
          </div>
          {e.text && <div style={{ fontSize: 13, lineHeight: 1.5 }}>{e.text}</div>}
          {e.source && (
            <div>
              <Chip tone="neutral" title="source">
                {e.source}
              </Chip>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
