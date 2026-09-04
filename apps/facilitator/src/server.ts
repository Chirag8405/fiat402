/**
 * The fiat402 facilitator's Express HTTP interface: POST /verify, POST
 * /settle, GET /supported, GET /reconciliation/:requestId, POST
 * /webhooks/razorpay, and the demo-hook POST
 * /internal/confirm-gate/:requestId.
 *
 * This module only wires together pieces that already exist:
 *   - ./policy/deterministic.ts        (Module 2 — final-authority policy gate)
 *   - ./policy/ai-advisory.ts          (Module 3 — advisory-only AI layer)
 *   - ./razorpay/{client,payment-links,webhook-handler}.ts (Module 4)
 *   - packages/scheme-upi/src/state-machine.ts, ./ws.ts, ./store/{redis,db}.ts (Module 5a)
 * It does not reimplement any of their logic — in particular, the bounded
 * pub/sub wait lives entirely in state-machine.ts's awaitResolution; this
 * file only calls it.
 *
 * Field names and response shapes follow x402-specification-v2.md section 7
 * (`/verify`, `/settle`, `/supported`) and CLAUDE.md's "x402 v2 wire format"
 * section exactly. Every /verify and /settle response is returned as
 * `res.status(200).json(...)` regardless of `isValid`/`success` — per the
 * spec, these are facilitator-internal APIs where the outcome is carried in
 * the JSON body's own fields, not the HTTP status code (see the example
 * "Error Response" blocks in section 7.1/7.2, which are plain 200 JSON
 * bodies with `isValid: false` / `success: false`).
 */

// Must be the first import: razorpay/client.ts and store/{db,redis}.ts read
// process.env at module top level (see their own top-level `export const`s),
// and ES module evaluation runs each imported module to completion, in
// import order, before this file's own body runs -- so ./load-env's
// dotenv.config() call has to be the first thing this dependency graph
// evaluates, not just textually the first statement.
import "./load-env";

import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { checkDeterministicPolicy, type VelocityRedisClient } from "./policy/deterministic";
import { getAdvisoryRecommendation } from "./policy/ai-advisory";
import { createUpiPaymentLink, cancelUpiPaymentLink } from "./razorpay/payment-links";
import { razorpayWebhookHandler, type WebhookRedisClient } from "./razorpay/webhook-handler";
import {
  deriveRequestId,
  createTrackedRequest,
  recordPaymentLinkCreated,
  transitionState,
  awaitResolution,
  requestPaymentLinkKey,
  requestMetaKey,
  type StateMachineRedisClient,
} from "../../../packages/scheme-upi/src/state-machine";
import { redisClient } from "./store/redis";
import { pgPool, writeReconciliationRecord, readReconciliationRecord, type PgClient, type ReconciliationRecord } from "./store/db";
import type { EventSubscription } from "./ws";
import { CONFIRM_GATE_CHANNEL, confirmGateKey, satisfyConfirmGate, declineConfirmGate, type ConfirmGateMessage } from "./confirm-gate";

/** This facilitator supports exactly one scheme/network pair. */
const SCHEME = "upi";
const NETWORK = "upi:in";

/** Same "+60" TTL buffer CLAUDE.md applies to every `req:{requestId}:*` key; see state-machine.ts's createTrackedRequest. */
const TTL_BUFFER_SECONDS = 60;

function isConfirmGateMessageLike(value: unknown): value is ConfirmGateMessage {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ConfirmGateMessage).requestId === "string" &&
    ((value as ConfirmGateMessage).decision === "confirm" || (value as ConfirmGateMessage).decision === "decline")
  );
}

/**
 * Bounded, pub/sub-driven wait for a human to flip confirm-gate:{requestId}
 * away from "0" -- to "1" (confirmed) via POST
 * /internal/confirm-gate/:requestId, by paying the Payment Link directly
 * (see ./confirm-gate.ts's satisfyConfirmGate, called from both that route
 * below and razorpay/webhook-handler.ts), or to "declined" (declined) via
 * POST /internal/decline/:requestId (see ./confirm-gate.ts's
 * declineConfirmGate and this file's own /internal/decline route below).
 * Structurally mirrors state-machine.ts's awaitResolution (setTimeout +
 * subscribe + a `finish` guard so only the first of the two ever settles the
 * promise), but is not built on top of it: this waits on a gate flip, not a
 * settlement state transition, and CONFIRM_GATE_CHANNEL is a separate
 * channel from fiat402:events for exactly that reason.
 *
 * NEVER rejects. POST /settle's route handler is `void (async () => {...})()`
 * with no top-level catch -- an unhandled rejection here would mean the HTTP
 * request never gets a response at all, which is strictly worse than a
 * clean settlementFailure. So every failure mode (redis.subscribe() throwing
 * synchronously, e.g. Redis unreachable; unsubscribe() failing during
 * cleanup; the defensive initial gate check below failing) is caught and
 * logged, never left to propagate, and resolves "timed-out" rather than
 * hanging or rejecting.
 *
 * The initial `redis.get(confirmGateKey(...))` check right after
 * subscribing closes the race where a human confirms/declines (and the
 * corresponding endpoint publishes) in the gap between this request creating
 * the Payment Link and this function's subscription becoming active:
 * redis.subscribe() registers the listener synchronously, so any publish
 * from that point on is still caught by it regardless; the
 * immediately-following get() only needs to catch a decision that landed
 * before subscribe() returned.
 */
