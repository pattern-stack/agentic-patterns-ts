import { describe, expect, it } from "vitest";
import {
  type ManualItem,
  ManualSection,
  ManualToolbox,
  ScopedManual,
  SimpleManual,
  TextManual,
} from "../manual.js";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const vocabItems: ManualItem[] = [
  { key: "bug", name: "Bug", description: "A defect in the system" },
  { key: "feature", name: "Feature", description: "A new capability" },
];

const ruleItems: ManualItem[] = [{ key: "no_pii", name: "No PII", description: "Never log PII" }];

const vocabSection = new ManualSection("Vocabulary", "Domain terms", vocabItems);
const rulesSection = new ManualSection("Rules", "Constraints", ruleItems);

// ---------------------------------------------------------------------------
// ManualSection
// ---------------------------------------------------------------------------

describe("ManualSection", () => {
  it("renders toPrompt with default heading level", () => {
    const output = vocabSection.toPrompt();
    expect(output).toBe(
      [
        "## Vocabulary",
        "",
        "Domain terms",
        "",
        "- **Bug**: A defect in the system",
        "- **Feature**: A new capability",
      ].join("\n"),
    );
  });

  it("renders toPrompt with custom heading level", () => {
    const output = vocabSection.toPrompt(3);
    expect(output).toContain("### Vocabulary");
  });

  it("renders items without description", () => {
    const items: ManualItem[] = [{ name: "Alpha" }, { name: "Beta" }];
    const section = new ManualSection("Greek", "Letters", items);
    const output = section.toPrompt();
    expect(output).toContain("- **Alpha**");
    expect(output).not.toContain("- **Alpha**:");
  });

  it("get() returns item by key", () => {
    expect(vocabSection.get("bug")).toEqual(vocabItems[0]);
  });

  it("get() returns undefined for missing key", () => {
    expect(vocabSection.get("missing")).toBeUndefined();
  });

  it("keys() returns all keys", () => {
    expect(vocabSection.keys()).toEqual(["bug", "feature"]);
  });
});

// ---------------------------------------------------------------------------
// TextManual
// ---------------------------------------------------------------------------

describe("TextManual", () => {
  it("renders toPrompt as heading + content", () => {
    const manual = new TextManual("Guide", "Follow these steps.");
    expect(manual.toPrompt()).toBe("# Guide\n\nFollow these steps.");
  });

  it("uses content prefix as default description", () => {
    const manual = new TextManual("Guide", "Short content");
    expect(manual.description).toBe("Short content");
  });

  it("uses explicit description when provided", () => {
    const manual = new TextManual("Guide", "Content", "Custom desc");
    expect(manual.description).toBe("Custom desc");
  });
});

// ---------------------------------------------------------------------------
// SimpleManual
// ---------------------------------------------------------------------------

describe("SimpleManual", () => {
  const manual = new SimpleManual("Test Manual", "A test manual", [vocabSection, rulesSection]);

  it("returns all sections via getAllSections", () => {
    expect(manual.getAllSections()).toHaveLength(2);
  });

  it("renders toPrompt as concatenated sections", () => {
    const output = manual.toPrompt();
    expect(output).toContain("## Vocabulary");
    expect(output).toContain("## Rules");
  });
});

// ---------------------------------------------------------------------------
// ScopedManual
// ---------------------------------------------------------------------------

describe("ScopedManual", () => {
  const manual = new SimpleManual("Full Manual", "Complete reference", [
    vocabSection,
    rulesSection,
  ]);

  it("renders only included sections fully", () => {
    const scoped = manual.scoped(["Vocabulary"]);
    const output = scoped.toPrompt();

    expect(output).toContain("# Full Manual");
    expect(output).toContain("## Vocabulary");
    expect(output).toContain("- **Bug**: A defect in the system");
    // Rules should only appear in TOC
    expect(output).toContain("## Other Sections (available on request)");
    expect(output).toContain("- Rules");
  });

  it("delegates name and description from source", () => {
    const scoped = new ScopedManual(manual, ["Vocabulary"]);
    expect(scoped.name).toBe("Full Manual");
    expect(scoped.description).toBe("Complete reference");
  });

  it("omits 'Other Sections' when all sections included", () => {
    const scoped = manual.scoped(["Vocabulary", "Rules"]);
    const output = scoped.toPrompt();
    expect(output).not.toContain("Other Sections");
  });
});

// ---------------------------------------------------------------------------
// ManualToolbox
// ---------------------------------------------------------------------------

describe("ManualToolbox", () => {
  const manual = new SimpleManual("Test Manual", "A test", [vocabSection, rulesSection]);
  const toolbox = new ManualToolbox(manual);

  it("has correct name and description", () => {
    expect(toolbox.name).toBe("Test Manual Reference");
    expect(toolbox.description).toContain("Test Manual");
  });

  it("exposes readManualSection and listManualSections tools", () => {
    expect(toolbox.getToolNames()).toContain("readManualSection");
    expect(toolbox.getToolNames()).toContain("listManualSections");
  });

  it("readManualSection returns section content", async () => {
    const result = await toolbox.execute("readManualSection", {
      sectionName: "Vocabulary",
    });
    expect(result).toContain("## Vocabulary");
    expect(result).toContain("- **Bug**");
  });

  it("readManualSection returns error for unknown section", async () => {
    const result = await toolbox.execute("readManualSection", {
      sectionName: "Unknown",
    });
    expect(result).toContain("not found");
    expect(result).toContain("Vocabulary");
  });

  it("listManualSections returns section listing", async () => {
    const result = await toolbox.execute("listManualSections", {});
    expect(result).toContain("Test Manual");
    expect(result).toContain("Vocabulary");
    expect(result).toContain("Rules");
  });

  it("generates ToolSchemas", () => {
    const schemas = toolbox.getToolSchemas();
    expect(schemas).toHaveLength(2);
    expect(schemas.map((s) => s.name)).toContain("readManualSection");
  });
});
