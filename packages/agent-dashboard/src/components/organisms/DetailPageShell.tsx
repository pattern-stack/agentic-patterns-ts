import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";

export interface Crumb {
  label: string;
  to?: string;
}

/**
 * Shared detail-page frame for the BUILD doors: a breadcrumb trail, an optional
 * center subtitle + right-aligned actions, and a max-width content column.
 */
export function DetailPageShell({
  breadcrumb,
  center,
  actions,
  maxWidth = 960,
  children,
}: {
  breadcrumb: Crumb[];
  center?: ReactNode;
  actions?: ReactNode;
  maxWidth?: number;
  children: ReactNode;
}) {
  return (
    <div style={{ maxWidth, margin: "0 auto" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 20,
          minHeight: 28,
        }}
      >
        <nav style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, minWidth: 0 }}>
          {breadcrumb.map((c, i) => {
            const last = i === breadcrumb.length - 1;
            return (
              <span key={`${c.label}-${i}`} style={{ display: "inline-flex", gap: 6 }}>
                {c.to && !last ? (
                  <Link to={c.to} style={{ color: "var(--fg-muted)", textDecoration: "none" }}>
                    {c.label}
                  </Link>
                ) : (
                  <span
                    style={{
                      color: last ? "var(--fg-default)" : "var(--fg-muted)",
                      fontWeight: last ? 600 : 400,
                    }}
                  >
                    {c.label}
                  </span>
                )}
                {!last && <span style={{ color: "var(--fg-subtle)" }}>/</span>}
              </span>
            );
          })}
        </nav>
        {center && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "var(--fg-muted)",
              fontSize: 13,
            }}
          >
            {center}
          </div>
        )}
        {actions && <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>{actions}</div>}
      </header>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>
    </div>
  );
}

/** A labeled uppercase micro-heading + body — the recurring "field" primitive. */
export function Labeled({
  label,
  children,
  style,
}: {
  label: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={style}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--fg-subtle)",
          fontWeight: 600,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
