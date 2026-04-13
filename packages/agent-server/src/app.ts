/**
 * Hono application factory.
 */

import { Hono } from "hono";
import type { ServerConfig } from "./config.js";
import { corsMiddleware } from "./middleware/cors.js";
import { errorHandler } from "./middleware/error-handler.js";
import { adminRoutes } from "./routes/admin.js";
import { agentRoutes } from "./routes/agents.js";
import { conversationRoutes } from "./routes/conversations.js";
import { healthRoutes } from "./routes/health.js";

/**
 * Create a configured Hono app with all routes.
 */
export function createServer(config: ServerConfig): Hono {
  const app = new Hono();

  // Middleware
  app.use("*", corsMiddleware());
  app.onError(errorHandler);

  // Routes
  app.route("/", healthRoutes());
  app.route("/", agentRoutes(config.agents));
  app.route("/", conversationRoutes(config.agents));
  app.route("/", adminRoutes(config));

  return app;
}
