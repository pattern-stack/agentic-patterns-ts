/**
 * PageHeader — the shared page kit's `<h1>` row (port-map §7.2). Replaces the
 * ~12 hand-rolled `<h1 style={{fontSize:20,...}}>` blocks (most paired with a
 * status badge and/or a right-aligned action row) with one component.
 */
import type { ReactNode } from "react";
import { T } from "../../ui/tokens";

export function PageHeader({
  title,
  badges,
  actions,
}: {
  title: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20 }}
    >
      <h1 style={{ fontSize: T.fz.xxl, fontWeight: 600, margin: 0 }}>{title}</h1>
      {badges}
      <div style={{ flex: 1 }} />
      {actions && <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{actions}</div>}
    </div>
  );
}
