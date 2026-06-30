import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runClaudeSkillCommand } from "../claude-skill.js";

const SKILL = "build-on-agentic-patterns";

describe("runClaudeSkillCommand", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-skill-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("installs the bundled skill into <targetDir>/.claude/skills (project-local)", async () => {
    await runClaudeSkillCommand({ targetDir: tmp });
    const skillFile = path.join(tmp, ".claude", "skills", SKILL, "SKILL.md");
    expect(fs.existsSync(skillFile)).toBe(true);
    expect(fs.readFileSync(skillFile, "utf8")).toContain("compositional algebra");
  });

  it("installs only the named skill", async () => {
    await runClaudeSkillCommand({ targetDir: tmp, name: SKILL });
    expect(fs.existsSync(path.join(tmp, ".claude", "skills", SKILL, "SKILL.md"))).toBe(true);
  });

  it("--global installs into ~/.claude/skills (os.homedir)", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
    await runClaudeSkillCommand({ global: true });
    expect(fs.existsSync(path.join(tmp, ".claude", "skills", SKILL, "SKILL.md"))).toBe(true);
  });

  it("rejects an unknown skill name without installing", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exit");
    }) as never);
    await expect(runClaudeSkillCommand({ targetDir: tmp, name: "does-not-exist" })).rejects.toThrow(
      "exit",
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.existsSync(path.join(tmp, ".claude"))).toBe(false);
  });

  it("re-running overwrites in place (idempotent upgrade)", async () => {
    await runClaudeSkillCommand({ targetDir: tmp });
    await runClaudeSkillCommand({ targetDir: tmp });
    expect(fs.existsSync(path.join(tmp, ".claude", "skills", SKILL, "SKILL.md"))).toBe(true);
  });
});
