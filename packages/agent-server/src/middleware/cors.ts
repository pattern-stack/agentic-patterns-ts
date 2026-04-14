/**
 * CORS middleware for dashboard dev.
 */

import { cors } from "hono/cors";
import type { CORSConfig } from "../config.js";

/**
 * Build the Hono cors middleware for this server.
 *
 * Defaults are permissive (`origin: "*"`) for local development; callers
 * should pin origin/headers/credentials for production via `ServerConfig.cors`.
 */
export function corsMiddleware(config?: CORSConfig) {
  return cors({
    origin: config?.origin ?? "*",
    allowMethods: config?.allowMethods ?? ["GET", "POST", "OPTIONS"],
    allowHeaders: config?.allowHeaders ?? ["Content-Type"],
    ...(config?.maxAge !== undefined ? { maxAge: config.maxAge } : {}),
    ...(config?.credentials !== undefined ? { credentials: config.credentials } : {}),
    ...(config?.exposeHeaders !== undefined ? { exposeHeaders: config.exposeHeaders } : {}),
  });
}
