/**
 * Hono application factory.
 */

import { Hono } from "hono";
import type { ServerConfig } from "./config.js";
import { corsMiddleware } from "./middleware/cors.js";
import { errorHandler } from "./middleware/error-handler.js";
import { adminRoutes } from "./routes/admin.js";
import { agentRoutes } from "./routes/agents.js";
import { type ConversationEntry, conversationRoutes } from "./routes/conversations.js";
import { eventRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { hookRoutes } from "./routes/hooks.js";

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
  app.route("/", conversationRoutes(config.agents, conversations, config.eventBus));
  app.route("/", adminRoutes(config));
  app.route("/", hookRoutes(config.eventBus));
  app.route("/", eventRoutes(config.eventStore, config.eventBus));

  return app;
}
