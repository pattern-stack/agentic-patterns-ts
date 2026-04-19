/**
 * Single source of truth for CLI-level defaults.
 *
 * Anything hardcoded here (ports, URLs, timeouts) should be imported by
 * consumers rather than duplicated. The one exception is `hooks/emit.mjs` —
 * it's a zero-dependency standalone script that runs in user projects and
 * can't import from the workspace. Its inlined fallback must be kept in sync
 * manually; see the comment in that file.
 */

/**
 * Default port for `ap playground` and the Hono server.
 *
 * Chosen to avoid the crowded :3000 range (Next.js, Create React App, Vite,
 * most template-generated dev servers). Users with existing setups on :3000
 * don't have to stop anything to try us out.
 */
export const DEFAULT_DASHBOARD_PORT = 3456;

/** Default URL the Claude Code hook plugin POSTs to. */
export const DEFAULT_DASHBOARD_URL = `http://localhost:${DEFAULT_DASHBOARD_PORT}`;
