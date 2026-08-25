/**
 * State machine for a upi x402 settlement request.
 *
 * States, per CLAUDE.md's "State machine" section:
 *   created -> pending -> approved | declined | expired -> settled | failed
 *
 * This file is the single place `req:{requestId}:*` (and the two reverse
 * index) key strings are constructed, per CLAUDE.md's "Redis key schema"
 * section: "Do not invent alternate key shapes in any module — import these
 * from packages/scheme-upi/src/state-machine.ts." Every key builder is
 * exported so other modules (apps/facilitator/src/razorpay/webhook-handler.ts
 * and apps/facilitator/src/server.ts) import from here rather than
 * hand-rolling key strings.
 *
 * Two keys are NOT in CLAUDE.md's Redis key schema section as written, but
 * are treated as part of the authoritative schema per this module's own
 * spec (they were added during Module 4's implementation and documented in
 * apps/facilitator/src/razorpay/webhook-handler.ts):
 *   - paymentLinkId:{paymentLinkId}:requestId — reverse lookup, written when
 *     a Payment Link is created (see recordPaymentLinkCreated below).
 *   - razorpayPaymentId:{paymentId}:requestId — self-populating cache,
 *     written by webhook-handler.ts itself the first time it resolves a
 *     webhook via the paymentLinkId index (see that file's resolveRequestId
 *     for why: payment.captured/payment.failed payloads carry no
 *     payment_link_id). The key builder is defined here as the single
 *     source of truth on the key *shape*; webhook-handler.ts imports it
 *     directly rather than keeping its own copy.
 *
 * Redis access is done exclusively through the `StateMachineRedisClient`
 * passed into every function — this file never instantiates a Redis client
 * itself (mirrors the DI pattern already used by
 * apps/facilitator/src/policy/deterministic.ts's VelocityRedisClient and
 * apps/facilitator/src/razorpay/webhook-handler.ts's WebhookRedisClient).
 *
 * Pub/sub is delegated to apps/facilitator/src/ws.ts (channel name, event
 * shape, and the "single shared channel, not per-request channels" decision
 * all live there — see that file's top-of-file comment for the rationale).
 */

import { createHash, randomUUID } from "node:crypto";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import {
  publishEvent,
  subscribeToEvents,
  type FiatEvent,
  type RequestState,
  type PublishRedisClient,
  type SubscribeRedisClient,
} from "../../../apps/facilitator/src/ws";

export type { RequestState, FiatEvent };

/**
 * Full Redis client surface this module needs: get/set/expire for the
 * scalar `req:{requestId}:*` keys and the two reverse indexes, hset/hgetall
 * for the `req:{requestId}:meta` hash, plus publish/subscribe (structurally
 * compatible with ./ws.ts's PublishRedisClient/SubscribeRedisClient) for
 * transitions and the bounded wait. The real Upstash client
 * (apps/facilitator/src/store/redis.ts) satisfies this whole surface as one
 * object — callers pass that single client in, matching the "the Redis
 * client" (singular) framing of this module's spec.
 */
