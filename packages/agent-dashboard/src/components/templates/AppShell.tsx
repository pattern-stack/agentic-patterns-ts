import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { ThemeToggle } from "../ThemeToggle";

const navGroups: { heading: string; items: { to: string; label: string; end?: boolean }[] }[] = [
  {
    heading: "Build",
    items: [
      { to: "/roles", label: "Roles" },
      { to: "/agents", label: "Agents" },
      { to: "/capabilities", label: "Capabilities" },
    ],
  },
  {
    heading: "Run",
    items: [
      { to: "/", label: "Dashboard", end: true },
      { to: "/chat", label: "Chat" },
      { to: "/tools", label: "Tools" },
      { to: "/tokens", label: "Tokens" },
      { to: "/live", label: "Live" },
      { to: "/graph", label: "Graph" },
      { to: "/claude-code", label: "Claude Code" },
      { to: "/conversations", label: "Conversations" },
    ],
  },
  {
    heading: "Evaluate",
    items: [{ to: "/eval", label: "Runs" }],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav
        style={{
          width: 220,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-surface)",
          borderRight: "1px solid var(--border)",
          padding: "20px 0",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: "0 20px 24px",
            fontSize: 15,
            fontWeight: 600,
            color: "var(--fg-default)",
            letterSpacing: "-0.01em",
          }}
        >
          Agentic Patterns
        </div>
        {navGroups.map((group) => (
          <div key={group.heading} style={{ marginBottom: 12 }}>
            <div
              style={{
                padding: "4px 20px",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--fg-subtle)",
              }}
            >
              {group.heading}
            </div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                style={({ isActive }) => ({
                  display: "block",
                  padding: "8px 20px",
                  fontSize: 14,
                  color: isActive ? "var(--fg-default)" : "var(--fg-muted)",
                  background: isActive ? "var(--bg-surface-hover)" : "transparent",
                  borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                  textDecoration: "none",
                })}
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
        <div style={{ marginTop: "auto", padding: "16px 20px 0" }}>
          <ThemeToggle />
        </div>
      </nav>
      <main style={{ flex: 1, padding: 24, overflow: "auto" }}>{children}</main>
    </div>
  );
}
