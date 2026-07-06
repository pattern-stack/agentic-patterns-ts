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
  onClose: () => void;
}

export function RunLaunchModal({ setId, setLabel, onClose }: RunLaunchModalProps) {
  return (
    <Modal title="Run eval" onClose={onClose}>
      <RunLaunchForm presetSetId={setId} presetSetLabel={setLabel} />
    </Modal>
  );
}
