import type { NextConfig } from "next";

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
