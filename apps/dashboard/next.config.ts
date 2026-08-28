import type { NextConfig } from "next";
import dotenv from "dotenv";
import path from "path";

// Next.js only auto-loads .env/.env.local from this project's own directory,
// not the monorepo root -- load the single root .env (see "Consolidate to
// single root .env") before the rest of this config, and before any route
// code runs, so process.env is populated the same way for `next dev`/`next build`.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

/**
 * `serverExternalPackages` keeps these Node-native/HTTP client packages out
 * of webpack/turbopack bundling so they run as plain CommonJS/ESM in the
 * Node runtime. Only `@upstash/redis` is actually a direct dependency of
 * this app today (lib/redis.ts, used by app/api/events/route.ts and
 * app/api/reconciliation/[requestId]/route.ts's facilitator proxy) --
 * `pg`/`razorpay` are unused holdovers from an earlier architecture that
 * imported apps/facilitator/src/{server,ws,store}.ts in-process via a since-
 * deleted app/api/stream/route.ts (SSE relay; a held-open connection didn't
 * fit Vercel's serverless model reliably, so the dashboard now polls its own
 * Redis-backed and facilitator-proxy routes instead -- see app/page.tsx's
 * top-of-file comment). Left listed defensively rather than removed, since
 * a future direct-Postgres-access path (an alternative to the current
 * facilitator-HTTP-proxy approach) would need `pg` back regardless.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "@upstash/redis", "razorpay"],
};

export default nextConfig;
