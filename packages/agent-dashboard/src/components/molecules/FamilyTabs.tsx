/**
 * FamilyTabs — underline tab bar linking the three composition doors (docs
 * §3/§6/§10): Agents · Roles · Capabilities read as one family, ported from
 * swe-brain's `AgentFamilyTabs` (port-map §2.1). Unlike the swe-brain source
 * (which took an explicit `active` prop per page), this reads the active tab
 * straight off the router via `NavLink`'s `isActive` — so it stays correct
 * across nested routes (`/capabilities` <-> `/capabilities/:id`,
 * `/agents` <-> `/agents/:id`) with zero per-page wiring.
 */
import type { CSSProperties } from "react";
import { NavLink } from "react-router-dom";
import { T } from "../../ui/tokens";

const FAMILY: { label: string; to: string }[] = [
  { label: "Agents", to: "/agents" },
  { label: "Roles", to: "/roles" },
  { label: "Capabilities", to: "/capabilities" },
];

export function FamilyTabs() {
  return (
    <nav
      aria-label="Composition family"
      style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--line)" }}
    >
      {FAMILY.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          style={({ isActive }): CSSProperties => ({
            padding: "8px 14px",
            marginBottom: -1,
            fontSize: T.fz.small,
            fontWeight: 600,
            color: isActive ? "var(--ink)" : "var(--mute)",
            textDecoration: "none",
            borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
          })}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
