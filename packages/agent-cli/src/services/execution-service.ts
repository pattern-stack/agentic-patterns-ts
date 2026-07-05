/**
 * ExecutionService — the one place that turns "discovered agents + runner
 * options" into a live runner, with a CREDENTIAL PREFLIGHT in front of
 * `createRunner()`.
 *
 * Why it exists: `ap eval`, `ap run`, and `ap playground` each used to call
 * `createRunner()` inline. When no provider key (and no gateway) is set,
 * `createRunner` silently falls to `ClaudeCodeAPIRunner` — your local `claude`
 * CLI + subscription OAuth. That's a fine DEV affordance but a deploy trap: a
 * real deploy has no `claude` binary, no interactive login, and gets limited
 * telemetry. So this service makes that situation LOUD, and — in a TTY — offers
 * to fix it on the spot (set a provider key, or point at a Bifrost/OpenAI-
 * compatible gateway) by writing `.env` via the same machinery as `ap config`.
 *
 * It does NOT change each command's resolution POLICY: it forwards the exact
 * `CreateRunnerOptions` the caller passes (eval=tier, run=env-ladder,
 * playground=resolver/override) straight through to `createRunner`. The only
 * new behaviour is the preflight before that call.
 *
 * The credential model (`providers/index.ts` + `model-resolver.ts`): each
 * agent's DECLARED model (`getModel()`) names its provider via `inferProvider`
 * (`claude-*`→anthropic, `gpt-*`→openai, …); that provider authenticates from
 * its own env var(s). Setting `AP_GATEWAY_BASE_URL` instead routes every model
 * through one gateway (`createRunner`'s `envGateway()`), so no per-provider key
 * is needed.
 */

import path from "node:path";
import {
  type CreateRunnerOptions,
  PROVIDERS,
  PROVIDER_PRIORITY,
  type RunnerSelection,
  type SupportedProvider,
  createRunner,
  inferProvider,
} from "@agentic-patterns/runtime";
import { isCancel, password, select, text } from "@clack/prompts";
import { upsertEnvFile } from "../commands/config.js";
import type { DiscoveredAgent } from "../helpers/discover.js";

// ---------------------------------------------------------------------------
// Credential report
// ---------------------------------------------------------------------------

/** A provider implied by one or more agents' declared models. */
export interface ProviderNeed {
  readonly provider: SupportedProvider;
  /** Env var(s) that satisfy this provider (first match wins). */
  readonly envVars: readonly string[];
  /** Whether at least one of `envVars` is set in the environment. */
  readonly present: boolean;
  /** Ids of the discovered agents whose declared model maps to this provider. */
  readonly agentIds: readonly string[];
}

export interface CredentialReport {
  /** `AP_GATEWAY_BASE_URL` if set — routes every declared model through one gateway. */
  readonly gatewayBaseUrl?: string;
  /** Distinct providers implied by the discovered agents' declared models. */
  readonly providers: readonly ProviderNeed[];
  /** Agents whose declared model didn't classify to a known provider (needs a profile/gateway). */
  readonly unclassified: readonly { readonly agentId: string; readonly model: string }[];
  /**
   * Whether ANY real credential is present — a gateway URL, or any provider key
   * at all. When false, `createRunner` would fall back to the Claude subscription
   * (or throw). This is the trigger for the loud signal.
   */
  readonly hasCredential: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ExecutionServiceOptions {
  /** Project root where `.env` lives — target of the interactive "set a key" flow. */
  readonly configRoot: string;
  /**
   * Allow the interactive clack resolution flow. Defaults to "both stdio are
   * TTYs, and neither `AP_NO_PROMPT` nor `CI` is set". Non-interactive callers
   * still get the loud signal, then proceed (for now — no hard block).
   */
  readonly interactive?: boolean;
  /** Where the loud signal is written. Default: `process.stderr`. */
  readonly out?: NodeJS.WritableStream;
}

export class ExecutionService {
  private readonly configRoot: string;
  private readonly interactive: boolean;
  private readonly out: NodeJS.WritableStream;

  constructor(opts: ExecutionServiceOptions) {
    this.configRoot = opts.configRoot;
    this.interactive = opts.interactive ?? defaultInteractive();
    this.out = opts.out ?? process.stderr;
  }

