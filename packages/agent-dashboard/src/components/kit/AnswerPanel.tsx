/**
 * AnswerPanel — the eval pages' `ActualAnswer` idiom (port-map §7.2), copied
 * three times (EvalComparePage, EvalCaseDetailPage, CaseDetail.tsx): canvas
 * evals persist their answer as an array of markdown lines
 * (`safeParseAnswer` yields a `string[]`) — render those as markdown; every
 * other shape stays pretty-printed JSON via `JsonBlock`. The fail border
 * (`pass === false`) is preserved either way.
 *
 * Callers still run `safeParseAnswer(finalAnswer)` themselves (lib/evalApi.ts)
 * — this component stays decoupled from the eval API and only renders the
 * already-parsed value.
 */
import { Markdown } from "../../chat/atoms";
import { T } from "../../ui/tokens";
import { JsonBlock } from "./JsonBlock";

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function AnswerPanel({ value, pass }: { value: unknown; pass?: boolean | null }) {
  const failed = pass === false;
  if (isStringArray(value)) {
    return (
      <div
        style={{
          margin: 0,
          padding: "2px 12px",
          background: "var(--background)",
          borderRadius: "var(--radius-sm)",
          fontSize: T.fz.md,
          overflowX: "auto",
          wordBreak: "break-word",
          ...(failed ? { borderLeft: "3px solid var(--err)" } : {}),
        }}
      >
        <Markdown content={value.join("\n")} />
      </div>
    );
  }
  return <JsonBlock value={value} errorTinted={failed} />;
}
