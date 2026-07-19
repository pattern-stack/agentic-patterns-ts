/**
 * `kind: "curation-facts"` — the curation bench's gold-fact survival: which
 * expected facts survived curation vs were cut, plus optional per-evidence-type
 * retention bars. Shows *which* facts curation killed, not just an aggregate.
 *
 * Payload: `{ kind: "curation-facts",
 *   survival: { rate: number|null, survived: number, available: number,
 *     perExpectation?: Array<{ expectationId, contentRetained: boolean,
 *       survived?: boolean, availablePreCuration?: boolean }> },
 *   typeCoverage?: Record<string, { rowsKept: number, rowsAvail: number }> }`.
 * Missing `survival` ⇒ `null`.
 */

import { Badge } from "../../../components/atoms/Badge";
import { MeterBar, isRecord, numOrNull, rendererHeadingStyle } from "./shared";
import type { DetailRenderer } from "./types";

interface ExpFact {
  expectationId: string;
  retained: boolean;
  available: boolean;
}

function parsePerExpectation(v: unknown): ExpFact[] {
  if (!Array.isArray(v)) return [];
  const out: ExpFact[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const id = raw.expectationId ?? raw.expectation_id;
    if (typeof id !== "string") continue;
    // `survived` is authoritative; fall back to contentRetained.
    const retained =
      typeof raw.survived === "boolean"
        ? raw.survived
        : typeof raw.contentRetained === "boolean"
          ? raw.contentRetained
          : false;
    const available = raw.availablePreCuration !== false; // default available
    out.push({ expectationId: id, retained, available });
  }
  return out;
}

const chipRow = { display: "flex", flexWrap: "wrap" as const, gap: 6 };
const typeRowStyle = {
  display: "grid",
  gridTemplateColumns: "minmax(0,1fr) 56px",
  gap: "2px 8px",
  alignItems: "center",
};
const typeNameStyle = { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" };
const typeValStyle = { fontFamily: "var(--font-mono)", fontSize: 11, textAlign: "right" as const };

export const CurationFactsDetail: DetailRenderer = ({ detail }) => {
  const survival = (detail as { survival?: unknown }).survival;
  if (!isRecord(survival)) return null;

  const rate = numOrNull(survival.rate);
  const survived = numOrNull(survival.survived);
  const available = numOrNull(survival.available);
  const perExp = parsePerExpectation(survival.perExpectation);

  const typeCoverage = (detail as { typeCoverage?: unknown }).typeCoverage;
  const typeRows: { type: string; kept: number; avail: number }[] = [];
  if (isRecord(typeCoverage)) {
    for (const [type, val] of Object.entries(typeCoverage)) {
      if (!isRecord(val)) continue;
      const kept = numOrNull(val.rowsKept);
      const avail = numOrNull(val.rowsAvail);
      if (kept !== null && avail !== null) typeRows.push({ type, kept, avail });
    }
  }

  const headline =
    rate !== null
      ? `${Math.round(rate * 100)}% survived${survived !== null && available !== null ? ` · ${survived}/${available} facts` : ""}`
      : survived !== null && available !== null
        ? `${survived}/${available} facts survived`
        : "gold-fact survival";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 2 }}>
      <div style={rendererHeadingStyle}>Gold-fact survival · {headline}</div>

      {perExp.length > 0 && (
        <div style={chipRow}>
          {perExp.map((e) => {
            const tone = !e.available ? "muted" : e.retained ? "green" : "red";
            const mark = !e.available ? "·" : e.retained ? "✓" : "✕";
            return (
              <Badge
                key={e.expectationId}
                tone={tone}
                title={e.available ? undefined : "not available pre-curation"}
              >
                {e.expectationId} {mark}
              </Badge>
            );
          })}
        </div>
      )}

      {typeRows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {typeRows.map((t) => {
            const frac = t.avail > 0 ? t.kept / t.avail : null;
            return (
              <div key={t.type} style={typeRowStyle}>
                <span style={typeNameStyle}>{t.type}</span>
                <span style={typeValStyle}>
                  {t.kept}/{t.avail}
                </span>
                <div style={{ gridColumn: "1 / 3" }}>
                  <MeterBar value={frac} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
