import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Skip the proxy for top-level browser navigations (SPA route loads).
 *
 * The backend exposes REST routes at `/conversations` and `/messages` that
 * collide with our client-side routes (`/conversations`, `/conversations/:id`).
 * Without this bypass, hitting those URLs in the address bar — or having
 * react-router push to them — would be proxied to NestJS, which returns
 * raw JSON instead of the SPA's index.html.
 *
 * Heuristic: browser top-level nav sends `Accept: text/html,...`; fetch()
 * calls from our client send a default Accept (not text/html) and we set
 * `Content-Type: application/json`. So if the request accepts HTML, we
 * return the request URL to tell Vite to serve it locally (falling through
 * to the SPA index).
 */
const htmlNavBypass = (
  req: { headers: Record<string, string | string[] | undefined> } & {
    url?: string;
  },
) => {
  const accept = req.headers.accept;
  const acceptStr = Array.isArray(accept) ? accept.join(",") : (accept ?? "");
  if (acceptStr.includes("text/html")) {
    return req.url;
  }
  return null;
};

// API server to proxy to — override with API_PROXY when the server runs off :3456.
const apiTarget = process.env.API_PROXY ?? "http://localhost:3456";

export default defineConfig({
  plugins: [react()],
  server: {
    // Default off Vite's 5173 (commonly taken). Override with DASHBOARD_PORT.
    port: Number(process.env.DASHBOARD_PORT ?? 5273),
    proxy: {
      "/admin": { target: apiTarget, bypass: htmlNavBypass },
      "/conversations": { target: apiTarget, bypass: htmlNavBypass },
      "/messages": { target: apiTarget, bypass: htmlNavBypass },
      "/agents": { target: apiTarget, bypass: htmlNavBypass },
      "/hooks": { target: apiTarget, bypass: htmlNavBypass },
      "/health": { target: apiTarget, bypass: htmlNavBypass },
    },
  },
});
