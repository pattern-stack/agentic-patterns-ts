/**
 * SetEditModal (WI-5) — create a new eval set or edit an existing one's
 * metadata. Create posts to `POST /eval/sets`; edit patches `PATCH
 * /eval/sets/:id` (the id is immutable once created). `onSaved` fires with the
 * fresh summary so the caller can reload.
 */

import { useState } from "react";
import type { EvalSetSummary } from "../../api/types";
import { Button } from "../../components/atoms/Button";
import { Modal } from "../../components/atoms/Modal";
import { Field, inputStyle } from "../../components/kit/Field";
import { createEvalSet, updateEvalSet } from "../../lib/evalApi";

interface SetEditModalProps {
  mode: "create" | "edit";
  initial?: { id: string; name: string | null; description: string | null };
  onClose: () => void;
  onSaved: (set: EvalSetSummary) => void;
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string };

export function SetEditModal({ mode, initial, onClose, onSaved }: SetEditModalProps) {
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const isEdit = mode === "edit";
  const busy = save.kind === "saving";
  const canSave = !busy && (isEdit || id.trim().length > 0);

  const handleSave = async () => {
    setSave({ kind: "saving" });
    try {
      const result = isEdit
        ? await updateEvalSet(id, {
            name: name.trim() || undefined,
            description: description.trim() || undefined,
          })
        : await createEvalSet({
            id: id.trim(),
            name: name.trim() || undefined,
            description: description.trim() || undefined,
          });
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
      title={isEdit ? `Edit set — ${initial?.id}` : "New eval set"}
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
      <Field label="Set id (slug)">
        <input
          aria-label="Set id"
          value={id}
          onChange={(e) => setId(e.target.value)}
          disabled={isEdit || busy}
          style={inputStyle}
          placeholder="e.g. curator-smoke"
        />
      </Field>
      <Field label="Name (optional)">
        <input
          aria-label="Set name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          style={inputStyle}
        />
      </Field>
      <Field label="Description (optional)">
        <input
          aria-label="Set description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
          style={inputStyle}
        />
      </Field>

      {save.kind === "unconfigured" && (
        <div style={{ fontSize: 13, color: "var(--mute)" }}>
          Eval persistence is not configured on this server.
        </div>
      )}
      {save.kind === "error" && (
        <div style={{ fontSize: 13, color: "var(--err)" }}>{save.message}</div>
      )}
    </Modal>
  );
}
