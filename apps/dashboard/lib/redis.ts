/**
 * Self-contained Upstash Redis client for the dashboard.
 *
 * Constructs its own client from this package's own env vars/dependency
 * (@upstash/redis is a direct dependency of apps/dashboard) rather than
 * importing apps/facilitator/src/store/redis.ts -- this package must have
 * zero runtime imports into apps/facilitator/, since Vercel only installs
 * apps/dashboard's own node_modules.
 */

import { Redis } from "@upstash/redis";

export const redisClient = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL ?? "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN ?? "",
});
