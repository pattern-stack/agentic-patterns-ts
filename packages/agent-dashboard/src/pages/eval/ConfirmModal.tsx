/**
 * ConfirmModal (WI-5) — a Modal-backed yes/no confirm for destructive eval
 * actions (case delete). Runs an async `onConfirm`, surfacing its error inline
 * and keeping the dialog open on failure.
 */

import { useState } from "react";
import { Button } from "../../components/atoms/Button";
import { Modal } from "../../components/atoms/Modal";

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Delete",
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleConfirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={busy}
            style={{ background: "var(--err)", borderColor: "var(--err)", color: "var(--paper)" }}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 14, color: "var(--fg-default)" }}>{message}</div>
      {error && <div style={{ fontSize: 13, color: "var(--red)" }}>{error}</div>}
    </Modal>
  );
}
