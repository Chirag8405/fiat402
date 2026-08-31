/**
 * Hard, global rate limit for POST /api/simulate -- an independent safety
 * net on top of the /console passcode gate (lib/console-auth.ts), not a
 * replacement for it: even a passcode holder shouldn't be able to trigger
 * unbounded real-money-adjacent Razorpay Payment Links from this demo.
 *
 * Rolling window via a Redis sorted set, same shape as the facilitator's own
 * velocity:{agentIdentifier} check (CLAUDE.md's "Redis key schema" section,
 * apps/facilitator's Module 2) -- one member per trigger, scored by its own
 * timestamp, ZREMRANGEBYSCORE evicts anything older than the window before
 * counting, so "5 per hour" is a genuine rolling window (a trigger from 61
 * minutes ago no longer counts), not a fixed-bucket reset. Global across all
 * callers, deliberately: this key has no per-agent/per-IP suffix, unlike the
 * facilitator's velocity check, which is scoped per agent identifier -- this
 * one caps the whole demo's trigger volume, not any individual caller's.
 */

import { redisClient } from "./redis";

const RATE_LIMIT_KEY = "fiat402:demo:simulate-limit";
const WINDOW_SECONDS = 60 * 60;
const MAX_TRIGGERS_PER_WINDOW = 5;

export interface RateLimitResult {
  allowed: boolean;
  /** Count within the rolling window AFTER this check (includes the just-recorded trigger when allowed). */
  count: number;
}

/**
 * Fail-open on Redis errors: unlike the facilitator's velocity check (which
 * fails closed -- CLAUDE.md: "Redis unavailable = fail closed"), a demo
 * safety net going briefly unavailable shouldn't itself take the whole demo
 * down. The passcode gate (lib/console-auth.ts) still fails closed and
 * remains the primary access control either way.
 */
export async function checkAndRecordSimulateTrigger(): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - WINDOW_SECONDS * 1000;

  try {
    await redisClient.zremrangebyscore(RATE_LIMIT_KEY, 0, windowStart);
    const currentCount = await redisClient.zcard(RATE_LIMIT_KEY);

    if (currentCount >= MAX_TRIGGERS_PER_WINDOW) {
      return { allowed: false, count: currentCount };
    }

    // Unique member per call (timestamp alone can collide within the same
    // millisecond under concurrent requests, which ZADD would then silently
    // dedupe against) -- random suffix guarantees each trigger gets its own
    // sorted-set entry regardless.
    await redisClient.zadd(RATE_LIMIT_KEY, { score: now, member: `${now}:${Math.random().toString(36).slice(2)}` });
    await redisClient.expire(RATE_LIMIT_KEY, WINDOW_SECONDS);

    return { allowed: true, count: currentCount + 1 };
  } catch (err) {
    console.warn("simulate-rate-limit: Redis check failed, failing open (allowing the trigger)", err);
    return { allowed: true, count: -1 };
  }
}