  /**
   * Preflight credentials, then resolve a runner via `createRunner(runnerOpts)`.
   * `runnerOpts` is forwarded verbatim — the service adds only the preflight.
   */
  async resolveRunner(
    runnerOpts: CreateRunnerOptions,
    agents: readonly DiscoveredAgent[],
  ): Promise<RunnerSelection> {
    await this.preflight(agents);
    return createRunner(runnerOpts);
  }

  /** Compute the credential situation for a set of discovered agents. Pure. */
  inspect(agents: readonly DiscoveredAgent[]): CredentialReport {
    const env = process.env;
    const gatewayBaseUrl = env.AP_GATEWAY_BASE_URL || undefined;

    const byProvider = new Map<SupportedProvider, string[]>();
    const unclassified: { agentId: string; model: string }[] = [];
    for (const a of agents) {
      const model = declaredModel(a);
      if (!model) continue;
      const provider = inferProvider(model);
      if (!provider) {
        unclassified.push({ agentId: a.id, model });
        continue;
      }
      const ids = byProvider.get(provider) ?? [];
      ids.push(a.id);
      byProvider.set(provider, ids);
    }

    const providers: ProviderNeed[] = [...byProvider.entries()].map(([provider, agentIds]) => {
      const envVars = PROVIDERS[provider].envVars;
      return { provider, envVars, present: envVars.some((v) => Boolean(env[v])), agentIds };
    });

    // A real credential is a gateway OR any provider key at all (even for a
    // provider no agent declared — the env-ladder could still use it).
    const anyProviderKey = PROVIDER_PRIORITY.some((p) =>
      PROVIDERS[p].envVars.some((v) => Boolean(env[v])),
    );

    return {
      gatewayBaseUrl,
      providers,
      unclassified,
      hasCredential: Boolean(gatewayBaseUrl) || anyProviderKey,
    };
  }

  // -------------------------------------------------------------------------
  // Preflight
  // -------------------------------------------------------------------------

  private async preflight(agents: readonly DiscoveredAgent[]): Promise<void> {
    const report = this.inspect(agents);
    if (report.hasCredential) return; // credential present — proceed quietly.

    this.signal(report);
    if (!this.interactive) return; // non-TTY / CI: warned, continue (falls to subscription).
    await this.resolveInteractively(agents);
  }

  /** Loud, framed warning that we're about to fall back to the CC subscription. */
  private signal(report: CredentialReport): void {
    const declared =
      report.providers.length > 0
        ? report.providers.map((p) => `${p.provider} (${p.agentIds.join(", ")})`).join("  ·  ")
        : "(none classified)";
    const lines = [
      "",
      `  ${YELLOW}⚠  No LLM provider credential found.${RESET}`,
      `     AP will fall back to your Claude Code subscription (${BOLD}ClaudeCodeAPIRunner${RESET}${DIM}):`,
      `     dev-only — real deploys have no \`claude\` CLI and get limited telemetry.${RESET}`,
      "",
      `     ${DIM}agents declare:${RESET} ${declared}`,
      report.unclassified.length > 0
        ? `     ${DIM}unclassified models (need a gateway/profile):${RESET} ${report.unclassified
            .map((u) => `${u.model} (${u.agentId})`)
            .join(", ")}`
        : "",
      `     ${DIM}fix: set a provider key, or point at a gateway — or \`ap config set\`.${RESET}`,
      "",
    ].filter((l) => l !== "");
    this.out.write(`${lines.join("\n")}\n`);
  }

  // -------------------------------------------------------------------------
  // Interactive resolution (writes .env via ap config's upsertEnvFile)
  // -------------------------------------------------------------------------

