/**
 * `kind: "judge-verdicts"` — an LLM judge's per-expectation verdicts (the SDC
 * binary-expectations judge). One card per expectation: met/unmet chip, the
 * requirement/reason, and the cited evidence span.
 *
 * Payload: `{ kind: "judge-verdicts", verdicts: Array<{ expectation_id, passed,
 * reason?, evidence? }> }`. Empty/absent verdicts ⇒ `null`.
 */

import { Badge } from "../../../components/atoms/Badge";
import { isRecord, rendererHeadingStyle } from "./shared";
import type { DetailRenderer } from "./types";

interface Verdict {
  expectationId: string;
  passed: boolean;
  reason?: string;
  evidence?: string;
}

function parseVerdicts(v: unknown): Verdict[] {
  if (!Array.isArray(v)) return [];
  const out: Verdict[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const id = raw.expectation_id ?? raw.expectationId;
    if (typeof id !== "string") continue;
    if (typeof raw.passed !== "boolean") continue;
    out.push({
      expectationId: id,
      passed: raw.passed,
      reason: typeof raw.reason === "string" ? raw.reason : undefined,
      evidence: typeof raw.evidence === "string" ? raw.evidence : undefined,
    });
  }
  return out;
}

const cardStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 4,
  padding: "6px 10px",
  background: "var(--bg-inset)",
  borderRadius: 6,
  borderLeft: "3px solid var(--border)",
};
const idStyle = { fontFamily: "var(--font-mono)", fontSize: 12 };
const reasonStyle = { fontSize: 12, color: "var(--fg-default)" };
const evidenceStyle = {
  fontSize: 12,
  color: "var(--fg-muted)",
  fontStyle: "italic" as const,
  borderLeft: "2px solid var(--border-muted)",
  paddingLeft: 8,
  wordBreak: "break-word" as const,
};

export const JudgeVerdictsDetail: DetailRenderer = ({ detail }) => {
  const verdicts = parseVerdicts((detail as { verdicts?: unknown }).verdicts);
  if (verdicts.length === 0) return null;

  const met = verdicts.filter((v) => v.passed).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
      <div style={rendererHeadingStyle}>
        Judge verdicts · {met}/{verdicts.length} met
      </div>
      {verdicts.map((v) => (
        <div
          key={v.expectationId}
          style={{ ...cardStyle, borderLeftColor: v.passed ? "var(--green)" : "var(--red)" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Badge tone={v.passed ? "green" : "red"}>{v.passed ? "met" : "unmet"}</Badge>
            <span style={idStyle}>{v.expectationId}</span>
          </div>
          {v.reason && <div style={reasonStyle}>{v.reason}</div>}
          {v.evidence && <div style={evidenceStyle}>“{v.evidence}”</div>}
        </div>
      ))}
    </div>
  );
};
