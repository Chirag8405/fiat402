/**
 * Razorpay webhook handler.
 *
 * Mount as Express middleware BEFORE any JSON body-parsing middleware for
 * this route — signature verification must run over the exact raw request
 * bytes. CLAUDE.md's "Razorpay integration" section: "verify against raw
 * bytes BEFORE any JSON parsing; re-serialized body will fail signature
 * check due to whitespace/key ordering differences." Mount like:
 *
 *   app.post(
 *     "/webhooks/razorpay",
 *     express.raw({ type: "application/json" }),
 *     razorpayWebhookHandler(redis),
 *   );
 *
 * `express.raw()` gives `req.body` as a `Buffer` of the untouched bytes,
 * which is what this handler requires — do not add `express.json()` ahead
 * of it on this route.
 *
 * Events handled, per CLAUDE.md's "Razorpay integration" section:
 *   - payment.captured      -> transition to "approved" (the definitive
 *                              "money moved" signal; payment.authorized
 *                              alone is not sufficient for UPI, since
 *                              Razorpay can auto-refund an
 *                              authorized-but-uncaptured UPI payment)
 *   - payment_link.paid     -> same as payment.captured (belt-and-suspenders
 *                              for Payment Link flows; both events fire and
 *                              both must resolve the wait idempotently)
 *   - payment.failed        -> transition to "declined"
 *   - UPI retry edge case: payment.captured arriving for a request already
 *     "declined" (user retried in the UPI app after an initial failure)
 *     transitions back to "approved" and publishes a fresh event, per
 *     CLAUDE.md: "expected behavior per Razorpay docs, not a bug."
 *
 * Requestid resolution (undocumented gap in CLAUDE.md's Redis key schema —
 * see resolveRequestId below for the full explanation and what's assumed).
 */

import type { Request, RequestHandler, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  requestStateKey,
  paymentLinkIndexKey,
  paymentIdIndexKey,
} from "../../../../packages/scheme-upi/src/state-machine";
import type { FiatEvent } from "../ws";

/**
 * Minimal Redis client surface this module needs. Matches ioredis/node-redis
 * method names. Passed in by the caller (server.ts) — this file never
 * instantiates a Redis client, mirroring the DI pattern in
 * ../policy/deterministic.ts's VelocityRedisClient.
 */
export interface WebhookRedisClient {
  get(key: string): Promise<string | null>;
  /** `mode: "KEEPTTL"` preserves the key's existing TTL (set once when the
   *  request was created, per CLAUDE.md's "maxTimeoutSeconds + 60" rule) —
   *  a plain SET would otherwise silently strip it. */
  set(key: string, value: string, mode?: "KEEPTTL"): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  /** Used by publishTransition to also append onto EVENTS_RECENT_LIST — see that constant's doc comment below. */
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
}

type RequestState = "created" | "pending" | "approved" | "declined" | "expired" | "settled" | "failed";

const EVENTS_CHANNEL = "fiat402:events";

/**
 * Bounded recent-events list apps/dashboard/app/api/events/route.ts polls,
 * since a plain pub/sub channel has no history for a reader that wasn't
 * subscribed at publish time. Inlined here rather than imported from
 * ../ws.ts, matching this module's own stated pattern (see this file's
 * top-of-file comment) of having no dependency on state-machine.ts/ws.ts —
 * keep the key name and cap in sync with ../ws.ts's EVENTS_RECENT_LIST /
 * EVENTS_RECENT_LIST_MAX by hand.
 *
 * Before this, publishTransition only PUBLISHed to EVENTS_CHANNEL and never
 * appended here, so "approved"/"declined" transitions (the two states this
 * module owns) were invisible to the dashboard's poll-based /api/events --
 * only "pending"/"settled"/"failed" (published via
 * packages/scheme-upi/src/state-machine.ts's transitionState, which already
 * did LPUSH/LTRIM here) ever showed up. That gap is what this addition fixes.
 */
const EVENTS_RECENT_LIST = "fiat402:events:recent";
const EVENTS_RECENT_LIST_MAX = 200;

/** Generous fixed TTL for the payment_id cache — see packages/scheme-upi/src/state-machine.ts's
 *  paymentIdIndexKey doc comment for why this cache exists.
 *  Not tied to maxTimeoutSeconds (unknown to this module); long enough to
 *  outlive any plausible webhook redelivery/out-of-order window. */
