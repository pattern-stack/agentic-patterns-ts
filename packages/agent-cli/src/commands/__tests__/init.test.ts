import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInitCommand } from "../init.js";

describe("runInitCommand --with-plugin", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-init-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("drops .claude-plugin/, hooks/, AND .claude/settings.json", async () => {
    await runInitCommand({
      targetDir: tmp,
      withPlugin: true,
      provider: "anthropic",
    });

    expect(fs.existsSync(path.join(tmp, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "hooks", "hooks.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "hooks", "emit.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, ".claude", "settings.json"))).toBe(true);
  });

  it("settings.json mirrors hooks.json with ${CLAUDE_PROJECT_DIR} substitution", async () => {
    await runInitCommand({
      targetDir: tmp,
      withPlugin: true,
      provider: "anthropic",
    });

    const settingsRaw = fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8");
    const settings = JSON.parse(settingsRaw) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    // All events present (same count as hooks.json)
    const hooksRaw = fs.readFileSync(path.join(tmp, "hooks", "hooks.json"), "utf8");
    const hooksSrc = JSON.parse(hooksRaw) as typeof settings;
    expect(Object.keys(settings.hooks).length).toBe(Object.keys(hooksSrc.hooks).length);
    expect(Object.keys(settings.hooks).length).toBeGreaterThanOrEqual(20);

    // No ${CLAUDE_PLUGIN_ROOT} leaked; every command uses ${CLAUDE_PROJECT_DIR}
    expect(settingsRaw).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    for (const event of Object.keys(settings.hooks)) {
      for (const matcher of settings.hooks[event] ?? []) {
        for (const h of matcher.hooks) {
          expect(h.command).toContain("${CLAUDE_PROJECT_DIR}/hooks/emit.mjs");
        }
      }
    }
  });

  it("does not create .claude/settings.json when --with-plugin is not set", async () => {
    await runInitCommand({
      targetDir: tmp,
      provider: "anthropic",
    });

    expect(fs.existsSync(path.join(tmp, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".claude-plugin"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "hooks"))).toBe(false);
  });

  it("merges hooks into an existing .claude/settings.json without clobbering user keys", async () => {
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    const preExisting = {
      permissions: { allow: ["Bash(ls *)"] },
      model: "opus",
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "echo user-custom-hook" },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(
      path.join(tmp, ".claude", "settings.json"),
      JSON.stringify(preExisting, null, 2),
    );

    await runInitCommand({
      targetDir: tmp,
      withPlugin: true,
      provider: "anthropic",
    });

    const merged = JSON.parse(
      fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"),
    ) as typeof preExisting & {
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
      >;
    };

    // User keys preserved
    expect(merged.permissions).toEqual({ allow: ["Bash(ls *)"] });
    expect(merged.model).toBe("opus");

    // User's original UserPromptSubmit hook still there
    const ups = merged.hooks.UserPromptSubmit ?? [];
    const allUpsCommands = ups.flatMap((m) => m.hooks.map((h) => h.command));
    expect(allUpsCommands).toContain("echo user-custom-hook");

    // Our emit.mjs hook added alongside it
    expect(
      allUpsCommands.some((c) => c.includes("${CLAUDE_PROJECT_DIR}/hooks/emit.mjs UserPromptSubmit")),
    ).toBe(true);

    // Events the user didn't touch are present too (e.g. SessionStart)
    expect(merged.hooks.SessionStart).toBeDefined();
  });

  it("is idempotent — re-running --with-plugin does not duplicate hook entries", async () => {
    await runInitCommand({ targetDir: tmp, withPlugin: true, provider: "anthropic" });
    const first = fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8");

    // Clear the conflict files the preflight checks but keep .claude/
    fs.rmSync(path.join(tmp, "package.json"));
    fs.rmSync(path.join(tmp, "agents"), { recursive: true });
    fs.rmSync(path.join(tmp, "tsconfig.json"));

    await runInitCommand({ targetDir: tmp, withPlugin: true, provider: "anthropic" });
    const second = fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8");

    expect(second).toBe(first);
  });
});
