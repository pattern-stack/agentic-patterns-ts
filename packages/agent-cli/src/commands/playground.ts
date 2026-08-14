/**
 * `ap playground` — start the full UI environment (Hono API + admin dashboard)
 * for a project's discovered agents.
 *
 * This command is the "one command to chat with my agents" UX: it wires the
 * standard observability stack (event bus + collector + admin service + SSE
 * exporter), picks a runner via `createRunner()` (env-driven), attaches that
 * runner to each `AgentRegistration`, mounts the pre-built dashboard as a
 * SPA at `/`, and opens the browser.
 *
 * The caller (`cli.ts`) is responsible for discovering agents from the user's
 * project and passing them in as `opts.agents`.
 */

import { execSync, spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import {
  AgentEventBus,
  EVAL_TRACE_PREFIX,
  InMemoryAdminService,
  InMemoryEventCollector,
  NodeBackedRunner,
  PendingInputRegistry,
  RunStoreExporter,
  SQLiteExporter,
  SSEExporter,
  createHumanInputApprovalGate,
  createToolboxExecutor,
  isPromotedAgent,
  loadConversationStore,
  setAgentEventBus,
} from "@pattern-stack/agentic-runtime";
import type { SQLiteConversationStore } from "@pattern-stack/agentic-runtime";
import { createServer } from "@pattern-stack/agentic-server";
import type { AgentRegistration } from "@pattern-stack/agentic-server";
import { DEFAULT_DASHBOARD_PORT } from "../constants.js";
import { ensureParentDir, resolveDbPath } from "../helpers/db.js";
import type { DiscoveredAgent } from "../helpers/discover.js";
import { readSelfVersion } from "../helpers/versions.js";
import { ExecutionService } from "../services/execution-service.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PlaygroundOptions {
  /** Agents discovered by the caller (without runners — playground attaches one). */
  agents: DiscoveredAgent[];
  /** Port for the HTTP server. Defaults to {@link DEFAULT_DASHBOARD_PORT}. */
  port?: number;
  /** Skip the dashboard — API only. */
  noDashboard?: boolean;
  /** Auto-open the dashboard URL in a browser. Defaults to true. */
  open?: boolean;
  /** Project root for `.env` (credential preflight). Defaults to cwd. */
  configRoot?: string;
}

/**
 * Start the playground: Hono server + dashboard + observability stack,
 * wired to the caller's pre-discovered agents.
 *
 * Resolves once the server is listening. Does not return; the Node process
 * stays alive holding the HTTP server until the user kills it.
 */