const PAYMENT_ID_CACHE_TTL_SECONDS = 24 * 60 * 60;

interface RazorpayWebhookEvent {
  event?: string;
  payload?: {
    payment_link?: { entity?: { id?: string } };
    payment?: { entity?: { id?: string; error_description?: string } };
  };
}

/**
 * Verifies X-Razorpay-Signature: HMAC-SHA256 of the raw body bytes using
 * RAZORPAY_WEBHOOK_SECRET, compared in constant time. Per CLAUDE.md:
 * "Compare (constant-time) against X-Razorpay-Signature header."
 */
function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expected = Buffer.from(expectedHex, "utf8");
  const provided = Buffer.from(signature, "utf8");
  // timingSafeEqual throws on length mismatch; unequal-length signatures are
  // simply not equal, and checking length first isn't itself a timing leak
  // worth avoiding here (the secret's length is fixed and public: it's
  // always a 64-char hex digest).
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function extractPaymentLinkId(event: RazorpayWebhookEvent): string | undefined {
  return event.payload?.payment_link?.entity?.id;
}

function extractPaymentId(event: RazorpayWebhookEvent): string | undefined {
  return event.payload?.payment?.entity?.id;
}

/**
 * Resolves an inbound webhook event to the requestId it belongs to.
 *
 * Tries, in order: (1) the payment_link_id -> requestId index, if the event
 * carries a payment_link reference; (2) the payment_id -> requestId cache,
 * for events that don't. Returns undefined if neither resolves — the caller
 * treats that as "no matching in-flight request" per this module's edge-case
 * spec (log and return 200, do not error).
 *
 * On a successful resolution via (1), opportunistically caches the
 * payment_id -> requestId mapping (if a payment_id is present on the event)
 * so a later event that lacks the link reference can still resolve.
 */
async function resolveRequestId(redis: WebhookRedisClient, event: RazorpayWebhookEvent): Promise<string | undefined> {
  const paymentLinkId = extractPaymentLinkId(event);
  const paymentId = extractPaymentId(event);

  if (paymentLinkId) {
    const requestId = await redis.get(paymentLinkIndexKey(paymentLinkId));
    if (requestId) {
      if (paymentId) {
        await redis.set(paymentIdIndexKey(paymentId), requestId);
      }
      return requestId;
    }
  }

  if (paymentId) {
    const cached = await redis.get(paymentIdIndexKey(paymentId));
    if (cached) return cached;
  }

  return undefined;
}

async function publishTransition(
  redis: WebhookRedisClient,
  requestId: string,
  state: RequestState,
  previousState: string | null,
  meta: FiatEvent["meta"],
): Promise<void> {
  await redis.set(requestStateKey(requestId), state, "KEEPTTL");
  const message: FiatEvent = {
    requestId,
    state,
    previousState,
    timestamp: new Date().toISOString(),
    meta,
  };
  const serialized = JSON.stringify(message);
  await redis.publish(EVENTS_CHANNEL, serialized);
  await redis.lpush(EVENTS_RECENT_LIST, serialized);
  await redis.ltrim(EVENTS_RECENT_LIST, 0, EVENTS_RECENT_LIST_MAX - 1);
}

const TERMINAL_STATES: ReadonlySet<string> = new Set(["settled", "failed"]);

async function handleCapturedOrPaid(
  redis: WebhookRedisClient,
  requestId: string,
  paymentLinkId: string | undefined,
  paymentId: string | undefined,
  eventType: string,
): Promise<void> {
  const previousState = await redis.get(requestStateKey(requestId));

  if (previousState && TERMINAL_STATES.has(previousState)) {
    console.log(
      `razorpay webhook: ignoring ${eventType} for requestId=${requestId}, already in terminal state "${previousState}"`,
    );
    return;
  }

  if (previousState === "declined") {
    // UPI retry edge case, per CLAUDE.md: "you may occasionally receive
    // payment.failed followed by payment.captured for the same Payment Link
    // if the user retries within the UPI app." Expected behavior, not a bug.
    console.log(
      `razorpay webhook: UPI retry detected — requestId=${requestId} was "declined", ${eventType} received, transitioning back to "approved"`,
    );
  }

  await publishTransition(redis, requestId, "approved", previousState, {
    paymentLinkId: paymentLinkId ?? null,
    razorpayPaymentId: paymentId ?? null,
    reason: null,
  });

  console.log(
    `razorpay webhook: ${eventType} processed, requestId=${requestId} transitioned ${previousState ?? "null"} -> approved`,
  );
}

