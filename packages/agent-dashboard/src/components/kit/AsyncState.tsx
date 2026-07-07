/**
 * AsyncState — the shared page kit's fetch-state renderer (port-map §7.2).
 * Every eval page (and several others) hand-rolled the same five blocks:
 * a centered spinner, an "unconfigured" card (the `AP_PERSISTENCE != 0` copy),
 * a "not found" card, an error card (AlertIcon + message), and an empty-state
 * card. This is that JSX, parameterized — callers keep their own `LoadState`
 * discriminated union and just forward `state.kind` (+ the one field each
 * non-"ok" kind needs) here instead of re-rendering the five blocks by hand.
 *
 * Usage:
 *   if (state.kind !== "ok") {
 *     return <AsyncState kind={state.kind} loading="Loading eval runs…"
 *       error={state.kind === "error" ? { message: state.message } : undefined} />;
 *   }
 */
import type { ReactNode } from "react";
import { T } from "../../ui/tokens";
import { Card } from "../atoms/Card";
import { Spinner } from "../atoms/Spinner";
import { AlertIcon } from "../atoms/icons";

export type AsyncStateKind = "loading" | "unconfigured" | "not-found" | "error" | "empty";

export interface AsyncStateProps {
  kind: AsyncStateKind;
  /** Loading spinner caption, e.g. "Loading eval runs…". */
  loading?: string;
  unconfigured?: { title?: string; body?: ReactNode };
  notFound?: { title?: string; body?: ReactNode };
  error?: { title?: string; message: string };
  empty?: { title?: string; body?: ReactNode };
}

// Every current adopter of the "unconfigured" state is an eval page (the
// `AP_PERSISTENCE != 0` gate is eval-store-backed today); this default saves
// re-specifying the same copy at every eval call site. Future non-eval
// consumers (runs/conversations persistence, S5-S7) pass their own
// `unconfigured` title + body — the default is just that, a default.
const DEFAULT_UNCONFIGURED_TITLE = "Eval persistence is not configured";
const DEFAULT_UNCONFIGURED_BODY = (
  <>
    Start <code>ap playground</code> with <code>AP_PERSISTENCE != 0</code> to enable eval queries.
  </>
);

function CenteredCard({ title, body }: { title: ReactNode; body?: ReactNode }) {
  return (
    <Card style={{ textAlign: "center", padding: 40, color: "var(--mute)" }}>
      <div style={{ fontWeight: 600, color: "var(--ink)", marginBottom: 6 }}>{title}</div>
      {body && <div style={{ fontSize: T.fz.md }}>{body}</div>}
    </Card>
  );
}

export function AsyncState({
  kind,
  loading,
  unconfigured,
  notFound,
  error,
  empty,
}: AsyncStateProps) {
  if (kind === "loading") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          padding: "48px 0",
          color: "var(--mute)",
        }}
      >
        <Spinner />
        <span>{loading ?? "Loading…"}</span>
      </div>
    );
  }

  if (kind === "unconfigured") {
    return (
      <CenteredCard
        title={unconfigured?.title ?? DEFAULT_UNCONFIGURED_TITLE}
        body={unconfigured?.body ?? DEFAULT_UNCONFIGURED_BODY}
      />
    );
  }

  if (kind === "not-found") {
    return <CenteredCard title={notFound?.title ?? "Not found"} body={notFound?.body} />;
  }

  if (kind === "error") {
    return (
      <Card
        style={{ borderColor: "var(--err)", display: "flex", alignItems: "flex-start", gap: 12 }}
      >
        <span style={{ color: "var(--err)", display: "inline-flex", flexShrink: 0 }}>
          <AlertIcon size={18} />
        </span>
        <div>
          <div style={{ fontWeight: 600, color: "var(--err)", marginBottom: 4 }}>
            {error?.title ?? "Failed to load"}
          </div>
          <div style={{ color: "var(--mute)", fontSize: T.fz.md }}>{error?.message}</div>
        </div>
      </Card>
    );
  }

  // empty
  return <CenteredCard title={empty?.title ?? "Nothing here yet"} body={empty?.body} />;
}
