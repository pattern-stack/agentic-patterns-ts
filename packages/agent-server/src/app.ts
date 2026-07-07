/**
 * Hono application factory.
 */

import { Hono } from "hono";
import type { ServerConfig } from "./config.js";
import { corsMiddleware } from "./middleware/cors.js";
import { errorHandler } from "./middleware/error-handler.js";
import { adminRoutes } from "./routes/admin.js";
import { agentRoutes } from "./routes/agents.js";
import { compositionRoutes } from "./routes/composition.js";
import { type ConversationEntry, conversationRoutes } from "./routes/conversations.js";
import { evalRoutes } from "./routes/eval.js";
import { eventRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { hookRoutes } from "./routes/hooks.js";
import { runsRoutes } from "./routes/runs.js";

/**
 * Create a configured Hono app with all routes.
 *
 * Each call creates a fresh conversation registry, so multiple
 * servers in the same process do not share conversation state.
 */
export function createServer(config: ServerConfig): Hono {
  const app = new Hono();
  const conversations = new Map<string, ConversationEntry>();

  // Middleware
  app.use("*", corsMiddleware(config.cors));
  app.onError(errorHandler);

  // Routes
  app.route("/", healthRoutes());
  app.route("/", agentRoutes(config.agents));
  app.route("/", compositionRoutes(config.agents, config.eventBus));
  app.route("/", conversationRoutes(config.agents, conversations, config.eventBus, config.store));
  app.route("/", adminRoutes(config));
  app.route("/", hookRoutes(config.eventBus));
  app.route("/", eventRoutes(config.eventStore, config.eventBus));
  // `EvalStore` IS a `RunStore` (extension) — an embedder that wires
  // `evalStore` but not the explicit `runStore` slot still gets run history.
  app.route("/", runsRoutes(config.runStore ?? config.evalStore));
  app.route(
    "/",
    evalRoutes({
      evalStore: config.evalStore,
      agents: config.agents,
      eventBus: config.eventBus,
      evalExecution: config.evalExecution,
      conversations,
    }),
  );

  return app;
}
