/**
 * Vercel serverless entry — wraps the whole Express app as ONE function. vercel.json rewrites every
 * dynamic route (/api/*, /auth/*, /integrations/*, /healthz) here; the built client in dist/ is served
 * by Vercel's static layer, so Express's own static block is skipped (see server/index.ts).
 *
 * NOTE: on Vercel you MUST configure Supabase (SUPABASE_URL + SUPABASE_SERVICE_KEY) — the in-memory
 * session/rate-limit fallbacks don't survive between serverless invocations.
 *
 * When deployed to Vercel, build-vercel.sh bundles this file and its dependencies with esbuild,
 * producing api/index.js that Vercel's runtime executes.
 */
import app from "../server/index.ts";

export default app;
