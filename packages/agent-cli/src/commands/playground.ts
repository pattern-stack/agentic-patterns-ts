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

import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentEventBus,
  InMemoryAdminService,
  InMemoryEventCollector,
  SQLiteExporter,
  SSEExporter,
  createRunner,
  createToolboxExecutor,
  loadEventStore,
} from "@agentic-patterns/runtime";
import type { EventStore } from "@agentic-patterns/runtime";
import { createServer } from "@agentic-patterns/server";
import type { AgentRegistration } from "@agentic-patterns/server";
import { serve } from "@hono/node-server";
import { DEFAULT_DASHBOARD_PORT } from "../constants.js";
import type { DiscoveredAgent } from "../helpers/discover.js";

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

  const collector = new InMemoryEventCollector();
  collector.attach(eventBus);

  const adminService = new InMemoryAdminService(collector);

  const sseExporter = new SSEExporter();
  sseExporter.attach(eventBus);

  // Durable event log (SQLite). Optional — degrades to memory-only when
  // better-sqlite3 isn't installed or AP_PERSISTENCE=0 is set.
  const persistence = await maybeAttachPersistence(eventBus);
  const eventStore = persistence.store;

  // -------------------------------------------------------------------------
  // 2. Runner — env-driven auto-detection
  // -------------------------------------------------------------------------

  const selection = await createRunner({
    eventBus,
    tier: (process.env.AGENT_TIER as "opus" | "sonnet" | "haiku" | undefined) ?? "sonnet",
    verbose: false,
  });
  const { runner } = selection;

  // -------------------------------------------------------------------------
  // 3. Attach runner to each registration
  // -------------------------------------------------------------------------

  const registrations: AgentRegistration[] = opts.agents.map((reg) => ({
    id: reg.id,
    name: reg.name,
    description: reg.description,
    agent: reg.agent,
    file: reg.file,
    provenance: reg.provenance,
    runner,
  }));
  // Mark createToolboxExecutor as "imported for re-export discoverability" —
  // the conversation route already builds executors per request.
  void createToolboxExecutor;

  // -------------------------------------------------------------------------
  // 4. Build the Hono app with API routes FIRST
  // -------------------------------------------------------------------------

  const app = createServer({
    agents: registrations,
    adminService,
    eventBus,
    sseExporter,
    eventStore,
  });

  // -------------------------------------------------------------------------
  // 5. Mount the dashboard SPA (after API routes so API wins)
  // -------------------------------------------------------------------------

  const dashboardDir = resolveDashboardDir();
  let dashboardMounted = false;

  if (serveDashboard) {
    if (dashboardDir && existsSync(dashboardDir)) {
      mountDashboard(app, dashboardDir);
      dashboardMounted = true;
    } else {
      const where = dashboardDir ?? "<unresolved>";
      process.stderr.write(
        `[playground] warning: dashboard assets not found at ${where} — API-only mode.\n           run \`pnpm --filter @agentic-patterns/cli build\` (or \`build:dashboard\`) to build the SPA bundle.\n`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 6. Start the HTTP server
  // -------------------------------------------------------------------------

  await new Promise<void>((resolve) => {
    serve({ fetch: app.fetch, port }, () => {
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
 * Resolve the absolute path to the bundled dashboard assets.
 *
 * Layout after `pnpm --filter @agentic-patterns/cli build`:
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
 * Known API route prefixes — any GET that matches one of these is never
 * rewritten to `index.html`. Keep in sync with `createServer()` routes.
 */
const API_PREFIXES = ["/agents", "/roles", "/capabilities", "/conversations", "/admin", "/health"];

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
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

    if (isApiPath(pathname)) {
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

// ---------------------------------------------------------------------------
// Persistence wiring
// ---------------------------------------------------------------------------

interface PersistenceAttachment {
  store: EventStore | undefined;
  banner: string;
}

/**
 * Try to construct an `EventStore` and attach a `SQLiteExporter` to the bus.
 * Soft-degrades to in-memory when:
 *   - `AP_PERSISTENCE=0` is set, or
 *   - `better-sqlite3` cannot be loaded.
 */
async function maybeAttachPersistence(eventBus: AgentEventBus): Promise<PersistenceAttachment> {
  if (process.env.AP_PERSISTENCE === "0") {
    return { store: undefined, banner: "disabled (AP_PERSISTENCE=0)" };
  }

  const dbPath = resolveDbPath();
  ensureParentDir(dbPath);

  const retentionDays = parsePositiveInt(process.env.AP_RETENTION_DAYS) ?? 30;
  const maxRows = parsePositiveInt(process.env.AP_MAX_ROWS) ?? 1_000_000;

  const result = await loadEventStore({ path: dbPath, retentionDays, maxRows });

  if (result.unavailable || !result.store) {
    return { store: undefined, banner: `memory-only — ${result.reason}` };
  }

  const sqliteExporter = new SQLiteExporter({ store: result.store });
  sqliteExporter.attach(eventBus);

  return { store: result.store, banner: `${dbPath} (${result.store.count()} events)` };
}

function resolveDbPath(): string {
  if (process.env.AP_DB_PATH) return process.env.AP_DB_PATH;
  const base = process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state");
  return path.join(base, "ap", "events.db");
}

function ensureParentDir(filePath: string): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    // Best effort — EventStore will surface the real error if open fails.
  }
}

function parsePositiveInt(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) || n <= 0 ? undefined : n;
}