export interface StateMachineRedisClient extends PublishRedisClient, SubscribeRedisClient {
  get(key: string): Promise<string | null>;
  /** `mode: "KEEPTTL"` preserves the key's existing TTL — see transitionState. */
  set(key: string, value: string, mode?: "KEEPTTL"): Promise<unknown>;
  expire(key: string, seconds: number): Promise<number>;
  hset(key: string, fields: Record<string, string>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string> | null>;
}

export interface RequestMeta {
  amount: string;
  payTo: string;
  createdAt: string;
  expiresAt: string;
}

/** Buffer added on top of `maxTimeoutSeconds` for every `req:{requestId}:*` key's TTL, per CLAUDE.md. */
const TTL_BUFFER_SECONDS = 60;

// --- Key builders (the single authoritative source, per this file's header) ---

export function requestStateKey(requestId: string): string {
  return `req:${requestId}:state`;
}

export function requestMetaKey(requestId: string): string {
  return `req:${requestId}:meta`;
}

export function requestPaymentLinkKey(requestId: string): string {
  return `req:${requestId}:paymentLinkId`;
}

/** Reverse index: Razorpay payment_link_id -> requestId. Imported directly by webhook-handler.ts. */
export function paymentLinkIndexKey(paymentLinkId: string): string {
  return `paymentLinkId:${paymentLinkId}:requestId`;
}

/**
 * Reverse index: Razorpay payment_id -> requestId. Self-populating cache,
 * written by webhook-handler.ts the first time it resolves a webhook via
 * paymentLinkIndexKey — Razorpay's payment.captured/payment.failed payloads
 * carry no payment_link_id, so a later event for the same payment_id that
 * arrives without one can still resolve via this cache. Imported directly
 * by webhook-handler.ts.
 */
export function paymentIdIndexKey(paymentId: string): string {
  return `razorpayPaymentId:${paymentId}:requestId`;
}

// --- requestId derivation ---

/**
 * Derives requestId deterministically from `(payTo, amount, txnRef)`, so
 * concurrent /settle calls carrying the same logical request converge on
 * the same requestId instead of racing to create two Payment Links for the
 * same payment. Per CLAUDE.md's Redis key schema section: "derive it
 * deterministically from a hash of (paymentRequirements.payTo +
 * paymentRequirements.amount + payload.payload.txnRef or a generated UUID
 * if txnRef absent)".
 *
 * When `txnRef` is absent, a fresh UUID is mixed in instead, which means
 * the convergence property only holds when the client supplies a txnRef:
 * with no shared identifier to correlate on, there is no way to tell two
 * concurrent requests from the same logical one apart, so they are treated
 * as distinct requests by design (each gets its own Payment Link) rather
 * than silently colliding on false convergence.
 */
export function deriveRequestId(requirements: PaymentRequirements, payload: PaymentPayload): string {
  const rawTxnRef =
    payload && typeof payload === "object" && payload.payload && typeof payload.payload === "object"
      ? (payload.payload as { txnRef?: unknown }).txnRef
      : undefined;
  const dedupeComponent = typeof rawTxnRef === "string" && rawTxnRef.length > 0 ? rawTxnRef : randomUUID();

  const hash = createHash("sha256")
    .update(`${requirements.payTo}:${requirements.amount}:${dedupeComponent}`)
    .digest("hex");

  return `req_${hash.slice(0, 32)}`;
}

// --- Creation ---

/**
 * Creates a tracked request: writes `req:{requestId}:state` = "created" and
 * `req:{requestId}:meta`, both TTL'd at `requirements.maxTimeoutSeconds + 60`
 * per CLAUDE.md's blanket TTL rule. Does not publish an event — the pub/sub
 * schema models *transitions* (with a previousState), and "created" has no
 * previous state; ./transitionState is what publishes.
 */
export async function createTrackedRequest(
  redis: StateMachineRedisClient,
  requirements: PaymentRequirements,
  payload: PaymentPayload,
  now: () => number = Date.now,
): Promise<{ requestId: string; meta: RequestMeta }> {
  const requestId = deriveRequestId(requirements, payload);
  const nowMs = now();
  const ttlSeconds = requirements.maxTimeoutSeconds + TTL_BUFFER_SECONDS;

  const meta: RequestMeta = {
    amount: requirements.amount,
    payTo: requirements.payTo,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + requirements.maxTimeoutSeconds * 1000).toISOString(),
  };

  await redis.set(requestStateKey(requestId), "created");
  await redis.expire(requestStateKey(requestId), ttlSeconds);
  await redis.hset(requestMetaKey(requestId), meta as unknown as Record<string, string>);
  await redis.expire(requestMetaKey(requestId), ttlSeconds);

  return { requestId, meta };
}

/**
 * Records a newly-created Razorpay Payment Link against a request: writes
 * both the forward key (`req:{requestId}:paymentLinkId`) and the reverse
 * index (`paymentLinkId:{paymentLinkId}:requestId`) webhook-handler.ts
 * depends on to resolve inbound webhooks (see that file's resolveRequestId).
 * `ttlSeconds` should be the same `maxTimeoutSeconds + 60` value used at
 * creation time (the caller has `requirements.maxTimeoutSeconds` in scope;
 * this function does not re-derive it).
 */
export async function recordPaymentLinkCreated(
  redis: StateMachineRedisClient,
  requestId: string,
  paymentLinkId: string,
  ttlSeconds: number,
): Promise<void> {
  await redis.set(requestPaymentLinkKey(requestId), paymentLinkId);
  await redis.expire(requestPaymentLinkKey(requestId), ttlSeconds);
  await redis.set(paymentLinkIndexKey(paymentLinkId), requestId);
  await redis.expire(paymentLinkIndexKey(paymentLinkId), ttlSeconds);
}

// --- Transition ---

/** The optional, non-`meta` fields transitionState's `extra` parameter may merge into the published event. */
export type TransitionExtra = Partial<
  Pick<FiatEvent, "aiRecommendation" | "aiJustification" | "aiProvider" | "deterministicDecision" | "deterministicReason">
>;

/**
 * Transitions `requestId` to `newState`: updates `req:{requestId}:state`
 * (preserving its existing TTL via "KEEPTTL", exactly as webhook-handler.ts
 * already does for the same key) and publishes the transition on
 * `fiat402:events` via ./ws.ts's publishEvent. Returns the published event.
 *
 * `extra` merges optional decision-layer fields (aiRecommendation,
 * deterministicDecision, etc. -- see ./ws.ts's FiatEvent) onto the published
 * event's top level. It does not change this function's core transition
 * logic (state read/write, KEEPTTL, publish) -- it's a passthrough so
 * server.ts can attach that data to the "pending" transition specifically.
 */
