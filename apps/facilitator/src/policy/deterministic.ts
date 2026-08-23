/**
 * Deterministic policy engine.
 *
 * THIS FUNCTION IS THE FINAL AUTHORITY. No downstream code may override an
 * `allowed: false` result. AI advisory is never called if this returns false
 * (see fiat402/CLAUDE.md: "Runs inside /verify, before any AI call. Final
 * authority — nothing overrides its false").
 *
 * Zero ML. Three deterministic checks, enforced in this order:
 *   1. Hard ceiling      — requirements.amount (paise) <= MAX_AMOUNT_PAISE
 *   2. Merchant allowlist — requirements.payTo in ALLOWED_MERCHANTS
 *   3. Velocity limit     — agent identifier under MAX_REQUESTS_PER_MINUTE,
 *                           tracked in a Redis sorted set at
 *                           `velocity:{agentIdentifier}` (1-minute sliding
 *                           window), per CLAUDE.md's Redis key schema section.
 *
 * Field names (`amount`, `payTo`) are exactly those on PaymentRequirements
 * per x402-specification-v2.md section 5.1.2, as re-exported by
 * packages/scheme-upi/src/types.ts's UpiPaymentRequirements.
 */

import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";

/**
 * Minimal Redis client surface this module needs for the velocity sorted
 * set. Matches the ioredis/node-redis method names for these commands.
 * Passed in by the caller — this file never instantiates a Redis client.
 */
export interface VelocityRedisClient {
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
  zcard(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * Context for a single checkDeterministicPolicy call.
 *
 * `requestIp` / `agentHeader` feed the agent identifier (see the comment on
 * `buildAgentIdentifier` below for why). `now` is an injectable clock for
 * deterministic tests; defaults to `Date.now`.
 */
export interface DeterministicPolicyContext {
  redis: VelocityRedisClient;
  requestIp?: string;
  agentHeader?: string;
  now?: () => number;
}

export interface DeterministicPolicyResult {
  allowed: boolean;
  reason?: string;
}

/** 1-minute sliding window, per CLAUDE.md's Redis key schema section. */
const VELOCITY_WINDOW_MS = 60_000;

/**
 * TTL applied to `velocity:{agentIdentifier}` keys on every write.
 *
 * CLAUDE.md's blanket TTL rule ("maxTimeoutSeconds + 60") is defined for
 * per-request `req:{requestId}:*` keys, which don't apply here — a velocity
 * key isn't scoped to one request's maxTimeoutSeconds, it's scoped to an
 * agent's rolling 1-minute window. We use 2x the window (120s) so the key
 * self-cleans shortly after an agent goes idle, while comfortably outliving
 * any single window so trimming (zremrangebyscore) — not expiry — is what
 * normally prunes old entries.
 */
const VELOCITY_KEY_TTL_SECONDS = 120;

/**
 * Builds the identifier used to key the velocity sorted set.
 *
 * Chosen as `paymentPayload.accepted.payTo` (the merchant being paid) combined
 * with a request IP or agent header, per this module's spec. This is a
 * deliberate, coarser-than-ideal choice: `payTo` alone would rate-limit all
 * agents paying the same merchant together, which is too broad; IP/agent
 * header alone would let an agent switching merchants dodge the limit, and
 * IPs are unreliable for AI agents behind shared infra. Combining the two
 * scopes the limit to "this caller, against this merchant" — the caller
 * cannot bypass the limit by targeting a different merchant's endpoint from
 * the same IP, nor by spoofing headers alone while payTo stays the same. If
 * neither an IP nor an agent header is available, we fall back to a fixed
 * "unknown" bucket, which intentionally rate-limits all unidentified callers
 * together rather than skip velocity checking for them.
 */
function buildAgentIdentifier(payTo: string, context: DeterministicPolicyContext): string {
  const callerId = context.agentHeader || context.requestIp || "unknown";
  return `${payTo}:${callerId}`;
}

/**
 * Validates the minimal shape of `requirements` this engine depends on.
 * Returns a rejection reason string, or null if the shape is usable.
 */
function validateRequirementsShape(requirements: PaymentRequirements | null | undefined): string | null {
  if (!requirements || typeof requirements !== "object") {
    return "malformed requirements: not an object";
  }
  if (typeof requirements.amount !== "string" || !/^\d+$/.test(requirements.amount)) {
    return "malformed requirements: amount must be a non-negative integer string (paise)";
  }
  if (typeof requirements.payTo !== "string" || requirements.payTo.length === 0) {
    return "malformed requirements: payTo must be a non-empty string";
  }
  return null;
}

/**
 * Parses ALLOWED_MERCHANTS (comma-separated env var) into a Set, trimming
 * whitespace and dropping empty entries.
 */
function parseAllowedMerchants(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0),
  );
}