export async function runPlaygroundCommand(opts: PlaygroundOptions): Promise<void> {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const shouldOpen = opts.open !== false;
  const serveDashboard = opts.noDashboard !== true;

  // -------------------------------------------------------------------------
  // 1. Observability stack
  // -------------------------------------------------------------------------

  const eventBus = new AgentEventBus();
  // Make the process-global default THE server bus, so user-project runners/
  // conversations constructed without explicit bus threading (they default to
  // getAgentEventBus()) are visible to the collector/SSE/persistence.
  setAgentEventBus(eventBus);

  const collector = new InMemoryEventCollector();
  collector.attach(eventBus);

  const adminService = new InMemoryAdminService(collector);

  const sseExporter = new SSEExporter();
  sseExporter.attach(eventBus);

  // Human-in-the-loop: OPT-IN approval gating. `AP_APPROVAL_TOOLS` is a
  // comma-separated list of tool names that require a human's yes before they
  // run (e.g. `ratify_definition,retire_definition`). Empty/unset → no gate is
  // attached and behavior is unchanged. When set, the gate blocks each listed
  // tool call, the chat surfaces an inline approval prompt, and the human's
  // answer flows back through `POST /conversations/:id/input`.
  const inputRegistry = new PendingInputRegistry();
  const approvalTools = parseApprovalTools(process.env.AP_APPROVAL_TOOLS);
  if (approvalTools.size > 0) {
    eventBus.addGate(
      createHumanInputApprovalGate({
        bus: eventBus,
        registry: inputRegistry,
        tools: approvalTools,
        ...(parsePositiveInt(process.env.AP_APPROVAL_TIMEOUT_MS) !== undefined
          ? { timeoutMs: parsePositiveInt(process.env.AP_APPROVAL_TIMEOUT_MS) }
          : {}),
      }),
    );
  }

  // Durable event log (SQLite). Optional — degrades to memory-only when
  // better-sqlite3 isn't installed or AP_PERSISTENCE=0 is set.
  const persistence = await maybeAttachPersistence(eventBus);
  const store = persistence.store;

  // -------------------------------------------------------------------------
  // 2. Runner — default to each agent's DECLARED (coded) model
  // -------------------------------------------------------------------------

  // Default: resolver mode. `createRunner({ resolveAgentModel: true })` builds a
  // runner that dispatches each agent's `getModel()` at run time, so an agent
  // that declares `gemini-3.1-flash-lite` runs on GOOGLE — instead of forcing a
  // single env-detected model (previously `gpt-4o`) onto every agent. The
  // per-agent provider follows the declared model, and an agent that declares no
  // model falls back to its role's default (never a silent gpt-4o).
  //
  // AGENT_MODEL / AGENT_TIER remain a GLOBAL OVERRIDE: when either is set we bind
  // that one model for every agent via env auto-detection, where `createRunner`
  // now makes the provider follow the model (a classified id whose provider key
  // is absent fails loud rather than mismatching).
  const tier = (process.env.AGENT_TIER as "opus" | "sonnet" | "haiku" | undefined) ?? "sonnet";
  const hasGlobalOverride = Boolean(process.env.AGENT_MODEL || process.env.AGENT_TIER);
  const runnerOpts = hasGlobalOverride
    ? { eventBus, tier, verbose: false }
    : { eventBus, resolveAgentModel: true, verbose: false };
  const svc = new ExecutionService({ configRoot: opts.configRoot ?? process.cwd() });
  const selection = await svc.resolveRunner(runnerOpts, opts.agents);
  const { runner: llmRunner } = selection;

  // -------------------------------------------------------------------------
  // 3. Attach runner to each registration
  // -------------------------------------------------------------------------

  // A promoted registration (asAgent()) runs its node instead of LLM-looping;
  // the shared LLM runner still drives any nested AgentSteps as its inner runner.
  // Thread the shared bus so a promoted agent's `stream()` lifecycle
  // (message.start/.complete) is bus-visible too — otherwise RunStoreExporter
  // never sees it and `/admin/runs` stays empty for promoted-pipeline chats.
  const registrations: AgentRegistration[] = opts.agents.map((reg) =>
    toAgentRegistration(
      reg,
      isPromotedAgent(reg.agent) ? new NodeBackedRunner(llmRunner, eventBus) : llmRunner,
    ),
  );
  // Mark createToolboxExecutor as "imported for re-export discoverability" —
  // the conversation route already builds executors per request.
  void createToolboxExecutor;

  // -------------------------------------------------------------------------
  // 4. Build the Hono app with API routes FIRST
  // -------------------------------------------------------------------------

  // Docs surface: stamp the CLI's own version, and serve Scalar offline from the
  // vendored bundle when it's present (`build:scalar`), so `/docs` needs no CDN.
  const scalarAsset = resolveScalarAsset();
  const scalarOffline = scalarAsset != null && existsSync(scalarAsset);
  const cliVersion = readSelfVersion(path.dirname(fileURLToPath(import.meta.url)));

  const app = createServer({
    agents: registrations,
    adminService,
    eventBus,
    sseExporter,
    inputRegistry,
    store,
    eventStore: store,
    evalStore: store,
    runStore: store,
    evalExecution: {
      runner: llmRunner,
      model: process.env.AGENT_MODEL ?? tier,
      gitSha: readGitSha(),
    },
    docs: {
      title: "@agentic-patterns playground",
      ...(cliVersion ? { version: cliVersion } : {}),
      ...(scalarOffline ? { scalarJsUrl: "/docs/scalar.js" } : {}),
    },
  });

  // Serve the vendored Scalar bundle locally (registered BEFORE the dashboard
  // catch-all below). Absent → `docs` above never set `scalarJsUrl`, so the
  // server's HTML falls back to the CDN and `/docs` still works online.
  if (scalarOffline && scalarAsset) {
    app.get("/docs/scalar.js", () => streamFile(scalarAsset));
  }

  // -------------------------------------------------------------------------
  // 5. Mount the dashboard SPA (after API routes so API wins)
  // -------------------------------------------------------------------------

  const dashboardDir = resolveDashboardDir();
  let dashboardMounted = false;
  // The handler the HTTP server serves: the bare API app, or — when the SPA is
  // mounted — the API wrapped in the HTML-navigation shim (see the shim's doc).
  let handler: FetchLike = app;

  if (serveDashboard) {
    if (dashboardDir && existsSync(dashboardDir)) {
      mountDashboard(app, dashboardDir);
      handler = withHtmlNavigationShim(app, dashboardDir);
      dashboardMounted = true;
    } else {
      const where = dashboardDir ?? "<unresolved>";
      process.stderr.write(
        `[playground] warning: dashboard assets not found at ${where} — API-only mode.\n           run \`pnpm --filter @pattern-stack/agentic-cli build\` (or \`build:dashboard\`) to build the SPA bundle.\n`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 6. Start the HTTP server
  // -------------------------------------------------------------------------

  await new Promise<void>((resolve) => {
    serve({ fetch: handler.fetch as Parameters<typeof serve>[0]["fetch"], port }, () => {
      resolve();
    });
  });

  // -------------------------------------------------------------------------
  // 7. Banner
  // -------------------------------------------------------------------------

  const baseUrl = `http://localhost:${port}`;
  const agentList = registrations.map((a) => a.name).join(", ") || "(none)";
  const lines = [
    "",
    `  api        ${baseUrl}`,
    dashboardMounted ? `  dashboard  ${baseUrl}` : "  dashboard  (disabled)",
    `  agents     ${agentList}`,
    `  runner     ${selection.source} — ${selection.reason}`,
    `  storage    ${persistence.banner}`,
    ...(approvalTools.size > 0
      ? [`  approvals  human-gated: ${[...approvalTools].join(", ")}`]
      : []),
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  // -------------------------------------------------------------------------
  // 8. Open the browser
  // -------------------------------------------------------------------------

  if (shouldOpen && dashboardMounted) {
    openBrowser(baseUrl);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Map a discovered agent + its resolved runner to the server's
 * `AgentRegistration` shape — the ONLY bridge between CLI discovery and the
 * server (#308 gapcheck G7). An explicit field-by-field map, deliberately
 * NOT a spread: a `DiscoveredAgent` field that isn't listed here is silently
 * dropped and never reaches the server (a declared `scope`, notably, would
 * never be threaded into `POST /conversations` — the server would just see
 * `scope: undefined` with zero errors, since `AgentRegistration.scope` is
 * optional). Exported so a test can assert every known field survives the
 * trip, by identity — see `__tests__/playground.test.ts`.
 */
export function toAgentRegistration(
  reg: DiscoveredAgent,
  runner: AgentRegistration["runner"],
): AgentRegistration {
  return {
    id: reg.id,
    name: reg.name,
    description: reg.description,
    agent: reg.agent,
    file: reg.file,
    provenance: reg.provenance,
    instantiate: reg.instantiate,
    scope: reg.scope,
    instantiateDefaults: reg.instantiateDefaults,
    contextRedactKeys: reg.contextRedactKeys,
    evals: reg.evals,
    memory: reg.memory,
    runner,
  };
}

/**
 * Resolve the absolute path to the bundled dashboard assets.
 *
 * Layout after `pnpm --filter @pattern-stack/agentic-cli build`:
 *   packages/agent-cli/
 *     dist/cli.js               ← import.meta.url lands here
 *     assets/dashboard/         ← built SPA
 *
 * When running from source (tsx), the same `../assets/dashboard/` relative
 * layout holds if `build:dashboard` has been run at least once.
 */
function resolveDashboardDir(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../assets/dashboard");
  } catch {
    return null;
  }
}

/**
 * Absolute path to the vendored Scalar standalone bundle, or null if it can't
 * be located. Layout mirrors the dashboard asset:
 *   dist/cli.js            ← import.meta.url lands here
 *   assets/scalar/standalone.js   ← copied by `build:scalar`
 * Absent (dev without `build:scalar`) → the playground leaves `/docs` on the
 * CDN default.
 */
function resolveScalarAsset(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../assets/scalar/standalone.js");
  } catch {
    return null;
  }
}

/**
 * Known API route prefixes — any GET that matches one of these is never
 * rewritten to `index.html`. Keep in sync with `createServer()` routes.
 */
const API_PREFIXES = [
  "/agents",
  "/roles",
  "/capabilities",
  "/conversations",
  "/admin",
  "/health",
  "/eval",
];

export function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * A browser top-level navigation advertises `Accept: text/html,…`; the SPA's
 * own `fetch()` calls send a default Accept (never text/html). This is the
 * tell that lets a deep link / refresh on an SPA route under an API prefix
 * (e.g. `/agents/:id`) serve the SPA index, while an unmatched API fetch
 * still 404s as JSON expects. Same content-negotiation trick as the
 * dashboard vite config's `htmlNavBypass`.
 */
export function isHtmlNavigation(accept: string | undefined): boolean {
  return accept?.includes("text/html") ?? false;
}

/** The minimal fetch-handler shape shared by a Hono app and the shim below. */
export interface FetchLike {
  fetch: (req: Request, ...rest: never[]) => Response | Promise<Response>;
}

/**
 * Wrap the server's fetch with the HTML-NAVIGATION shim: a browser top-level
 * navigation (`Accept: text/html`) is answered from the SPA bundle BEFORE the
 * API routes can match, so SPA routes that COLLIDE with registered API GETs —
 * `/eval/runs/:id`, `/agents/:id` — deep-link and reload as pages instead of
 * returning raw JSON (Hono matches registered routes ahead of any fallback,
 * so this cannot be fixed inside the app). Mirrors the dashboard vite dev
 * proxy's `htmlNavBypass` semantics exactly: `fetch()`/SSE/curl requests
 * (which never Accept text/html) pass through to the API untouched, and a
 * literal asset file wins over the SPA index when one exists.
 */
export function withHtmlNavigationShim(api: FetchLike, dashboardDir: string): FetchLike {
  const indexPath = path.join(dashboardDir, "index.html");
  return {
    fetch: (req, ...rest) => {
      if (req.method === "GET" && isHtmlNavigation(req.headers.get("accept") ?? undefined)) {
        const pathname = decodeURIComponent(new URL(req.url).pathname);
        const assetPath = pathname === "/" ? indexPath : safeJoin(dashboardDir, pathname);
        if (assetPath && existsSync(assetPath) && statSync(assetPath).isFile()) {
          return streamFile(assetPath);
        }
        if (existsSync(indexPath)) {
          return streamFile(indexPath);
        }
      }
      return api.fetch(req, ...rest);
    },
  };
}

/**
 * Register a static-file + SPA-fallback handler on the Hono app. This is
 * mounted after `createServer()`'s routes, so API endpoints win the match.
 *
 * We avoid `@hono/node-server/serve-static` because it requires a
 * cwd-relative root; the CLI needs an absolute path resolved from
 * `import.meta.url`.
 */
function mountDashboard(app: ReturnType<typeof createServer>, dashboardDir: string): void {
  const indexPath = path.join(dashboardDir, "index.html");

  app.get("*", async (c) => {
    if (c.req.method !== "GET") {
      return c.notFound();
    }

    const url = new URL(c.req.url);
    const pathname = decodeURIComponent(url.pathname);

    // Only non-navigation requests hard-404 on API prefixes. REGISTERED API
    // routes never reach this handler (Hono matches them first) — what lands
    // here under an API prefix is either an SPA route colliding with a prefix
    // (a browser deep link / refresh on `/agents/:id` → serve the SPA) or an
    // unmatched API fetch (→ 404, never index.html masquerading as JSON).
    if (isApiPath(pathname) && !isHtmlNavigation(c.req.header("accept"))) {
      return c.notFound();
    }

    // Try the literal asset first; fall back to index.html for SPA routes.
    const assetPath = pathname === "/" ? indexPath : safeJoin(dashboardDir, pathname);

    if (assetPath && existsSync(assetPath) && statSync(assetPath).isFile()) {
      return streamFile(assetPath);
    }

    if (existsSync(indexPath)) {
      return streamFile(indexPath);
    }

    return c.notFound();
  });
}

/**
 * Join `base` + `rel` and reject the result if it escapes `base` (defense
 * against `..`-traversal). Returns `null` on any escape attempt.
 */
function safeJoin(base: string, rel: string): string | null {
  const joined = path.join(base, rel);
  const normalizedBase = path.resolve(base);
  const normalizedJoined = path.resolve(joined);
  if (
    normalizedJoined !== normalizedBase &&
    !normalizedJoined.startsWith(`${normalizedBase}${path.sep}`)
  ) {
    return null;
  }
  return normalizedJoined;
}

/**
 * Stream a file from disk as a Fetch `Response`. Sets a minimal content-type
 * based on the extension — good enough for a dashboard SPA (html/js/css/svg/png).
 */
function streamFile(filePath: string): Response {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] ?? "application/octet-stream";

  const nodeStream = createReadStream(filePath);
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk) => {
        const bytes =
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
        controller.enqueue(bytes);
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  return new Response(webStream, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Cross-platform "open this URL in the default browser". Best-effort —
 * swallows errors so a headless environment doesn't crash the playground.
 */
function openBrowser(url: string): void {
  const { platform } = process;
  const { cmd, args } =
    platform === "darwin"
      ? { cmd: "open", args: [url] }
      : platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : { cmd: "xdg-open", args: [url] };

  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* ignore — e.g. xdg-open missing in a container */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

/** Best-effort HEAD sha for `evalExecution.gitSha` provenance (the CLI's `commands/eval.ts` inline). */
function readGitSha(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Persistence wiring
// ---------------------------------------------------------------------------

interface PersistenceAttachment {
  store: SQLiteConversationStore | undefined;
  banner: string;
}

/**
 * Try to construct a `SQLiteConversationStore` (which — via extension,
 * `SQLiteConversationStore extends EvalStore extends RunStore extends
 * EventStore` — IS an `EvalStore`/`RunStore`/`EventStore` too: the same
 * instance backs `ServerConfig.store`, `eventStore`, `evalStore`, AND
 * `runStore`, and `ap eval` writes the very same db) and attach both a
 * `SQLiteExporter` (durable event log) and a `RunStoreExporter` (one `runs`
 * row per chat/run execution — today only eval executions wrote `runs` rows,
 * via `createEvalResultRecorder`) to the bus. Eval-owned runs are EXCLUDED
 * from the exporter via `shouldTrack` (their per-case traceIds carry
 * `runEval`'s `eval:` marker, `EVAL_TRACE_PREFIX`): a dashboard-launched
 * `POST /eval/runs` executes cases on this same shared bus, and each case's
 * `runs` row is already written by `createEvalResultRecorder` —
 * bus-tracking them too would double-write.
 * Soft-degrades to in-memory when:
 *   - `AP_PERSISTENCE=0` is set, or
 *   - `better-sqlite3` cannot be loaded.
 *
 * Boot hygiene: `sweepRunning()` closes any `runs` rows left `'running'` by a
 * previous process that died mid-run (crash, kill -9) before this process's
 * own runs start landing — otherwise those orphans linger "running" forever.
 */
async function maybeAttachPersistence(eventBus: AgentEventBus): Promise<PersistenceAttachment> {
  if (process.env.AP_PERSISTENCE === "0") {
    return { store: undefined, banner: "disabled (AP_PERSISTENCE=0)" };
  }

  const dbPath = resolveDbPath();
  ensureParentDir(dbPath);

  const retentionDays = parsePositiveInt(process.env.AP_RETENTION_DAYS) ?? 30;
  const maxRows = parsePositiveInt(process.env.AP_MAX_ROWS) ?? 1_000_000;

  const result = await loadConversationStore({ path: dbPath, retentionDays, maxRows });

  if (result.unavailable || !result.store) {
    return { store: undefined, banner: `memory-only — ${result.reason}` };
  }

  const sqliteExporter = new SQLiteExporter({ store: result.store });
  sqliteExporter.attach(eventBus);

  const runStoreExporter = new RunStoreExporter({
    store: result.store,
    // Eval-owned runs persist via createEvalResultRecorder — skip them here.
    shouldTrack: (e) => !e.traceId?.startsWith(EVAL_TRACE_PREFIX),
  });
  runStoreExporter.attach(eventBus);

  const swept = result.store.sweepRunning();
  const sweptNote = swept > 0 ? `; swept ${swept} orphaned run(s)` : "";

  return {
    store: result.store,
    banner: `${dbPath} (${result.store.count()} events)${sweptNote}`,
  };
}

function parsePositiveInt(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) || n <= 0 ? undefined : n;
}

/**
 * Parse `AP_APPROVAL_TOOLS` — a comma-separated list of tool names that require
 * human approval before executing. Trims blanks; empty/unset → an empty set
 * (no gating).
 */
function parseApprovalTools(s: string | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  );
}
