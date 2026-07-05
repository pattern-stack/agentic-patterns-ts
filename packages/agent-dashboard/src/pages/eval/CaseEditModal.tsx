/**
 * CaseEditModal (WI-5) — create or edit a case in a set's bank via `PUT
 * /eval/sets/:id/cases/:caseId`. The input (and optional expected) are edited
 * as JSON text and parsed strictly on save — invalid JSON blocks the save with
 * an inline error, matching the case-bank loader's fail-loud discipline. A
 * plain string is valid JSON when quoted (`"foo"`).
 */

import { type CSSProperties, type ReactNode, useState } from "react";
import type { EvalCaseRow, EvalSplit } from "../../api/types";
import { Button } from "../../components/atoms/Button";
import { Modal } from "../../components/atoms/Modal";
import { type CaseWriteBody, upsertEvalCase } from "../../lib/evalApi";

interface CaseEditModalProps {
  setId: string;
  mode: "create" | "edit";
  initial?: EvalCaseRow;
  onClose: () => void;
  onSaved: (row: EvalCaseRow) => void;
}

const SPLIT_OPTIONS: ReadonlyArray<{ value: "" | EvalSplit; label: string }> = [
  { value: "", label: "untagged" },
  { value: "train", label: "train" },
  { value: "dev", label: "dev" },
  { value: "test", label: "test" },
];

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string };

/** JSON.stringify for prefill; undefined/absent -> empty textarea. */
function prefill(value: unknown): string {
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, null, 2);
}

export function CaseEditModal({ setId, mode, initial, onClose, onSaved }: CaseEditModalProps) {
  const [caseId, setCaseId] = useState(initial?.caseId ?? "");
  const [inputText, setInputText] = useState(prefill(initial?.input));
  const [expectedText, setExpectedText] = useState(prefill(initial?.expected));
  const [tagsCsv, setTagsCsv] = useState((initial?.tags ?? []).join(", "));
  const [split, setSplit] = useState<"" | EvalSplit>(initial?.split ?? "");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const isEdit = mode === "edit";
  const busy = save.kind === "saving";
  const canSave = !busy && (isEdit || caseId.trim().length > 0);

  const handleSave = async () => {
    // Strict JSON — input required, expected optional.
    let input: unknown;
    try {
      input = JSON.parse(inputText);
    } catch {
      setSave({ kind: "error", message: 'Input is not valid JSON. Quote plain strings: "foo".' });
      return;
    }

    let expected: unknown;
    const expectedTrimmed = expectedText.trim();
    if (expectedTrimmed.length > 0) {
      try {
        expected = JSON.parse(expectedTrimmed);
      } catch {
        setSave({ kind: "error", message: "Expected is not valid JSON. Leave blank for none." });
        return;
      }
    }

    const tags = tagsCsv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const body: CaseWriteBody = {
      input,
      ...(expectedTrimmed.length > 0 ? { expected } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(split ? { split } : {}),
    };

    setSave({ kind: "saving" });
    try {
      const result = await upsertEvalCase(setId, caseId.trim(), body);
      if (result.kind === "unconfigured") {
        setSave({ kind: "unconfigured" });
        return;
      }
      onSaved(result.data);
    } catch (e) {
      setSave({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Modal
      title={isEdit ? `Edit case — ${initial?.caseId}` : "New case"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <Field label="Case id">
        <input
          aria-label="Case id"
          value={caseId}
          onChange={(e) => setCaseId(e.target.value)}
          disabled={isEdit || busy}
          style={inputStyle}
          placeholder="e.g. case-01"
        />
      </Field>
      <Field label="Input (JSON)">
        <textarea
          aria-label="Case input"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          disabled={busy}
          rows={4}
          style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
          placeholder={'"2+2?"  or  {"q": "2+2?"}'}
        />
      </Field>
      <Field label="Expected (JSON, optional)">
        <textarea
          aria-label="Case expected"
          value={expectedText}
          onChange={(e) => setExpectedText(e.target.value)}
          disabled={busy}
          rows={3}
          style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
          placeholder={'"4"'}
        />
      </Field>
      <Field label="Tags (comma-separated)">
        <input
          aria-label="Case tags"
          value={tagsCsv}
          onChange={(e) => setTagsCsv(e.target.value)}
          disabled={busy}
          style={inputStyle}
          placeholder="smoke, regression"
        />
      </Field>
      <Field label="Split">
        <select
          aria-label="Case split"
          value={split}
          onChange={(e) => setSplit(e.target.value as "" | EvalSplit)}
          disabled={busy}
          style={inputStyle}
        >
          {SPLIT_OPTIONS.map((o) => (
            <option key={o.value || "untagged"} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      {save.kind === "unconfigured" && (
        <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          Eval persistence is not configured on this server.
        </div>
      )}
      {save.kind === "error" && (
        <div style={{ fontSize: 13, color: "var(--red)" }}>{save.message}</div>
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--fg-muted)",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

const inputStyle: CSSProperties = {
  padding: "6px 10px",
  fontSize: 13,
  fontFamily: "inherit",
  background: "var(--bg-inset)",
  color: "var(--fg-default)",
  border: "1px solid var(--border)",
  borderRadius: 6,
};
