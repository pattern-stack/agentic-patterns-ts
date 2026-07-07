import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens-base.css";
import "./styles/theme-blue.css";
import "./styles/theme-blue-dark.css";
import "./styles/theme-earth.css";
import "./styles/theme-earth-dark.css";
import "./styles/theme-chalky.css";
import "./styles/theme-chalkboard.css";
import "./styles/globals.css";
import "./styles/atoms.css";
import { applyPreference, getPreference, watchSystemMode } from "./ui/theme-mode";

// Re-apply the saved preference (the inline script in index.html already set
// a concrete data-theme before first paint; this keeps React + DOM in sync
// after hydration) and start the live OS-flip listener for `mode: "system"`.
applyPreference(getPreference());
watchSystemMode();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
