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

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/admin": { target: "http://localhost:3456", bypass: htmlNavBypass },
      "/conversations": { target: "http://localhost:3456", bypass: htmlNavBypass },
      "/messages": { target: "http://localhost:3456", bypass: htmlNavBypass },
      "/agents": { target: "http://localhost:3456", bypass: htmlNavBypass },
      // `/roles` and `/capabilities` collide with the SPA's own routes
      // (`/roles/:id`, `/capabilities/:id`) exactly like `/agents` above —
      // same htmlNavBypass treatment (port-map.md §1, S4 browser-validation
      // note: Build pages 404'd in dev without these two).
      "/roles": { target: "http://localhost:3456", bypass: htmlNavBypass },
      "/capabilities": { target: "http://localhost:3456", bypass: htmlNavBypass },
      "/hooks": { target: "http://localhost:3456", bypass: htmlNavBypass },
      "/health": { target: "http://localhost:3456", bypass: htmlNavBypass },
      "/eval": { target: "http://localhost:3456", bypass: htmlNavBypass },
    },
  },
});
