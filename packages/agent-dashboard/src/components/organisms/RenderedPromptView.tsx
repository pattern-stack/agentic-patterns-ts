import type { CoherenceWarning, PromptSection } from "../../api/composition";
import { Card } from "../atoms/Card";
import { Chip } from "../atoms/Chip";

const SOURCE_TONE = { role: "accent", instance: "neutral", unknown: "warn" } as const;

/**
 * The delivered system prompt, per-section, with each section attributed to its
 * source — role (the reusable identity) vs instance (background/awareness/
 * mission). This is "the lens verifying delivery" (docs §3): you SEE which slot
 * a span of prompt came from. `unknown` marks the joined-fallback render path.
 */
export function RenderedPromptView({
  sections,
  renderPath,
}: {
  sections: PromptSection[];
  renderPath: "sections" | "joined";
}) {
  return (
    <Card padded={false}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)" }}>Delivered prompt</span>
        {renderPath === "joined" && (
          <Chip
            tone="warn"
            title="This core exposes only the joined prompt — per-section attribution unavailable."
          >
            joined fallback
          </Chip>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
          <Chip tone="accent">role</Chip>
          <Chip tone="neutral">instance</Chip>
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {sections.map((s, i) => (
          <section
            key={`${s.name}-${i}`}
            style={{
              padding: "12px 16px",
              borderBottom: i < sections.length - 1 ? "1px solid var(--line-2)" : "none",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Chip tone={SOURCE_TONE[s.source]}>{s.source}</Chip>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>{s.name}</span>
            </div>
            <pre
              style={{
                margin: 0,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.55,
                color: "var(--ink-2)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {s.text}
            </pre>
          </section>
        ))}
      </div>
    </Card>
  );
}

/** Coherence warnings (awareness ↔ capability drift) — a heuristic notice band. */
export function CoherenceNotice({ warnings }: { warnings: CoherenceWarning[] }) {
  if (warnings.length === 0) {
    return (
      <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
        No coherence warnings — awareness domains and capabilities line up.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {warnings.map((w, i) => (
        <div
          key={`${w.subject}-${i}`}
          style={{
            display: "flex",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 8,
            background: "var(--err-soft)",
            border: "1px solid var(--err)",
          }}
        >
          <Chip tone="warn">{w.kind === "domain-unreachable" ? "unreachable" : "undescribed"}</Chip>
          <div style={{ fontSize: 13, color: "var(--ink)" }}>
            <strong>{w.subject}</strong> — {w.detail}
          </div>
        </div>
      ))}
    </div>
  );
}