  private async resolveInteractively(agents: readonly DiscoveredAgent[]): Promise<void> {
    for (;;) {
      const choice = await select({
        message: "How do you want to provide credentials?",
        options: [
          { value: "anthropic", label: "Anthropic API key", hint: "ANTHROPIC_API_KEY" },
          { value: "openai", label: "OpenAI API key", hint: "OPENAI_API_KEY" },
          {
            value: "gateway",
            label: "Gateway (Bifrost / OpenAI-compatible)",
            hint: "AP_GATEWAY_*",
          },
          {
            value: "subscription",
            label: "Continue on Claude subscription",
            hint: "dev only — not for deploys",
          },
          { value: "quit", label: "Quit" },
        ],
      });

      if (isCancel(choice) || choice === "quit") {
        this.out.write(`\n${DIM}cancelled — no credential set${RESET}\n`);
        process.exit(1);
      }
      if (choice === "subscription") {
        this.out.write(`\n${DIM}continuing on the Claude subscription runner${RESET}\n`);
        return;
      }

      if (choice === "anthropic") await this.setSecret("ANTHROPIC_API_KEY", "Anthropic API key");
      else if (choice === "openai") await this.setSecret("OPENAI_API_KEY", "OpenAI API key");
      else if (choice === "gateway") await this.setGateway();

      const report = this.inspect(agents);
      if (report.hasCredential) {
        this.out.write(`\n  ${GREEN}✓${RESET} credential set — continuing.\n\n`);
        return;
      }
      // Still nothing (e.g. cancelled a sub-prompt) — loop and offer again.
    }
  }

  private async setSecret(key: string, label: string): Promise<void> {
    const value = await password({ message: `${label} (${key}):` });
    if (isCancel(value) || !value) return;
    upsertEnvFile(this.envPath(), key, String(value));
    this.out.write(`  ${GREEN}✓${RESET} wrote ${BOLD}${key}${RESET} to .env\n`);
  }

  private async setGateway(): Promise<void> {
    const baseURL = await text({
      message: "Gateway base URL (e.g. https://bifrost.internal/v1):",
      placeholder: process.env.AP_GATEWAY_BASE_URL ?? "",
    });
    if (isCancel(baseURL) || !baseURL) return;
    upsertEnvFile(this.envPath(), "AP_GATEWAY_BASE_URL", String(baseURL));

    const auth = await select({
      message: "Gateway auth:",
      options: [
        { value: "basic", label: "HTTP Basic (user + password)", hint: "Bifrost default" },
        { value: "bearer", label: "Bearer token" },
        { value: "none", label: "None" },
      ],
    });
    if (isCancel(auth)) return;

    if (auth === "basic") {
      const user = await text({ message: "Basic auth user (AP_GATEWAY_BASIC_USER):" });
      if (!isCancel(user) && user) {
        upsertEnvFile(this.envPath(), "AP_GATEWAY_BASIC_USER", String(user));
      }
      const pass = await password({ message: "Basic auth password (AP_GATEWAY_BASIC_PASS):" });
      if (!isCancel(pass) && pass) {
        upsertEnvFile(this.envPath(), "AP_GATEWAY_BASIC_PASS", String(pass));
      }
    } else if (auth === "bearer") {
      const key = await password({ message: "Bearer key (AP_GATEWAY_API_KEY):" });
      if (!isCancel(key) && key) {
        upsertEnvFile(this.envPath(), "AP_GATEWAY_API_KEY", String(key));
      }
    }

    const prefix = await text({
      message: "Model prefix, optional (AP_GATEWAY_MODEL_PREFIX, e.g. anthropic/):",
      placeholder: process.env.AP_GATEWAY_MODEL_PREFIX ?? "",
    });
    if (!isCancel(prefix) && prefix) {
      upsertEnvFile(this.envPath(), "AP_GATEWAY_MODEL_PREFIX", String(prefix));
    }

    this.out.write(`  ${GREEN}✓${RESET} wrote gateway config to .env\n`);
  }

  private envPath(): string {
    return path.join(this.configRoot, ".env");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Discovered agents are `any`-typed; read `getModel()` defensively (Node targets lack it). */
function declaredModel(a: DiscoveredAgent): string | undefined {
  const ag = a.agent as { getModel?: () => string } | undefined;
  return typeof ag?.getModel === "function" ? ag.getModel() : undefined;
}

function defaultInteractive(): boolean {
  return (
    Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
    !process.env.AP_NO_PROMPT &&
    process.env.CI !== "true"
  );
}

// ANSI (no chalk dep — same convention as the command modules).
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
