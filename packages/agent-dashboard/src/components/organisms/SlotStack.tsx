import type { ReactNode } from "react";
import type { CapabilityBlock, ProvenanceChip as ProvChip, Slot } from "../../api/composition";
import { Card } from "../atoms/Card";
import { Chip, ProvenanceChip } from "../atoms/Chip";

/**
 * The slot stack — an agent/role's composition rendered as labeled cards, each
 * tagged with its provenance chip. This is the cure for the dump-file failure
 * mode (docs §1): every slot the identity carries, with its origin, in one place.
 */

function SlotCard({
  kind,
  name,
  text,
  provenance,
  footer,
}: {
  kind: string;
  name?: string;
  text: string;
  provenance?: ProvChip;
  footer?: ReactNode;
}) {
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: text ? 8 : 0 }}>
        <span
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--ink-3)",
            fontWeight: 600,
          }}
        >
          {kind}
        </span>
        {name && <span style={{ fontWeight: 600, color: "var(--ink)", fontSize: 14 }}>{name}</span>}
        {provenance && (
          <span style={{ marginLeft: "auto" }}>
            <ProvenanceChip tier={provenance.tier} sourcePath={provenance.sourcePath} />
          </span>
        )}
      </div>
      {text && (
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.55,
            color: "var(--ink-2)",
            whiteSpace: "pre-wrap",
            fontFamily: "var(--font-sans)",
          }}
        >
          {text}
        </div>
      )}
      {footer}
    </Card>
  );
}

export function SlotStack({
  persona,
  judgments,
  responsibilities,
  capabilities,
}: {
  persona: Slot;
  judgments: Slot[];
  responsibilities: Slot[];
  capabilities: CapabilityBlock[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SlotCard kind="Persona" text={persona.text} provenance={persona.provenance} />
      {judgments.map((j, i) => (
        <SlotCard
          key={`j-${j.name}-${i}`}
          kind="Judgment"
          name={j.name}
          text={j.text}
          provenance={j.provenance}
        />
      ))}
      {responsibilities.map((r, i) => (
        <SlotCard
          key={`r-${r.name}-${i}`}
          kind="Responsibility"
          name={r.name}
          text={r.text}
          provenance={r.provenance}
        />
      ))}
      {capabilities.map((c, i) => (
        <SlotCard
          key={`c-${c.name}-${i}`}
          kind="Capability"
          name={c.name}
          text={c.description}
          provenance={c.provenance}
          footer={
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
              <Chip tone="mono">{c.toolbox.name || "toolbox"}</Chip>
              {c.toolbox.tools.map((t) => (
                <Chip key={t.name} tone="neutral" title={t.description}>
                  {t.name}
                </Chip>
              ))}
              {c.manual && <Chip tone="neutral">manual</Chip>}
              {c.playbook && c.playbook.plays.length > 0 && (
                <Chip tone="neutral">{c.playbook.plays.length} plays</Chip>
              )}
            </div>
          }
        />
      ))}
    </div>
  );
}