/**
 * checkDeterministicPolicy — the final-authority policy gate. See top-of-file
 * comment: no caller may treat `allowed: false` as advisory or override it.
 *
 * Never throws. Missing/malformed requirements, missing/invalid env config,
 * and Redis errors during the velocity check all resolve to
 * `{ allowed: false, reason: ... }` (fail closed), not an exception.
 *
 * @param requirements - The PaymentRequirements chosen for this request (spec 5.1.2 fields).
 * @param payload - The full PaymentPayload from the client (spec 5.2.2); `payload.accepted.payTo`
 *   feeds the agent identifier for the velocity check.
 * @param context - Redis client (caller-owned) plus request-identifying info and an optional clock.
 */
export async function checkDeterministicPolicy(
  requirements: PaymentRequirements,
  payload: PaymentPayload,
  context: DeterministicPolicyContext,
): Promise<DeterministicPolicyResult> {
  // --- Shape validation -----------------------------------------------
  const shapeError = validateRequirementsShape(requirements);
  if (shapeError) {
    return { allowed: false, reason: shapeError };
  }
  if (!payload || typeof payload !== "object" || !payload.accepted || typeof payload.accepted.payTo !== "string") {
    return { allowed: false, reason: "malformed payload: payload.accepted.payTo is required" };
  }

  // --- 1. Hard ceiling ---------------------------------------------------
  const maxAmountRaw = process.env.MAX_AMOUNT_PAISE;
  if (!maxAmountRaw || !/^\d+$/.test(maxAmountRaw)) {
    // Missing/invalid config is a misconfiguration, not an implicit "no ceiling" —
    // fail closed rather than silently allowing unbounded amounts.
    return { allowed: false, reason: "policy misconfigured: MAX_AMOUNT_PAISE is not a valid integer" };
  }
  const amount = BigInt(requirements.amount);
  const maxAmountPaise = BigInt(maxAmountRaw);
  if (amount > maxAmountPaise) {
    return {
      allowed: false,
      reason: `amount ${requirements.amount} paise exceeds MAX_AMOUNT_PAISE (${maxAmountRaw})`,
    };
  }

  // --- 2. Merchant allowlist ----------------------------------------------
  const allowedMerchants = parseAllowedMerchants(process.env.ALLOWED_MERCHANTS);
  if (!allowedMerchants.has(requirements.payTo)) {
    return { allowed: false, reason: `payTo "${requirements.payTo}" is not in ALLOWED_MERCHANTS` };
  }

  // --- 3. Velocity limit ----------------------------------------------
  const maxRequestsRaw = process.env.MAX_REQUESTS_PER_MINUTE;
  if (!maxRequestsRaw || !/^\d+$/.test(maxRequestsRaw)) {
    return { allowed: false, reason: "policy misconfigured: MAX_REQUESTS_PER_MINUTE is not a valid integer" };
  }
  const maxRequestsPerMinute = Number(maxRequestsRaw);

  const agentIdentifier = buildAgentIdentifier(payload.accepted.payTo, context);
  const key = `velocity:${agentIdentifier}`;
  const now = (context.now ?? Date.now)();
  const windowStart = now - VELOCITY_WINDOW_MS;

  try {
    // Trim entries that have fallen out of the 1-minute sliding window before counting.
    await context.redis.zremrangebyscore(key, 0, windowStart);
    const requestsInWindow = await context.redis.zcard(key);

    if (requestsInWindow >= maxRequestsPerMinute) {
      return {
        allowed: false,
        reason: `velocity limit exceeded: ${requestsInWindow}/${maxRequestsPerMinute} requests in the last minute`,
      };
    }

    // Record this request only once it's confirmed within the limit, so a
    // rejected request doesn't itself consume a slot in the window.
    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    await context.redis.zadd(key, now, member);
    await context.redis.expire(key, VELOCITY_KEY_TTL_SECONDS);
  } catch (error) {
    // Redis unavailable = fail closed (reject), not open. See CLAUDE.md's
    // "Deterministic policy engine" section.
    const message = error instanceof Error ? error.message : String(error);
    return { allowed: false, reason: `velocity check failed (Redis unavailable): ${message}` };
  }

  return { allowed: true };
}
