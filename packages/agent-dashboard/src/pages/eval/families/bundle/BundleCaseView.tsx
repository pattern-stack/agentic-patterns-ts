/**
 * Question-bundle case view — the fixture's question card (scope key-values
 * incl. `as_of` from the case input), the gold-expectation card grid
 * (`ExpectationCards` over `expected.ground_truth.expectations`), and the
 * golden response rendered via `EvidenceText`. Replaces the generic
 * pretty-JSON input/expected panes; the page keeps the cross-run history
 * section below (meaningful here — SDC runs key results by fixture id).
 */

import { Card } from "../../../../components/atoms/Card";
import { Chip } from "../../../../components/atoms/Chip";
import { EvidenceText } from "../../components/EvidenceText";
import type { FamilyCaseViewProps } from "../index";
import { ExpectationCards, parseExpectations, parseGoldenResponse } from "./ExpectationCards";

const sectionHeadingStyle = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
  color: "var(--fg-subtle)",
  marginBottom: 8,
};

const panelStyle = {
  padding: "2px 12px",
  background: "var(--bg-inset)",
  borderRadius: 6,
  fontSize: 13,
  overflowX: "auto" as const,
  wordBreak: "break-word" as const,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function BundleCaseView({ caseRow }: FamilyCaseViewProps) {
  const input = isRecord(caseRow.input) ? caseRow.input : {};
  const question = typeof input.question === "string" ? input.question : null;
  // Scope key-values: every scalar input field beyond the question (scope,
  // as_of, and whatever else the exporter records) renders as a `key · value`
  // chip — no invented fields, no dropped ones.
  const scopeEntries = Object.entries(input).filter(
    ([key, v]) =>
      key !== "question" &&
      (typeof v === "string" || typeof v === "number" || typeof v === "boolean"),
  );
  const expectations = parseExpectations(caseRow.expected);
  const golden = parseGoldenResponse(caseRow.expected);
  const requiredCount = expectations.filter((e) => e.required).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card>
        <div style={sectionHeadingStyle}>Question</div>
        {question ? (
          <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.5 }}>{question}</div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
            This case's input carries no question.
          </div>
        )}
        {scopeEntries.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            {scopeEntries.map(([key, v]) => (
              <Chip key={key} tone="mono" title={key}>
                {key} · {String(v)}
              </Chip>
            ))}
          </div>
        )}
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Gold expectations</h2>
          {expectations.length > 0 && (
            <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>
              {requiredCount} required · {expectations.length} total
            </span>
          )}
        </div>
        <ExpectationCards expectations={expectations} />
      </div>

      <Card>
        <div style={sectionHeadingStyle}>Golden response</div>
        {golden ? (
          <div style={panelStyle}>
            <EvidenceText content={golden} />
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>No golden response recorded.</div>
        )}
      </Card>
    </div>
  );
}
