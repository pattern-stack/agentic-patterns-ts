/**
 * Config + native-tools seams for the Claude-Code-loop runners.
 *
 * `ClaudeCodeRunner` (and its presets) vary along two ORTHOGONAL axes:
 *
 *   - Config source — where Claude Code reads its settings / connectors /
 *     plugins / skills / hooks from:
 *       • "host"     → inherit the developer's ~/.claude (whatever's there)
 *       • "isolated" → a fresh CLAUDE_CONFIG_DIR, optionally seeded from a
 *         curated `profile` directory. Empty = API-like (nothing loaded);
 *         seeded = a reproducible CC setup immune to host junk.
 *
 *   - Native tools — which of Claude Code's built-ins (Read/Bash/Edit/…)
 *     the agent may use: "all" | "none" | an explicit allow-list.
 *
 * The combinations:
 *   host     + all   → today's ClaudeCodeRunner (full host env)
 *   isolated + none  → today's ClaudeCodeAPIRunner (stripped, API-like)
 *   isolated + all   → a reproducible CC coding agent (the new cell)
 *
 * Auth: redirecting CLAUDE_CONFIG_DIR breaks the binary's own path-bound
 * Keychain lookup, so isolated runs must inject CLAUDE_CODE_OAUTH_TOKEN.
 * The token is resolved from (1) an explicit source, (2) the
 * CLAUDE_CODE_OAUTH_TOKEN env var, (3) the macOS Keychain — so isolated
 * mode is usable off macOS by passing a token explicitly.
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Axis types
// ---------------------------------------------------------------------------

/** Where Claude Code reads its settings/connectors/plugins/skills from. */
export type CCConfigSource =
  | { readonly mode: "host" }
  | { readonly mode: "isolated"; readonly profile?: string };

/** Which Claude-Code-native tools the agent may use. */
export type NativeToolsSetting = "all" | "none" | readonly string[];

/**
 * Explicit OAuth token for isolated mode — a string, or a thunk returning
 * one (e.g. to read a secret store lazily). Lets isolated runs work off
 * macOS, where the Keychain lookup is unavailable.
 */
export type OAuthTokenSource = string | (() => string | undefined);

// `tools` is accepted at runtime but absent from the SDK's typed Options.
type SDKOptionsWithTools = SDKOptions & { tools?: string[] };

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
}

/**
 * Read the Max-subscription OAuth token from the macOS Keychain. Returns
 * null when unavailable (non-macOS, not logged in, …) — callers fall back
 * to letting the CC binary do its own auth lookup.
 */
export function loadMaxSubOAuth(): OAuthCredential | null {
  if (process.platform !== "darwin") return null;
  const user = process.env.USER;
  if (!user) return null;
  try {
    const raw = execSync(
      `security find-generic-password -a "${user}" -s "Claude Code-credentials" -w`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const parsed = JSON.parse(raw) as { claudeAiOauth?: OAuthCredential };
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return oauth;
  } catch {
    return null;
  }
}

/**
 * Resolve an OAuth token for an isolated run. Priority:
 *   1. explicit `source` (string or thunk)
 *   2. CLAUDE_CODE_OAUTH_TOKEN env var
 *   3. macOS Keychain (Max subscription)
 * Returns undefined when none is available.
 */
export function resolveOAuthToken(source?: OAuthTokenSource): string | undefined {
  if (typeof source === "function") {
    const t = source();
    if (t) return t;
  } else if (typeof source === "string" && source.length > 0) {
    return source;
  }
  const envTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envTok) return envTok;
  return loadMaxSubOAuth()?.accessToken ?? undefined;
}

// ---------------------------------------------------------------------------
// Config dir
// ---------------------------------------------------------------------------

/**
 * Create an isolated CLAUDE_CONFIG_DIR. When `profile` is given its
 * contents are copied in (a curated CC setup); otherwise the dir is empty
 * (nothing loaded — API-like).
 */
export function createIsolatedConfigDir(profile?: string): string {
  // Validate before creating the tmpdir so the throw path leaks nothing.
  if (profile !== undefined && !existsSync(profile)) {
    throw new Error(`ClaudeCodeRunner: config profile directory not found: ${profile}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "ap-cc-cfg-"));
  if (profile !== undefined) {
    cpSync(profile, dir, { recursive: true });
  }
  return dir;
}

/**
 * Remove an isolated config dir created by `createIsolatedConfigDir`.
 * Best-effort and idempotent — a missing dir is not an error (the OS would
 * reclaim the tmpdir anyway).
 */
export function removeIsolatedConfigDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Apply seams to SDK options
// ---------------------------------------------------------------------------

/**
 * Apply the native-tools axis. "all" leaves the SDK default untouched
 * (every built-in available); "none" sets `tools: []`; a list pins the
 * available built-ins to exactly that set.
 */
export function applyNativeTools(sdkOpts: SDKOptions, setting: NativeToolsSetting): void {
  if (setting === "all") return;
  (sdkOpts as SDKOptionsWithTools).tools = setting === "none" ? [] : [...setting];
}

/**
 * Apply isolated-config env: redirect CLAUDE_CONFIG_DIR and inject the
 * OAuth token, layered over the current process env so the subprocess
 * inherits everything else.
 */
export function applyIsolatedEnv(sdkOpts: SDKOptions, isolatedDir: string, token: string): void {
  const baseEnv: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === "string") as [string, string][],
  );
  sdkOpts.env = {
    ...baseEnv,
    ...(sdkOpts.env ?? {}),
    CLAUDE_CONFIG_DIR: isolatedDir,
    CLAUDE_CODE_OAUTH_TOKEN: token,
  };
}
