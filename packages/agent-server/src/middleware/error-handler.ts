/**
 * Global error handler.
 */

import type { ErrorHandler } from "hono";

export const errorHandler: ErrorHandler = (err, c) => {
  console.error("Server error:", err);
  return c.json({ error: err.message || "Internal server error" }, 500);
};
