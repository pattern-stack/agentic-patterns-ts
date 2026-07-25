import { Menu } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useBreakpoint } from "../../hooks/useMediaQuery";
import { ThemeToggle } from "../ThemeToggle";
import { MobileNavDrawer } from "./MobileNavDrawer";

// Exported so MobileNavDrawer can render the identical data — sidebar and
// drawer must provably never drift. This creates a benign module cycle
// (AppShell imports MobileNavDrawer for rendering; MobileNavDrawer imports
// this const): `navGroups` is a top-of-module const, initialized before
// either component's first render, and only read at render time.
export const navGroups: {
  heading: string;
  items: { to: string; label: string; end?: boolean }[];
}[] = [
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
      { to: "/run", label: "Live Run" },
      { to: "/claude-code", label: "Claude Code" },
      { to: "/conversations", label: "Conversations" },
    ],
  },
  {
    heading: "Evaluate",
    items: [
      { to: "/eval/sets", label: "Sets" },
      { to: "/eval", label: "Runs", end: true },
    ],
  },
];

/** Same persistence pattern as the theme picker (`ui/theme-mode.ts` `apdash-theme`). */
const NAV_COLLAPSED_KEY = "apdash-nav-collapsed";

function readCollapsedPref(): boolean {
  try {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsedPref(collapsed: boolean): void {
  try {
    localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* private mode / storage denied — the toggle still works for the session */
  }
}

export function AppShell({ children }: { children: ReactNode }) {
  // Collapsible nav: dense surfaces (Chat's trace rail, Live Run) want the
  // horizontal room. Collapsed = a slim strip with only the expand affordance;
  // the preference persists across sessions.
  const [collapsed, setCollapsed] = useState(readCollapsedPref);
  const toggle = () => {
    setCollapsed((prev) => {
      writeCollapsedPref(!prev);
      return !prev;
    });
  };

  const { isPhone, isNarrow } = useBreakpoint();
  const { pathname } = useLocation();

  // EPHEMERAL. Never persisted — a rotated tablet must not write a collapsed
  // desktop pref. NEVER touch NAV_COLLAPSED_KEY from the drawer path.
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close on route change (drawer nav click → navigate → close).
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the intentional trigger, not read in the body — the effect must re-run on every navigation.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);
  // Close if the viewport widens past md while open (drawer branch unmounts;
  // without this, re-narrowing would surprise-reopen it).
  useEffect(() => {
    if (!isNarrow) setDrawerOpen(false);
  }, [isNarrow]);

  const padY = isPhone ? 12 : 24; // --shell-pad-y
  const padX = isPhone ? 16 : 24; // phone: 16px horizontal
  const mainStyle = {
    flex: 1,
    padding: `${padY}px ${padX}px`,
    overflow: "auto",
    "--shell-pad-y": `${padY}px`,
    "--appbar-h": isNarrow ? "48px" : "0px",
  } as CSSProperties; // cast: custom props aren't in CSSProperties

  if (isNarrow) {
    return (
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <header
          style={{
            position: "sticky",
            top: 0,
            zIndex: 20, // above page content, below drawer (1000)
            height: 48,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 12px",
            background: "var(--fill)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            style={{
              appearance: "none",
              width: 32,
              height: 32,
              border: "none",
              background: "transparent",
              color: "var(--ink-2)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Menu size={18} />
          </button>
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: "var(--ink)",
              letterSpacing: "-0.01em",
            }}
          >
            Agentic Patterns
          </span>
          <div style={{ marginLeft: "auto" }}>
            <ThemeToggle />
          </div>
        </header>
        <MobileNavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
        <main style={mainStyle}>{children}</main>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav
        style={{
          width: collapsed ? 36 : 220,
          display: "flex",
          flexDirection: "column",
          background: "var(--fill)",
          borderRight: "1px solid var(--border)",
          padding: "20px 0",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: collapsed ? "center" : "space-between",
            padding: collapsed ? "0 0 24px" : "0 12px 24px 20px",
          }}
        >
          {!collapsed && (
            <span
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: "var(--ink)",
                letterSpacing: "-0.01em",
              }}
            >
              Agentic Patterns
            </span>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            title={collapsed ? "Expand navigation" : "Collapse navigation"}
            style={{
              appearance: "none",
              width: 22,
              height: 22,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--paper)",
              color: "var(--ink-3)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            {collapsed ? "›" : "‹"}
          </button>
        </div>
        {!collapsed && (
          <>
            {navGroups.map((group) => (
              <div key={group.heading} style={{ marginBottom: 12 }}>
                <div
                  style={{
                    padding: "4px 20px",
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "var(--ink-3)",
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
                      color: isActive ? "var(--ink)" : "var(--ink-2)",
                      background: isActive ? "var(--fill-2)" : "transparent",
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
          </>
        )}
      </nav>
      <main style={mainStyle}>{children}</main>
    </div>
  );
}
