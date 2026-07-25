/**
 * RunLauncher — the Eval Runs header affordance for `POST /eval/runs` (#139,
 * E5c). A "Run eval" button that expands an inline form Card on click (the
 * `SplitAggregatesPanel` page-scoped-component idiom). The set-detail header
 * uses `RunLaunchModal` instead; both share `RunLaunchForm`.
 */

import { useState } from "react";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { useBreakpoint } from "../../hooks/useMediaQuery";
import { RunLaunchForm } from "./RunLaunchForm";

export function RunLauncher() {
  const [open, setOpen] = useState(false);
  const { isPhone } = useBreakpoint();

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Run eval
      </Button>
    );
  }

  return (
    <Card
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minWidth: isPhone ? 0 : 320,
        maxWidth: "100%",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Run eval</div>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      <RunLaunchForm />
    </Card>
  );
}