async function handleFailed(
  redis: WebhookRedisClient,
  requestId: string,
  paymentLinkId: string | undefined,
  paymentId: string | undefined,
  reason: string | undefined,
): Promise<void> {
  const previousState = await redis.get(requestStateKey(requestId));

  if (previousState && TERMINAL_STATES.has(previousState)) {
    console.log(
      `razorpay webhook: ignoring payment.failed for requestId=${requestId}, already in terminal state "${previousState}"`,
    );
    return;
  }

  await publishTransition(redis, requestId, "declined", previousState, {
    paymentLinkId: paymentLinkId ?? null,
    razorpayPaymentId: paymentId ?? null,
    reason: reason ?? null,
  });
}

/**
 * Returns an Express middleware handling Razorpay webhooks. `redis` is
 * caller-owned (see WebhookRedisClient). `webhookSecret` defaults to
 * RAZORPAY_WEBHOOK_SECRET but is overridable, primarily for tests.
 *
 * Never throws; every branch responds and returns. Malformed bodies, missing
 * signatures, unresolvable webhooks, and unrecognized event types all result
 * in a handled (non-500, non-crashing) response — see CLAUDE.md's edge-case
 * list in this module's spec.
 */
export function razorpayWebhookHandler(
  redis: WebhookRedisClient,
  webhookSecret: string | undefined = process.env.RAZORPAY_WEBHOOK_SECRET,
): RequestHandler {
  return (req: Request, res: Response): void => {
    void (async () => {
      const rawBody = req.body;
      if (!Buffer.isBuffer(rawBody)) {
        console.error(
          "razorpay webhook: req.body is not a raw Buffer — is express.raw({ type: \"application/json\" }) mounted before this handler?",
        );
        res.status(400).send("invalid request body");
        return;
      }

      if (!webhookSecret) {
        console.error("razorpay webhook: RAZORPAY_WEBHOOK_SECRET is not configured; rejecting webhook");
        res.status(400).send("webhook not configured");
        return;
      }

      const signatureHeader = req.header("X-Razorpay-Signature");
      if (!verifySignature(rawBody, signatureHeader, webhookSecret)) {
        console.error("razorpay webhook: signature verification failed");
        res.status(400).send("invalid signature");
        return;
      }

      let event: RazorpayWebhookEvent;
      try {
        event = JSON.parse(rawBody.toString("utf8")) as RazorpayWebhookEvent;
      } catch {
        console.error("razorpay webhook: malformed JSON body (signature was valid)");
        res.status(400).send("malformed body");
        return;
      }

      const eventType = event.event;
      const paymentLinkId = extractPaymentLinkId(event);
      const paymentId = extractPaymentId(event);

      // Log every received webhook regardless of resolution outcome, per this module's spec.
      console.log(`razorpay webhook received: event=${eventType ?? "unknown"} payment_link_id=${paymentLinkId ?? "none"}`);

      if (!eventType) {
        console.error("razorpay webhook: missing event type");
        res.status(400).send("malformed body");
        return;
      }

      try {
        const requestId = await resolveRequestId(redis, event);
        if (!requestId) {
          // Expired/stale Payment Link, or a payment_id we have no cached
          // mapping for. Per this module's edge cases: log and return 200,
          // do not error.
          console.log(
            `razorpay webhook: no matching in-flight request for event=${eventType} payment_link_id=${paymentLinkId ?? "none"} payment_id=${paymentId ?? "none"}`,
          );
          res.status(200).send("ok");
          return;
        }

        switch (eventType) {
          case "payment.captured":
          case "payment_link.paid":
            await handleCapturedOrPaid(redis, requestId, paymentLinkId, paymentId, eventType);
            break;
          case "payment.failed":
            await handleFailed(redis, requestId, paymentLinkId, paymentId, event.payload?.payment?.entity?.error_description);
            break;
          default:
            console.log(`razorpay webhook: unhandled event type "${eventType}", ignoring`);
        }

        res.status(200).send("ok");
      } catch (err) {
        // Redis (or any other) failure while processing a validated webhook.
        // Razorpay retries at-least-once on non-2xx, so failing loudly but
        // safely here (never crashing the process) is correct — a retry can
        // succeed once the transient failure clears.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`razorpay webhook: error processing event=${eventType}: ${message}`);
        res.status(500).send("internal error");
      }
    })();
  };
}
