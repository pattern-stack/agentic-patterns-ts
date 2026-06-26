/**
 * Cockpit reskin atoms — small themed primitives on the swe-brain token layer
 * (theme.css + T). Deliberately lightweight: Badge, Tabs, Card, Button, Field
 * controls, Mono. Enough to re-house the cockpit views without pulling the full
 * swe-brain atom library.
 */
import type { CSSProperties, ReactNode } from 'react';
import { T } from './tokens';

export type Tone = 'ok' | 'err' | 'warn' | 'accent' | 'mute' | 'run';
const TONE_BG: Record<Tone, string> = {
  ok: 'var(--ok-soft)',
  err: 'var(--err-soft)',
  warn: 'var(--warn-soft)',
  accent: 'var(--accent-soft)',
  mute: 'var(--fill)',
  run: 'color-mix(in oklch, hsl(var(--accent)) 18%, var(--card))',
};
const TONE_INK: Record<Tone, string> = {
  ok: 'var(--ok-ink)',
  err: 'var(--err-ink)',
  warn: 'var(--warn-ink)',
  accent: 'var(--accent-ink)',
  mute: 'var(--ink-2)',
  run: 'var(--accent-ink)',
};

export function Badge({ tone = 'mute', mono, children, title }: { tone?: Tone; mono?: boolean; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: T.radius.pill,
        fontSize: T.fz.tiny,
        fontWeight: 600,
        background: TONE_BG[tone],
        color: TONE_INK[tone],
        fontFamily: mono ? T.font.mono : T.font.sans,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--paper)',
        border: '1px solid var(--line)',
        borderRadius: T.radius.lg,
        padding: '16px 18px',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const styles: Record<string, CSSProperties> = {
    // Soft accent CTA — tinted fill + accent ink, cohesive with the chips /
    // active tabs / rail toggles rather than a heavy solid-blue + white block.
    primary: { background: 'var(--accent-soft)', color: 'var(--accent-ink)', border: '1px solid color-mix(in oklch, hsl(var(--accent)) 30%, var(--line))' },
    default: { background: 'var(--fill)', color: 'var(--ink)', border: '1px solid var(--line)' },
    ghost: { background: 'transparent', color: 'var(--ink-2)', border: '1px solid var(--line)' },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles[variant],
        borderRadius: T.radius.md,
        padding: '8px 16px',
        fontFamily: 'inherit',
        fontWeight: 600,
        fontSize: T.fz.md,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function Tabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: Array<{ key: string; label: string; n?: number | null }>;
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', marginBottom: 18, flexWrap: 'wrap' }}>
      {tabs.map((t) => {
        const sel = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onSelect(t.key)}
            style={{
              padding: '8px 14px',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              borderBottom: '2px solid ' + (sel ? 'hsl(var(--accent))' : 'transparent'),
              color: sel ? 'var(--ink)' : 'var(--mute)',
              fontSize: T.fz.md,
              fontWeight: sel ? 600 : 500,
              fontFamily: 'inherit',
            }}
          >
            {t.label}
            {t.n != null && <span style={{ color: 'var(--mute)', marginLeft: 5 }}>{t.n}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 150 }}>
      <span style={{ fontSize: T.fz.micro, color: 'var(--mute)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

const controlStyle: CSSProperties = {
  background: 'var(--fill)',
  border: '1px solid var(--line)',
  color: 'var(--ink)',
  borderRadius: T.radius.sm,
  padding: '7px 9px',
  fontFamily: 'inherit',
  fontSize: T.fz.md,
};
export const inputStyle = controlStyle;

export function Mono({ children, color }: { children: ReactNode; color?: string }) {
  return <span style={{ fontFamily: T.font.mono, fontSize: T.fz.tiny, color: color ?? 'var(--ink-2)' }}>{children}</span>;
}

export const short = (id: string | undefined): string => (id || '').slice(0, 8);
