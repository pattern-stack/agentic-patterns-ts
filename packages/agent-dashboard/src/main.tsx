import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/theme.css";
import "./styles/globals.css";
import "./styles/atoms.css";
import { applyMode, getMode } from "./ui/theme-mode";

// Re-apply the saved mode (the inline script in index.html already set it before
// first paint; this keeps React + DOM in sync after hydration).
applyMode(getMode());

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
