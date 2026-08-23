import type { NextConfig } from "next";
import dotenv from "dotenv";
import path from "path";

// Next.js only auto-loads .env/.env.local from this project's own directory,
// not the monorepo root -- load the single root .env (see "Consolidate to
// single root .env") before the rest of this config, and before any route
// code runs, so process.env is populated the same way for `next dev`/`next build`.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

/**
 * `serverExternalPackages` keeps pg/@upstash/redis/razorpay (pulled in transitively
 * through the in-process import of ../../facilitator/src/server.ts — see
 * lib/x402-middleware.ts) from being bundled by webpack/turbopack; they're
 * Node-native/HTTP clients meant to run as plain CommonJS/ESM in the Node runtime.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "@upstash/redis", "razorpay"],
};

export default nextConfig;
