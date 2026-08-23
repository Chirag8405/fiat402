import type { NextConfig } from "next";

/**
 * `serverExternalPackages` keeps pg/@upstash/redis/razorpay (pulled in
 * transitively through the in-process import of ../../facilitator/src/{server,ws,store}.ts
 * -- see app/api/stream/route.ts) out of webpack/turbopack bundling; they're
 * Node-native/HTTP clients meant to run as plain CommonJS/ESM in the Node runtime.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "@upstash/redis", "razorpay"],
};

export default nextConfig;
