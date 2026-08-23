/**
 * Configured Upstash Redis client instance.
 *
 * Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN from env and
 * constructs one shared client. Mirrors the pattern in
 * ../razorpay/client.ts (razorpayClient): a single place credentials are
 * read from env, imported by every other module that needs Redis rather
 * than each constructing its own client.
 *
 * The `Redis` instance from @upstash/redis satisfies, structurally, every
 * DI interface other modules in this codebase declare for their own testing
 * purposes (deterministic.ts's VelocityRedisClient, webhook-handler.ts's
 * WebhookRedisClient, state-machine.ts's StateMachineRedisClient, and
 * ./ws.ts's PublishRedisClient/SubscribeRedisClient) — this file's only job
 * is to construct that one client from env; it does not wrap or adapt it.
 */

import { Redis } from "@upstash/redis";

export const redisClient = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL ?? "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN ?? "",
});
