/**
 * ToolRunner — the Tool Workbench's Run tab body (port-map §2.1, §2.3). Ports
 * swe-brain's `CapabilityToolRunner` semantics VERBATIM: same widget map,
 * same `coerce`, same omit-empty-optionals args assembly, same result UX.
 * The only swap is the transport — POSTs through
 * `compositionApi.invokeTool()` (`api/composition.ts`) against THIS repo's
 * `/capabilities/:id/tools/:toolName/invoke` (S3) instead of swe-brain's
 * `/agents/capabilities/:cap/tools/:tool`. No model backend in this path —
 * the server calls `toolbox.execute()` straight (see routes/composition.ts).
 */

import type { CSSProperties } from "react";
import { useState } from "react";
import { type ToolDef, type ToolRunResult, compositionApi } from "../../api/composition";
import { foldToolParams } from "../../lib/toolParams";
import { T } from "../../ui/tokens";
import { Button } from "../atoms/Button";
import { JsonBlock } from "../kit/JsonBlock";

const RESULT_MAX_H = 320;

function isNumeric(type: string): boolean {
  return type === "number" || type === "integer";
}
function isJsonShape(type: string): boolean {
  return type === "object" || type === "array" || type === "unknown";
}

/**
 * Coerce a raw form string into the JS value the tool's Zod schema expects.
 * Numeric params -> `Number(raw)`; object/array/unknown params -> `JSON.parse`,
 * falling back to the RAW string on a parse failure so the SERVER's Zod
 * schema produces the rejection message — deliberate, it demos validation
 * (port-map §2.3, ported verbatim from swe-brain's `run-tool.ts` `coerce`).
 */
export function coerce(type: string, raw: string): unknown {
  if (isNumeric(type)) return Number(raw);
  if (isJsonShape(type)) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Build the `args` object actually sent to the invoke endpoint from the raw
 * form `values` — the omit-empty-optionals rule (port-map §2.3): only FILLED
 * fields enter `args`, so the tool's own required-checks / defaults apply and
 * a missing required field demos a real Zod rejection. Booleans are the
 * exception: an untouched checkbox sends nothing, but once touched, `false`
 * IS sent (the value is `boolean`, not the empty string, so it always
 * qualifies). Exported (alongside `coerce`) so the semantics are unit-pinned
 * without needing a full DOM render.
 */
export function buildArgs(
  params: { name: string; type: string }[],
  values: Record<string, string | boolean>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const p of params) {
    const v = values[p.name];
    if (p.type === "boolean") {
      if (typeof v === "boolean") args[p.name] = v;
    } else if (typeof v === "string" && v !== "") {
      args[p.name] = coerce(p.type, v);
    }
  }
  return args;
}

function rowSummary(result: unknown): string | null {
  if (Array.isArray(result)) return `${result.length} row${result.length === 1 ? "" : "s"}`;
  return null;
}

export function ToolRunner({ capId, tool }: { capId: string; tool: ToolDef }) {
  const params = foldToolParams(tool.parameters);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ToolRunResult | null>(null);

  const run = async () => {
    setRunning(true);
    setResult(null);
    const args = buildArgs(params, values);
    try {
      setResult(await compositionApi.invokeTool(capId, tool.name, args));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {params.length === 0 ? (
        <span style={{ fontSize: T.fz.tiny, color: "var(--mute)" }}>No parameters.</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {params.map((p) => {
            const fieldId = `param-${tool.name}-${p.name}`;
            return (
              <label
                key={p.name}
                htmlFor={fieldId}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(7rem, 10rem) 1fr",
                  gap: 12,
                  alignItems: "start",
                }}
              >
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span
                    style={{ fontFamily: T.font.mono, fontSize: T.fz.tiny, color: "var(--ink-2)" }}
                  >
                    {p.name}
                    {p.required && <span style={{ color: "var(--err)" }}> *</span>}
                    <span style={{ color: "var(--mute)" }}> · {p.type}</span>
                  </span>
                  {p.description && (
                    <span style={{ fontSize: T.fz.micro, color: "var(--mute)", lineHeight: 1.3 }}>
                      {p.description}
                    </span>
                  )}
                </span>
                {p.type === "boolean" ? (
                  <input
                    id={fieldId}
                    type="checkbox"
                    checked={values[p.name] === true}
                    onChange={(e) => setValues((s) => ({ ...s, [p.name]: e.target.checked }))}
                  />
                ) : (
                  <input
                    id={fieldId}
                    type={isNumeric(p.type) ? "number" : "text"}
                    value={(values[p.name] as string) ?? ""}
                    placeholder={isJsonShape(p.type) ? "JSON" : p.type}
                    onChange={(e) => setValues((s) => ({ ...s, [p.name]: e.target.value }))}
                    style={INPUT_STYLE}
                  />
                )}
              </label>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Button variant="primary" onClick={run} disabled={running}>
          {running ? "Running…" : "Run tool"}
        </Button>
        {result && (
          <span style={{ fontFamily: T.font.mono, fontSize: T.fz.tiny, color: "var(--mute)" }}>
            {result.ok ? "ok" : "error"} · {result.ms}ms
            {result.ok && rowSummary(result.result) ? ` · ${rowSummary(result.result)}` : ""}
          </span>
        )}
      </div>

      {result && !result.ok && (
        <div
          style={{
            fontSize: T.fz.small,
            color: "var(--err-ink)",
            background: "var(--err-soft)",
            border: "1px solid color-mix(in oklch, var(--err) 30%, var(--line))",
            borderRadius: "var(--radius-md)",
            padding: "8px 12px",
          }}
        >
          {result.error}
        </div>
      )}
      {result?.ok && (
        <JsonBlock
          value={result.result}
          maxHeight={RESULT_MAX_H}
          style={{ background: "var(--fill)" }}
        />
      )}
    </div>
  );
}

const INPUT_STYLE: CSSProperties = {
  fontFamily: T.font.mono,
  fontSize: T.fz.small,
  color: "var(--ink)",
  background: "var(--paper)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-sm)",
  padding: "4px 8px",
  width: "100%",
};