async function awaitConfirmGate(
  redis: FacilitatorRedisClient,
  requestId: string,
  maxTimeoutSeconds: number,
): Promise<"confirmed" | "declined" | "timed-out"> {
  return new Promise<"confirmed" | "declined" | "timed-out">(resolve => {
    let settled = false;
    let unsubscribe: () => void = () => {};

    const finish = (result: "confirmed" | "declined" | "timed-out"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        unsubscribe();
      } catch (err) {
        console.error(
          `[awaitConfirmGate] unsubscribe failed for requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish("timed-out");
    }, maxTimeoutSeconds * 1000);

    try {
      const subscription = redis.subscribe([CONFIRM_GATE_CHANNEL]);
      unsubscribe = () => void subscription.unsubscribe();

      subscription.on("message", (message: unknown) => {
        let parsed: unknown = message;
        if (typeof message === "string") {
          try {
            parsed = JSON.parse(message);
          } catch (err) {
            console.error(
              `[awaitConfirmGate] JSON.parse failed for message on channel "${CONFIRM_GATE_CHANNEL}": ${err instanceof Error ? err.message : String(err)}`,
            );
            return;
          }
        }
        if (!isConfirmGateMessageLike(parsed) || parsed.requestId !== requestId) return;
        finish(parsed.decision === "decline" ? "declined" : "confirmed");
      });

      subscription.on("error", (err: unknown) => {
        // Logged, not finish()ed -- a transient subscription error doesn't
        // mean the decision was missed; the timeout above is the real
        // backstop, so this must not resolve early as anything but a
        // genuine decision or a genuine timeout.
        console.error(
          `[awaitConfirmGate] subscription error for requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      redis
        .get(confirmGateKey(requestId))
        .then(gate => {
          if (gate === "1") finish("confirmed");
          else if (gate === "declined") finish("declined");
        })
        .catch(err => {
          console.error(
            `[awaitConfirmGate] initial gate check failed for requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } catch (err) {
      console.error(
        `[awaitConfirmGate] redis.subscribe failed for requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      finish("timed-out");
    }
  });
}

/**
 * Bounded, pub/sub-driven wait for a human decline via POST
 * /internal/decline/:requestId (see ./confirm-gate.ts's declineConfirmGate),
 * independent of whether this request was ever a hold. Decline is valid on
 * ANY pending request (CLAUDE.md/plan: "not a new gate that blocks Payment
 * Link creation on every payment"), so unlike awaitConfirmGate this has no
 * "confirmed" outcome and is not gated behind `advisory.recommendation ===
 * "hold"` -- it races alongside `resolutionPromise` for every request,
 * approve or hold alike (see settlePayment).
 *
 * Deliberately does NOT reuse ./state-machine.ts's awaitResolution or its
 * "declined" FiatEvent state: that function intentionally ignores webhook-
 * published "declined" events (payment.failed) so a UPI retry can still
 * resolve as "approved" later -- see its own doc comment. A human-initiated
 * decline is a categorically different, final signal (a human actively
 * saying no, not a payment provider reporting an unretriable-yet failure)
 * and must NOT be filtered the same way, or it would never actually unblock
 * anything -- exactly the bug this function exists to avoid.
 *
 * Same never-rejects, catch-and-log-every-failure-mode contract as
 * awaitConfirmGate, for the same reason (no top-level catch in /settle's
 * route handler).
 */
async function awaitDeclineSignal(
  redis: FacilitatorRedisClient,
  requestId: string,
  maxTimeoutSeconds: number,
): Promise<"declined" | "timed-out"> {
  return new Promise<"declined" | "timed-out">(resolve => {
    let settled = false;
    let unsubscribe: () => void = () => {};

    const finish = (result: "declined" | "timed-out"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        unsubscribe();
      } catch (err) {
        console.error(
          `[awaitDeclineSignal] unsubscribe failed for requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish("timed-out");
    }, maxTimeoutSeconds * 1000);

    try {
      const subscription = redis.subscribe([CONFIRM_GATE_CHANNEL]);
      unsubscribe = () => void subscription.unsubscribe();

      subscription.on("message", (message: unknown) => {
        let parsed: unknown = message;
        if (typeof message === "string") {
          try {
            parsed = JSON.parse(message);
          } catch (err) {
            console.error(
              `[awaitDeclineSignal] JSON.parse failed for message on channel "${CONFIRM_GATE_CHANNEL}": ${err instanceof Error ? err.message : String(err)}`,
            );
            return;
          }
        }
        if (!isConfirmGateMessageLike(parsed) || parsed.requestId !== requestId || parsed.decision !== "decline") return;
        finish("declined");
      });

      subscription.on("error", (err: unknown) => {
        console.error(
          `[awaitDeclineSignal] subscription error for requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      redis
        .get(confirmGateKey(requestId))
        .then(gate => {
          if (gate === "declined") finish("declined");
        })
        .catch(err => {
          console.error(
            `[awaitDeclineSignal] initial gate check failed for requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } catch (err) {
      console.error(
        `[awaitDeclineSignal] redis.subscribe failed for requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      finish("timed-out");
    }
  });
}

/**
 * Pulls the agent-declared `agentMetadata` side-channel out of
 * `PaymentPayload.extensions` (see x402-upi-client/src/upi-scheme-client.ts
 * for how a client populates it) so it can be forwarded into
 * getAdvisoryRecommendation's context for the semanticMatch check. Absent or
 * malformed extensions just mean no agentMetadata is available -- the AI
 * advisory layer already treats a missing taskContext as "not provided" and
 * fails closed on ambiguity, so no extra validation is needed here.
 */
function extractAgentMetadata(paymentPayload: PaymentPayload): Record<string, unknown> | undefined {
  const extensions = (paymentPayload as { extensions?: Record<string, unknown> }).extensions;
  const agentMetadata = extensions?.agentMetadata;
  return agentMetadata && typeof agentMetadata === "object"
    ? (agentMetadata as Record<string, unknown>)
    : undefined;
}

/**
 * Full Redis surface every handler in this file needs: the state machine's
 * surface (state, meta, pub/sub), the velocity check's sorted-set surface,
 * and the webhook handler's surface. The real Upstash client
 * (./store/redis.ts) satisfies all three structurally as one object.
 */
export type FacilitatorRedisClient = StateMachineRedisClient & VelocityRedisClient & WebhookRedisClient;

export interface FacilitatorDeps {
  redis: FacilitatorRedisClient;
  pg: PgClient;
  /** Passed through to getAdvisoryRecommendation's context; defaults to the global fetch. Override in tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, threaded through to createTrackedRequest and Payment Link expiry math. Defaults to Date.now. */
  now?: () => number;
}

export interface SettlementResponseBody {
  success: boolean;
  errorReason?: string;
  payer?: string;
  /** Required; empty string when no transaction was broadcast — x402-specification-v2.md section 5.3.2. */
  transaction: string;
  network: string;
  amount?: string;
  extensions?: Record<string, unknown>;
}

export interface VerifyResponseBody {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  extra?: Record<string, unknown>;
}

/**
 * Caller-identity fields checkDeterministicPolicy's velocity check needs.
 * Express routes below derive these from the request (`req.ip`, the
 * `X-Agent-Identifier` header); an in-process caller (e.g. the merchant
 * resource server's self-facilitation middleware — see
 * apps/merchant/lib/x402-middleware.ts) has no Express `Request` to pull
 * them from, so it's a plain optional object instead.
 */
export interface FacilitatorCallContext {
  requestIp?: string;
  agentHeader?: string;
}

/**
 * Every failure path in /settle returns `transaction: ""` — per
 * x402-specification-v2.md section 5.3.2: "empty string if no transaction
 * was broadcast". None of this facilitator's failure paths ever broadcast
 * anything (Razorpay either never got called, or its Payment Link never
 * captured a payment), so this is always correct for a failure response.
 */
function settlementFailure(errorReason: string, amount?: string): SettlementResponseBody {
  return { success: false, errorReason, transaction: "", network: NETWORK, ...(amount ? { amount } : {}) };
}

function extractTxnRef(payload: PaymentPayload | undefined): string | null {
  const raw =
    payload && typeof payload === "object" && payload.payload && typeof payload.payload === "object"
      ? (payload.payload as { txnRef?: unknown }).txnRef
      : undefined;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function extractDescription(requirements: PaymentRequirements | undefined): string {
  const extra = requirements?.extra as { description?: unknown } | undefined;
  return typeof extra?.description === "string" && extra.description.length > 0
    ? extra.description
    : "x402 upi payment";
}

/**
 * Builds an Express app wired to the given dependencies. Kept as a factory
 * (rather than a module-level `app`) so integration tests can inject fake
 * Redis/Postgres/fetch instead of the real Upstash/pg/network clients this
 * file constructs at the bottom for actual runtime use.
 */
/**
 * Runs the deterministic policy engine + AI advisory layer and produces a
 * `VerifyResponse` (x402-specification-v2.md section 5.4) for the given
 * payload/requirements pair. This is the exact logic the `/verify` HTTP
 * route below executes — extracted so an in-process caller (the merchant
 * resource server's self-facilitation middleware) can call it directly as a
 * function, per the self-facilitation pattern in
 * https://github.com/x402-foundation/x402/blob/230e6a9a7eebce22c911a0687d6f4e6d1ac019f7/examples/typescript/servers/self-facilitation/README.md:
 * no HTTP hop within the same process, no second Express instance.
 */
export async function verifyPayment(
  deps: FacilitatorDeps,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  ctx: FacilitatorCallContext = {},
): Promise<VerifyResponseBody> {
  // Per x402-specification-v2.md, this facilitator only understands x402
  // v2 wire format -- reject anything else before running any policy or
  // AI logic, rather than guessing at an incompatible payload shape.
  if (paymentPayload?.x402Version !== 2) {
    return { isValid: false, invalidReason: "unsupported x402Version" };
  }

  const now = deps.now ?? Date.now;

  const policyResult = await checkDeterministicPolicy(paymentRequirements, paymentPayload, {
    redis: deps.redis,
    requestIp: ctx.requestIp,
    agentHeader: ctx.agentHeader,
    now,
  });

  if (!policyResult.allowed) {
    return { isValid: false, invalidReason: policyResult.reason };
  }

  const advisory = await getAdvisoryRecommendation(paymentRequirements, paymentPayload, {
    fetchImpl: deps.fetchImpl,
    agentMetadata: extractAgentMetadata(paymentPayload),
  });

  // isValid is always true once the deterministic engine passes,
  // regardless of the AI recommendation. Per CLAUDE.md: "AI output goes
  // in extra, never overrides isValid downward at this stage." AI
  // advisory only affects /settle (the confirm-gate hold flow below) —
  // /verify's validity is gated exclusively by the deterministic policy
  // engine, which is final authority.
  return {
    isValid: true,
    extra: {
      aiRecommendation: advisory.recommendation,
      aiSemanticMatch: advisory.semanticMatch,
      aiReasoning: advisory.reasoning,
      aiHumanSummary: advisory.humanSummary,
      aiProvider: advisory.provider,
    },
  };
}

/**
 * Runs the full /settle flow (policy re-check, AI advisory + confirm-gate,
 * Payment Link creation/idempotency, bounded pub/sub wait, reconciliation
 * write) and produces a `SettlementResponse`
 * (x402-specification-v2.md section 5.3). Extracted for the same
 * self-facilitation, in-process-call reason as verifyPayment above.
 */
export async function settlePayment(
  deps: FacilitatorDeps,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  ctx: FacilitatorCallContext = {},
): Promise<SettlementResponseBody> {
  // Same x402Version guard as verifyPayment above -- reject before any
  // policy/AI/Razorpay work runs.
  if (paymentPayload?.x402Version !== 2) {
    return settlementFailure("unsupported x402Version");
  }

  const now = deps.now ?? Date.now;

  // 1. Re-run the deterministic policy engine. Never trust a prior
  // /verify call alone -- state (velocity, allowlist config) may have
  // changed since then, and a client could call /settle directly.
  const policyResult = await checkDeterministicPolicy(paymentRequirements, paymentPayload, {
    redis: deps.redis,
    requestIp: ctx.requestIp,
    agentHeader: ctx.agentHeader,
    now,
  });

  if (!policyResult.allowed) {
    return settlementFailure(policyResult.reason ?? "deterministic policy rejected");
  }

  // requestId derivation is a pure function of (requirements, payload) --
  // no Redis I/O -- so it's safe to compute up front and reuse for the
  // confirm-gate check below and every subsequent step.
  const requestId = deriveRequestId(paymentRequirements, paymentPayload);

  // 2. AI advisory. "hold" adds friction -- a human must confirm via
  // POST /internal/confirm-gate/:requestId before the bounded wait below
  // lets this call proceed -- but it must NOT block the request from ever
  // reaching a payable state: the Payment Link is still created below
  // regardless, so there's something for a human to actually approve.
  const advisory = await getAdvisoryRecommendation(paymentRequirements, paymentPayload, {
    fetchImpl: deps.fetchImpl,
    agentMetadata: extractAgentMetadata(paymentPayload),
  });

  if (advisory.recommendation === "hold") {
    // Only initialize to "0" if not already "1" -- a blind SET here could
    // otherwise clobber a confirmation a human already recorded in the gap
    // between that action and this check (e.g. a very fast manual confirm,
    // or one from a concurrent /settle call that reached this point first).
    const existingGate = await deps.redis.get(confirmGateKey(requestId));
    if (existingGate !== "1") {
      await deps.redis.set(confirmGateKey(requestId), "0");
      await deps.redis.expire(confirmGateKey(requestId), paymentRequirements.maxTimeoutSeconds + TTL_BUFFER_SECONDS);
    }
  }

  // 3. Idempotency: if a Payment Link already exists for this
  // requestId, this is a concurrent /settle call for the same logical
  // request. Join the existing in-flight resolution instead of creating
  // a second Payment Link.
  const existingPaymentLinkId = await deps.redis.get(requestPaymentLinkKey(requestId));
  let paymentLinkId: string;
  // Only set when *this* call performs the created->pending transition
  // below; a concurrent /settle call that joins an already-in-flight
  // request (the `existingPaymentLinkId` branch) has no visibility into
  // when the original call entered "pending" -- req:{requestId}:meta
  // never stores that timestamp, only transitionState's return value does.
  let pendingAt: string | null = null;

  if (existingPaymentLinkId) {
    paymentLinkId = existingPaymentLinkId;
  } else {
    // 4. Create the Payment Link, then record it. Both Redis writes
    // (createTrackedRequest's state/meta + recordPaymentLinkCreated's
    // forward/reverse keys) happen in one try block: if either fails,
    // we must not transition to "pending" with a half-recorded request.
    const amountPaise = Number(paymentRequirements.amount);
    const maxTimeoutSeconds = paymentRequirements.maxTimeoutSeconds ?? 90;
    const RAZORPAY_MIN_EXPIRY_SECONDS = 16 * 60; // Razorpay requires minimum 15 minutes
    const expiryUnixTs = Math.floor(Date.now() / 1000) + Math.max(maxTimeoutSeconds, RAZORPAY_MIN_EXPIRY_SECONDS);
    const linkResult = await createUpiPaymentLink(
      amountPaise,
      extractDescription(paymentRequirements),
      expiryUnixTs,
      process.env.DEMO_NOTIFY_PHONE, // optional — enables SMS notification for demo purposes
    );

    if (!linkResult.ok) {
      return settlementFailure("payment-link-creation-failed");
    }

    try {
      await createTrackedRequest(deps.redis, paymentRequirements, paymentPayload, now);
      await recordPaymentLinkCreated(
        deps.redis,
        requestId,
        linkResult.paymentLinkId,
        paymentRequirements.maxTimeoutSeconds + TTL_BUFFER_SECONDS,
      );
    } catch {
      return settlementFailure("payment-link-creation-failed");
    }

    paymentLinkId = linkResult.paymentLinkId;
    const pendingEvent = await transitionState(deps.redis, requestId, "pending", { paymentLinkId }, {
      // FiatEvent (./ws.ts) deliberately keeps the "approve"|"hold"
      // vocabulary for aiRecommendation -- see that file's doc comment on
      // the field for why this translation is a permanent compatibility
      // shim (dashboard UI already keys off "approve"), not a stopgap.
      aiRecommendation: advisory.recommendation === "proceed" ? "approve" : "hold",
      aiSemanticMatch: advisory.semanticMatch,
      // aiJustification is kept for existing dashboard call sites;
      // aiHumanSummary carries the same content under the new field name.
      // aiReasoning is the separate, technical/log-facing string -- not
      // collapsed into either of the human-facing fields above.
      aiJustification: advisory.humanSummary,
      aiHumanSummary: advisory.humanSummary,
      aiReasoning: advisory.reasoning,
      aiProvider: advisory.provider,
      // Always "allowed" here: an earlier `!policyResult.allowed` already
      // returned above, so reaching this line means the deterministic
      // engine passed.
      deterministicDecision: "allowed",
      deterministicReason: policyResult.reason,
    });
    pendingAt = pendingEvent.timestamp;
  }

  // 5. Start the bounded, pub/sub-driven payment wait NOW, before the
  // confirm-gate wait below -- not after it. webhook-handler.ts's
  // handleCapturedOrPaid publishes the "approved" event to fiat402:events
  // BEFORE it calls satisfyConfirmGate (which publishes to
  // fiat402:confirm-gate): paying the Payment Link directly can arrive at
  // any point from here on, including during the confirm-gate wait, and if
  // awaitResolution isn't already subscribed by then, that "approved" event
  // is published to nobody and is gone for good -- awaitResolution would
  // then subscribe too late and ride out its own full timeout regardless of
  // whether the payment actually succeeded. Calling awaitResolution here
  // (not awaiting it yet) guarantees its subscription is live before
  // awaitConfirmGate's below even starts, since the synchronous portion of
  // this call (including subscribeToEvents' redis.subscribe()) completes
  // before the next line runs. Delegated entirely to state-machine.ts's
  // awaitResolution, not reimplemented here as a poll loop; see that
  // function's doc comment for why (the UPI retry edge case).
  const resolutionPromise = awaitResolution(deps.redis, requestId, paymentRequirements.maxTimeoutSeconds);

  // Decline is valid on ANY pending request (approve or hold), not just a
  // gate a hold sits behind -- so this is created here, immediately
  // alongside resolutionPromise and for the same subscription-ordering
  // reason documented on it above: a decline sent in the gap before this
  // subscribes would otherwise be published to nobody and lost for good.
  // Covers the window where this request has no hold at all, or already
  // passed its confirm-gate and is now just waiting on the payer -- the
  // *other* window (a hold still unconfirmed) is covered by
  // awaitConfirmGate itself below, which understands "declined" directly
  // since it's listening on the very same channel.
  const declineWaitPromise = awaitDeclineSignal(deps.redis, requestId, paymentRequirements.maxTimeoutSeconds);

  // Hoisted from just after the resolution wait (where it used to live) so
  // the ai-hold-timed-out branch below can also write a reconciliation
  // record -- every other terminal transition in this function does, and an
  // AI-hold timeout shouldn't be the one silent exception to that audit
  // trail. Doesn't depend on `resolution` at all, so moving it earlier
  // changes nothing about when it's computed relative to the actual
  // Payment Link / policy / advisory data it reads -- all of that already
  // exists by this point. Also doesn't delay awaitResolution's subscription
  // above: that already happened synchronously when resolutionPromise was
  // created, one line up.
  const meta = await deps.redis.hgetall(requestMetaKey(requestId));
  const baseRecord: Omit<ReconciliationRecord, "razorpayPaymentId" | "resolvedAt" | "settledAt" | "failedAt" | "finalOutcome"> = {
    requestId,
    txnRef: extractTxnRef(paymentPayload),
    paymentLinkId,
    amountPaise: paymentRequirements.amount,
    payTo: paymentRequirements.payTo,
    deterministicDecision: policyResult.allowed,
    deterministicReason: policyResult.reason ?? null,
    aiRecommendation: advisory.recommendation,
    aiJustification: advisory.humanSummary,
    aiProvider: advisory.provider,
    createdAt: meta?.createdAt ?? new Date(now()).toISOString(),
    pendingAt,
  };

  // Shared terminal-failure bookkeeping for every path below that ends the
  // request without a successful settlement while a live Payment Link still
  // exists: publish the payer-outcome intermediate state (never skip
  // straight from "pending" to "failed" -- the rail's whole point is
  // showing that step), then transition to "failed" (writing `reason` so
  // the dashboard/reconciliation record can distinguish *why* --
  // ai-hold-timed-out, a plain payer timeout, or a human decline, never a
  // collapsed generic "expired"), write the audit record, and best-effort
  // cancel the Payment Link. Extracted because ai-hold-timed-out and both
  // human-decline windows below all need exactly this, byte-for-byte --
  // previously duplicated ai-hold-timed-out's version verbatim would have
  // been the second copy.
  //
  // The two transitionState calls below are sequential awaits within this
  // same function -- one writer, not two independent publishers racing (see
  // webhook-handler.ts's "approved" vs this file's "settled", the actual
  // race the dashboard's events-route fix was built around). The second
  // call's redis.set/publish/lpush/ltrim sequence cannot begin until the
  // first one's has fully resolved, so there is no possibility of the
  // "failed" event's LPUSH landing before the intermediate's.
  async function finalizeCancelledFailure(intermediateState: "declined" | "expired", reason: string): Promise<SettlementResponseBody> {
    await transitionState(deps.redis, requestId, intermediateState, { paymentLinkId, reason });

    const failedEvent = await transitionState(deps.redis, requestId, "failed", {
      paymentLinkId,
      reason,
    });

    await writeReconciliationRecord(deps.pg, {
      ...baseRecord,
      razorpayPaymentId: null,
      resolvedAt: failedEvent.timestamp,
      settledAt: null,
      failedAt: failedEvent.timestamp,
      finalOutcome: "failed",
    });

    // Best-effort: expire_by alone isn't enough here -- Razorpay enforces a
    // minimum 15-minute Payment Link lifetime (see RAZORPAY_MIN_EXPIRY_SECONDS
    // above), so a request with a short maxTimeoutSeconds like this one
    // leaves the real Payment Link payable for up to ~14 more minutes after
    // we've already marked it "failed" -- during which a late payment would
    // be silently dropped by webhook-handler.ts's terminal-state check
    // (money moves, nothing reconciles it). Actively cancelling closes that
    // window now instead of waiting on expire_by. A cancel failure (e.g. the
    // payer completed payment in the instant before this call -- a genuine,
    // small race) is logged, not treated as a reason to change the response.
    const cancelResult = await cancelUpiPaymentLink(paymentLinkId);
    if (!cancelResult.ok) {
      console.error(
        `[settlePayment] failed to cancel Payment Link ${paymentLinkId} after ${reason} for requestId=${requestId}: ${cancelResult.errorDescription}`,
      );
    }

    return settlementFailure(reason);
  }

  // 6. AI-hold confirmation gate. Runs after the Payment Link exists
  // (created above, or joined via the idempotency branch) so a human has
  // something real to review/approve -- this is exactly the gap the old
  // short-circuit-before-any-Payment-Link-exists behavior left open. Bounded
  // by the same maxTimeoutSeconds as the payment wait above; a timeout here
  // is a clean settlementFailure, not a hang -- see awaitConfirmGate's doc
  // comment for the full failure-mode reasoning. awaitConfirmGate also
  // directly understands a human decline sent while the hold is still
  // unconfirmed (same channel, see ./confirm-gate.ts's declineConfirmGate) --
  // the *other* decline window, after confirmation or for a plain "approve"
  // recommendation with no hold at all, is covered below via declineWaitPromise.
  //
  // resolutionPromise/declineWaitPromise above are left running in the
  // background if this branch returns early (hold never confirmed) -- neither
  // exposes a cancellation handle, so their subscriptions/timers just ride
  // out their own remaining window and self-clean; this has no effect on the
  // HTTP response, which has already been sent by then, and Redis's own
  // req:{requestId}:* TTLs clean up regardless.
  if (advisory.recommendation === "hold") {
    const gateResult = await awaitConfirmGate(deps.redis, requestId, paymentRequirements.maxTimeoutSeconds);
    if (gateResult === "declined") return finalizeCancelledFailure("declined", "human-declined");
    if (gateResult === "timed-out") return finalizeCancelledFailure("expired", "ai-hold-timed-out");
    // gateResult === "confirmed" -- fall through to the payer-approval wait below.
  }

  // Races the normal payer-approval wait against a human decline arriving
  // during THIS window (post-confirm, or a plain "approve" recommendation
  // that never went through the gate above at all). declineWaitPromise's own
  // "timed-out" outcome is deliberately neutralized to never resolve this
  // race -- resolutionPromise's own timeout (-> "expired" below) is already
  // the correct backstop for "nobody decided anything in time," and letting
  // both timeouts race here would just be two clocks for the same ceiling
  // with no behavioral difference, at the cost of a messier result shape.
  const humanDeclinePromise: Promise<"human-declined"> = declineWaitPromise.then(
    outcome => (outcome === "declined" ? "human-declined" : new Promise<never>(() => {})),
  );

  const resolution = await Promise.race([resolutionPromise, humanDeclinePromise]);

  if (resolution === "human-declined") return finalizeCancelledFailure("declined", "human-declined");

  if (resolution.state === "approved") {
    const razorpayPaymentId = resolution.event?.meta.razorpayPaymentId ?? null;
    const settledEvent = await transitionState(deps.redis, requestId, "settled", {
      paymentLinkId,
      razorpayPaymentId,
    });

    await writeReconciliationRecord(deps.pg, {
      ...baseRecord,
      razorpayPaymentId,
      resolvedAt: resolution.event?.timestamp ?? settledEvent.timestamp,
      settledAt: settledEvent.timestamp,
      failedAt: null,
      finalOutcome: "settled",
    });

    return {
      success: true,
      transaction: razorpayPaymentId ?? "",
      network: NETWORK,
      amount: paymentRequirements.amount,
    };
  }

  // resolution.state is "declined" or "expired" here -- both mean "return 402" to the caller.
  // In practice this is always "expired": awaitResolution (state-machine.ts)
  // never itself resolves with "declined" (that value is intentionally
  // ignored there, per its own doc comment, to support the UPI retry case)
  // -- the "payment-declined" half of this ternary is unreachable today.
  const errorReason = resolution.state === "expired" ? "timeout" : "payment-declined";

  // Publish the payer-outcome step before the terminal one: awaitResolution's
  // own "expired" outcome is never itself published (see that function's doc
  // comment) -- without this, the rail jumped straight from "pending" to
  // "failed". Sequential await within this same function, same one-writer
  // reasoning as finalizeCancelledFailure above -- not the LPUSH-ordering
  // race between two independent publishers that the events-route fix
  // addressed.
  await transitionState(deps.redis, requestId, "expired", { paymentLinkId, reason: errorReason });

  const failedEvent = await transitionState(deps.redis, requestId, "failed", {
    paymentLinkId,
    reason: errorReason,
  });

  await writeReconciliationRecord(deps.pg, {
    ...baseRecord,
    razorpayPaymentId: resolution.event?.meta.razorpayPaymentId ?? null,
    resolvedAt: resolution.event?.timestamp ?? failedEvent.timestamp,
    settledAt: null,
    failedAt: failedEvent.timestamp,
    finalOutcome: "failed",
  });

  // The timeout case (errorReason === "timeout") reaches this exact same
  // response path as a genuine decline -- awaitResolution already
  // enforced the hard maxTimeoutSeconds ceiling, so by the time we get
  // here this is just a normal, bounded HTTP response, never a hung
  // connection.
  //
  // FLAGGED FOLLOW-UP, not fixed here: this "timeout" outcome has the same
  // expire_by-vs-16-minute-floor gap as the ai-hold-timed-out branch above
  // (see cancelUpiPaymentLink's doc comment in ./razorpay/payment-links.ts)
  // -- the Payment Link is left to expire on its own rather than actively
  // cancelled, so it stays payable for up to ~14 more minutes after this
  // request is already marked "failed" here, and a late payment during
  // that window is silently dropped by webhook-handler.ts's terminal-state
  // check. Left alone for this session; worth the same active-cancel fix
  // in a future one.
  return settlementFailure(errorReason);
}

/**
 * Resolves the `origin` option for the `cors` middleware from
 * ALLOWED_ORIGINS (comma-separated), defaulting to "*" outside production.
 * In production with ALLOWED_ORIGINS unset, resolves to an empty allowlist
 * (blocks all cross-origin requests) rather than silently defaulting to "*"
 * -- an open CORS policy should be an explicit choice in production, not an
 * accidental default.
 */
function resolveCorsOrigin(): string | string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (raw && raw.trim().length > 0) {
    return raw
      .split(",")
      .map(origin => origin.trim())
      .filter(origin => origin.length > 0);
  }
  return process.env.NODE_ENV === "production" ? [] : "*";
}

export function createServer(deps: FacilitatorDeps): Express {
  const app = express();

  // Behind a reverse proxy (Render, Railway, etc.) req.ip otherwise returns
  // the proxy's own IP for every request, not the real client's -- which
  // would make the velocity check's agent identifier (see
  // ./policy/deterministic.ts's buildAgentIdentifier) collapse every caller
  // behind the proxy into one bucket. `1` trusts exactly one hop (the
  // reverse proxy itself), reading the real client IP from the first entry
  // of X-Forwarded-For.
  app.set("trust proxy", 1);

  // --- Razorpay webhooks ---------------------------------------------------
  //
  // MUST be mounted before app.use(cors(...)) and app.use(express.json())
  // below, and MUST NOT have CORS applied -- Razorpay's servers call this
  // endpoint directly, not a browser, so it must remain origin-unrestricted.
  // Signature verification in razorpayWebhookHandler needs the raw,
  // untouched request bytes (see that file's top-of-file comment);
  // express.raw() here gives it exactly that, and because this route is
  // matched and its handler sends a response before the request stack ever
  // reaches the middleware mounted below, that body is never re-parsed as
  // JSON and never passes through the CORS layer.
  app.post("/webhooks/razorpay", express.raw({ type: "application/json" }), razorpayWebhookHandler(deps.redis));

  app.use(
    cors({
      origin: resolveCorsOrigin(),
      methods: ["GET", "POST"],
      allowedHeaders: ["Content-Type", "X-Razorpay-Signature"],
    }),
  );

  // Every route below this line receives a JSON-parsed body.
  app.use(express.json());

  // --- GET /health ---------------------------------------------------------
  app.get("/health", (_req: Request, res: Response): void => {
    void (async () => {
      const requiredEnvVars = ["RAZORPAY_KEY_ID", "UPSTASH_REDIS_REST_URL", "DATABASE_URL"];
      const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);

      const result: Record<string, string> = { redis: "ok", postgres: "ok" };
      let healthy = missingEnvVars.length === 0;
      if (missingEnvVars.length > 0) {
        result.env = `missing: ${missingEnvVars.join(", ")}`;
      }

      try {
        // FacilitatorRedisClient has no PING command in its surface (it's
        // the minimal set every handler in this file needs); GET is an
        // equally lightweight connectivity probe and never throws on a
        // missing key, only on a real connection failure.
        await deps.redis.get("__health_check__");
      } catch (error) {
        healthy = false;
        result.redis = `error: ${error instanceof Error ? error.message : String(error)}`;
      }

      try {
        await deps.pg.query("SELECT 1");
      } catch (error) {
        healthy = false;
        result.postgres = `error: ${error instanceof Error ? error.message : String(error)}`;
      }

      res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", ...result });
    })();
  });

  // --- POST /verify ---------------------------------------------------------
  app.post("/verify", (req: Request, res: Response): void => {
    void (async () => {
      const body = (req.body ?? {}) as { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements };
      const response = await verifyPayment(deps, body.paymentPayload as PaymentPayload, body.paymentRequirements as PaymentRequirements, {
        requestIp: req.ip,
        agentHeader: req.header("X-Agent-Identifier") ?? undefined,
      });
      res.status(200).json(response);
    })();
  });

  // --- POST /settle -----------------------------------------------------
  app.post("/settle", (req: Request, res: Response): void => {
    void (async () => {
      const body = (req.body ?? {}) as { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements };
      const response = await settlePayment(deps, body.paymentPayload as PaymentPayload, body.paymentRequirements as PaymentRequirements, {
        requestIp: req.ip,
        agentHeader: req.header("X-Agent-Identifier") ?? undefined,
      });
      res.status(200).json(response);
    })();
  });

  // --- GET /supported ---------------------------------------------------
  app.get("/supported", (_req: Request, res: Response): void => {
    res.status(200).json({
      kinds: [{ x402Version: 2, scheme: SCHEME, network: NETWORK }],
      extensions: [],
      signers: {},
    });
  });

  // --- GET /reconciliation/:requestId ------------------------------------
  //
  // Read-only lookup of the durable audit trail written by
  // writeReconciliationRecord once a request reaches a terminal outcome
  // (settled|failed). Exists because the dashboard's live event stream
  // (fiat402:events / fiat402:events:recent) is a rolling, bounded buffer:
  // once the "pending" event carrying aiRecommendation/aiSemanticMatch/etc.
  // scrolls out of that window, the dashboard has no other way to recover
  // it -- see apps/dashboard/app/api/reconciliation/[requestId]/route.ts,
  // which proxies to this route. Unauthenticated, matching /supported: this
  // exposes the same fields /verify's response body and the public
  // fiat402:events stream already expose today, not a new class of data.
  app.get("/reconciliation/:requestId", (req: Request, res: Response): void => {
    void (async () => {
      const record = await readReconciliationRecord(deps.pg, String(req.params.requestId));
      if (!record) {
        res.status(404).json({ error: "no reconciliation record for this requestId" });
        return;
      }
      res.status(200).json(record);
    })();
  });

  // --- POST /internal/confirm-gate/:requestId ----------------------------
  //
  // Demo hook only. A real deployment would have a review UI that sets this
  // flag once a human has reviewed an AI hold/flag recommendation; this
  // endpoint is a stand-in for that UI's backend action.
  //
  // Guarded by a shared secret (CONFIRM_GATE_SECRET) since it lets any
  // caller unblock a held/flagged settlement. If unset, this still serves
  // the route unauthenticated for demo convenience -- the startup warning
  // below is the signal that a production deployment must set it.
  if (!process.env.CONFIRM_GATE_SECRET) {
    console.warn("CONFIRM_GATE_SECRET not set — /internal/confirm-gate is unauthenticated");
  }
  app.post("/internal/confirm-gate/:requestId", (req: Request, res: Response): void => {
    void (async () => {
      const secret = process.env.CONFIRM_GATE_SECRET;
      if (secret) {
        const authHeader = req.header("Authorization");
        if (authHeader !== `Bearer ${secret}`) {
          res.status(401).send("unauthorized");
          return;
        }
      }
      const requestId = String(req.params.requestId);
      // See ./confirm-gate.ts's satisfyConfirmGate: also called from
      // razorpay/webhook-handler.ts when a Payment Link is paid directly,
      // so both ways a human can decide to let a held request proceed stay
      // in lockstep on the same set+publish logic.
      await satisfyConfirmGate(deps.redis, requestId);
      res.status(200).send("ok");
    })();
  });

  // --- POST /internal/decline/:requestId ----------------------------------
  //
  // Symmetric to /internal/confirm-gate above, but the opposite decision: a
  // human actively declining a request, available on ANY pending request
  // (approve or hold recommendation) -- not a new gate that blocks Payment
  // Link creation on every payment, and not exclusive to holds the way
  // confirm-gate is. Same auth posture as /internal/confirm-gate
  // (CONFIRM_GATE_SECRET), since it's the same class of action: any caller
  // can unblock/redirect a live settlement.
  //
  // This route itself does no state-writing beyond publishing the decline
  // signal (declineConfirmGate) -- the actual "failed" transition,
  // reconciliation write, and Payment Link cancellation all happen inside
  // the already-running settlePayment call that observes this signal (see
  // awaitConfirmGate/awaitDeclineSignal/finalizeCancelledFailure above),
  // exactly mirroring how satisfyConfirmGate never writes state directly
  // either. Avoids two independent writers racing on the same terminal
  // transition. "pending" state only exists while a settlePayment call is
  // actually alive and waiting (no persisted "pending but orphaned" state in
  // this design), so there's always something listening -- same assumption
  // confirm-gate already relies on. A decline for a request that already
  // resolved is a harmless no-op publish (nothing subscribed), same
  // reasoning already documented on satisfyConfirmGate.
  app.post("/internal/decline/:requestId", (req: Request, res: Response): void => {
    void (async () => {
      const secret = process.env.CONFIRM_GATE_SECRET;
      if (secret) {
        const authHeader = req.header("Authorization");
        if (authHeader !== `Bearer ${secret}`) {
          res.status(401).send("unauthorized");
          return;
        }
      }
      const requestId = String(req.params.requestId);
      await declineConfirmGate(deps.redis, requestId);
      res.status(200).send("ok");
    })();
  });

  return app;
}

/**
 * Adapts ./store/redis.ts's raw @upstash/redis client to this file's
 * FacilitatorRedisClient surface. This adapter is purely a wiring concern
 * for the real-deployment entrypoint below -- tests construct their own
 * fakes directly against FacilitatorRedisClient and never go through it.
 *
 * The only non-mechanical bit is `subscribe`: @upstash/redis's
 * `subscribe(...)` returns an EventTarget-style emitter whose "message"
 * listener receives a single `{ channel, message }` object (confirmed by
 * reading node_modules/@upstash/redis's type declarations), not the
 * `(message, channel)` two-argument shape ./ws.ts's EventSubscription
 * declares -- this bridges that difference.
 */
export function adaptUpstashClient(client: typeof redisClient): FacilitatorRedisClient {
  return {
    get: key => client.get<string>(key),
    set: (key, value, mode) => client.set(key, value, mode === "KEEPTTL" ? { keepTtl: true } : undefined),
    expire: (key, seconds) => client.expire(key, seconds),
    hset: (key, fields) => client.hset(key, fields),
    hgetall: key => client.hgetall<Record<string, string>>(key),
    publish: (channel, message) => client.publish(channel, message),
    lpush: (key, ...values) => client.lpush(key, ...values),
    ltrim: (key, start, stop) => client.ltrim(key, start, stop),
    zadd: (key, score, member) => client.zadd(key, { score, member }).then(result => result ?? 0),
    zremrangebyscore: (key, min, max) => client.zremrangebyscore(key, min as number, max as number),
    zcard: key => client.zcard(key),
    subscribe: (channels: string[]): EventSubscription => {
      // No <string> type param here (and never `<unknown>` either, for the
      // same reason): the SDK auto-deserializes SSE message payloads by
      // default (Subscriber<TMessage = any>; automaticDeserialization is
      // never disabled anywhere in this codebase), so a subscribed
      // message's real runtime type is whatever the published JSON parses
      // to -- usually an object, per ./ws.ts's FiatEvent -- not a string.
      // An explicit `<string>` here previously asserted that false premise
      // at compile time, which is exactly what let ./ws.ts's
      // subscribeToEvents redundantly re-JSON.parse an already-parsed
      // object (throwing, silently) go unnoticed. Leaving TMessage
      // unspecified (SDK default `any`) rather than lying with a narrower
      // type; ./ws.ts's EventSubscription.on("message", ...) declares the
      // honest type (`unknown`) that callers actually have to narrow.
      const subscriber = client.subscribe(channels);
      return {
        on: (event: "message" | "error", listener: (...args: never[]) => void) => {
          if (event === "message") {
            subscriber.on("message", (data: { channel: string; message: unknown }) => {
              (listener as (message: unknown, channel: string) => void)(data.message, data.channel);
            });
          } else {
            subscriber.on("error", listener as (error: unknown) => void);
          }
        },
        unsubscribe: () => subscriber.unsubscribe(),
      };
    },
  };
}

// --- Real-deployment entrypoint -----------------------------------------
//
// Only runs when this file is executed directly (`node server.js` /
// `tsx server.ts`), not when imported by tests via createServer(deps).
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createServer({ redis: adaptUpstashClient(redisClient), pg: pgPool });
  const port = Number(process.env.PORT ?? 4021);
  app.listen(port, () => {
    console.log(`fiat402 facilitator listening at http://localhost:${port}`);
  });
}
