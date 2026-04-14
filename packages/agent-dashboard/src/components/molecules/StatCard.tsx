/**
 * StatCard molecule — label + big value + optional subtitle.
 * Composes the Card atom for consistent surface styling.
 */

import { Card } from "../atoms/Card";

interface StatCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  color?: string;
}

export function StatCard({ label, value, subtitle, color = "var(--fg-default)" }: StatCardProps) {
  return (
    <Card>
      <div style={{ fontSize: 13, color: "var(--fg-muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 600, color }}>{value}</div>
      {subtitle && (
        <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 4 }}>{subtitle}</div>
      )}
    </Card>
  );
}