export async function transitionState(
  redis: StateMachineRedisClient,
  requestId: string,
  newState: RequestState,
  meta: Partial<FiatEvent["meta"]> = {},
  extra: TransitionExtra = {},
): Promise<FiatEvent> {
  const previousState = await redis.get(requestStateKey(requestId));
  await redis.set(requestStateKey(requestId), newState, "KEEPTTL");

  const event: FiatEvent = {
    requestId,
    state: newState,
    previousState,
    timestamp: new Date().toISOString(),
    meta: {
      paymentLinkId: meta.paymentLinkId ?? null,
      razorpayPaymentId: meta.razorpayPaymentId ?? null,
      reason: meta.reason ?? null,
    },
    ...extra,
  };

  await publishEvent(redis, event);
  return event;
}

// --- Bounded, pub/sub-driven resolution ---

export interface ResolutionResult {
  state: RequestState;
  event: FiatEvent | null;
}

/**
 * Awaits resolution of `requestId`: subscribes to `fiat402:events`
 * (./ws.ts's subscribeToEvents), filtered client-side to this requestId,
 * and resolves as soon as an "approved" event arrives, or after
 * `maxTimeoutSeconds` elapses with `{ state: "expired", event: null }`,
 * whichever comes first. This is the function Module 5b's /settle handler
 * calls to turn the async Razorpay webhook flow into a single bounded
 * await.
 *
 * NOT a polling loop. CLAUDE.md is explicit that this must be pub/sub, not
 * `setInterval`-style polling, because of the UPI retry edge case:
 * webhook-handler.ts can receive `payment.failed` followed later by
 * `payment.captured` for the same Payment Link (the payer retried inside
 * the UPI app), and when that happens it transitions the request from
 * "declined" back to "approved" and republishes on the same channel. A
 * polling loop that already returned a 402 upon first observing "declined"
 * has no way to un-return that response when the retry-driven "approved"
 * event shows up seconds later — it has already exited. Staying subscribed
 * is what lets a still-open bounded wait catch that late "approved".
 *
 * This is also why "declined" does NOT resolve this function early: doing
 * so would reintroduce the exact same missed-retry failure mode via a
 * different mechanism (a Promise, once resolved, cannot un-resolve either).
 * Instead, a "declined" event is ignored here and the wait continues until
 * either a retry-driven "approved" arrives or the hard timeout fires. A
 * genuine decline with no retry simply rides out the timeout and resolves
 * as "expired" — which is fine for the caller, since declined and expired
 * are handled identically downstream (both mean "return SettlementResponse
 * with success: false"; see CLAUDE.md's pub/sub section and
 * docs/scheme_upi.md's Payment Flow section).
 */
export async function awaitResolution(
  redis: StateMachineRedisClient,
  requestId: string,
  maxTimeoutSeconds: number,
): Promise<ResolutionResult> {
  return new Promise<ResolutionResult>(resolve => {
    let settled = false;
    let unsubscribe: () => void = () => {};

    const finish = (result: ResolutionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };

    const timer = setTimeout(() => {
      // TEMP DIAGNOSTIC (see CLAUDE.md-adjacent investigation: "awaitResolution
      // misses the approved event in production") -- remove or reduce once cause is confirmed.
      console.log(`[awaitResolution] timeout fired for requestId=${requestId} after ${maxTimeoutSeconds}s`);
      finish({ state: "expired", event: null });
    }, maxTimeoutSeconds * 1000);

    unsubscribe = subscribeToEvents(redis, event => {
      // TEMP DIAGNOSTIC: log every event this subscriber receives, matched or
      // not -- tells us whether messages arrive at all vs. arrive but get
      // filtered out incorrectly.
      console.log(`[awaitResolution] received event: ${JSON.stringify(event)}`);
      if (event.requestId !== requestId) return;
      if (event.state === "approved") {
        finish({ state: "approved", event });
      }
      // "declined" is intentionally not handled here — see this function's
      // doc comment above for why.
    });

    // TEMP DIAGNOSTIC: logged after subscribeToEvents() returns, i.e. after
    // the underlying redis.subscribe() call and .on("message") registration
    // have completed *synchronously* from this function's point of view. This
    // does NOT prove the subscription is actually live on the Redis/Upstash
    // server yet -- see the investigation notes on the SSE-backed
    // @upstash/redis subscribe() implementation. Kept here specifically to
    // test that theory: if a webhook can publish and this requestId's
    // "approved" event is still missed, despite this log firing well before
    // the timeout, that's evidence the gap is between this line and the
    // subscription becoming live server-side, not in our own JS ordering.
    console.log(`[awaitResolution] subscribed to channel for requestId=${requestId}`);
  });
}
