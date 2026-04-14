import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

const navItems = [
  { to: "/", label: "Dashboard" },
  { to: "/chat", label: "Chat" },
  { to: "/agents", label: "Agents" },
  { to: "/tools", label: "Tools" },
  { to: "/tokens", label: "Tokens" },
  { to: "/live", label: "Live" },
  { to: "/conversations", label: "Conversations" },
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav
        style={{
          width: 220,
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
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
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
      </nav>
      <main style={{ flex: 1, padding: 24, overflow: "auto" }}>{children}</main>
    </div>
  );
}
