/**
 * RunLaunchModal — the set-detail page's "Run eval" affordance. Wraps the
 * shared `RunLaunchForm` (set locked to this page's set) in the eval `Modal`,
 * matching the sibling `SetEditModal` / `CaseEditModal` idiom. A 202 navigates
 * to the new run's detail page, which unmounts the modal.
 */

import { Modal } from "../../components/atoms/Modal";
import { RunLaunchForm } from "./RunLaunchForm";

interface RunLaunchModalProps {
  setId: string;
  setLabel?: string;
  /** Optional: also lock the target (the Agent lens's "Run" launches with both bound). */
  targetId?: string;
  targetLabel?: string;
  /** Optional initial scorer (a registration-declared default). */
  initialScorer?: string;
  onClose: () => void;
}

export function RunLaunchModal({
  setId,
  setLabel,
  targetId,
  targetLabel,
  initialScorer,
  onClose,
}: RunLaunchModalProps) {
  return (
    <Modal title="Run eval" onClose={onClose}>
      <RunLaunchForm
        presetSetId={setId}
        presetSetLabel={setLabel}
        presetTargetId={targetId}
        presetTargetLabel={targetLabel}
        initialScorer={initialScorer}
      />
    </Modal>
  );
}
