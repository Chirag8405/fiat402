/**
 * The fiat402 facilitator's Express HTTP interface: POST /verify, POST
 * /settle, GET /supported, POST /webhooks/razorpay, and the demo-hook
 * POST /internal/confirm-gate/:requestId.
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
import { createUpiPaymentLink } from "./razorpay/payment-links";
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
import { pgPool, writeReconciliationRecord, type PgClient, type ReconciliationRecord } from "./store/db";
import type { EventSubscription } from "./ws";

/** This facilitator supports exactly one scheme/network pair. */
const SCHEME = "upi";
const NETWORK = "upi:in";

/** Same "+60" TTL buffer CLAUDE.md applies to every `req:{requestId}:*` key; see state-machine.ts's createTrackedRequest. */
const TTL_BUFFER_SECONDS = 60;

/**
 * `confirm-gate:{requestId}` — the demo-hook confirmation flag from
 * CLAUDE.md's Redis key schema section. Owned by this module (not
 * state-machine.ts): it's part of /settle's AI-hold flow, not the core
 * request lifecycle those key builders cover.
 */
function confirmGateKey(requestId: string): string {
  return `confirm-gate:${requestId}`;
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
 * x402-reference/examples/typescript/servers/self-facilitation/README.md:
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
  });

  // isValid is always true once the deterministic engine passes,
  // regardless of the AI recommendation. Per CLAUDE.md: "AI output goes
  // in extra, never overrides isValid downward at this stage." AI
  // advisory only affects /settle (the confirm-gate hold/flag flow
  // below) — /verify's validity is gated exclusively by the
  // deterministic policy engine, which is final authority.
  return {
    isValid: true,
    extra: {
      aiRecommendation: advisory.recommendation,
      aiJustification: advisory.justification,
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

  // 2. AI advisory. "hold"/"flag" require the demo confirm-gate to
  // already be set before this facilitator will create a Payment Link.
  const advisory = await getAdvisoryRecommendation(paymentRequirements, paymentPayload, {
    fetchImpl: deps.fetchImpl,
  });

  if (advisory.recommendation === "hold" || advisory.recommendation === "flag") {
    const gate = await deps.redis.get(confirmGateKey(requestId));
    if (gate !== "1") {
      // Demo hook: a real deployment would have a review UI that sets
      // this flag once a human has reviewed the hold/flag. Here it's set
      // via POST /internal/confirm-gate/:requestId below. We do not
      // block waiting for it -- an unset gate is a clean, immediate
      // rejection, not a hung request.
      return settlementFailure("ai-hold-pending-review");
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
    const expiryUnixTs = Math.floor(now() / 1000) + paymentRequirements.maxTimeoutSeconds;
    const linkResult = await createUpiPaymentLink(amountPaise, extractDescription(paymentRequirements), expiryUnixTs);

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
      aiRecommendation: advisory.recommendation,
      aiJustification: advisory.justification,
      aiProvider: advisory.provider,
      // Always "allowed" here: an earlier `!policyResult.allowed` already
      // returned above, so reaching this line means the deterministic
      // engine passed.
      deterministicDecision: "allowed",
      deterministicReason: policyResult.reason,
    });
    pendingAt = pendingEvent.timestamp;
  }

  // 5. Bounded, pub/sub-driven wait -- delegated entirely to
  // state-machine.ts's awaitResolution. Not reimplemented here as a
  // poll loop; see that function's doc comment for why (the UPI retry
  // edge case).
  const resolution = await awaitResolution(deps.redis, requestId, paymentRequirements.maxTimeoutSeconds);

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
    aiJustification: advisory.justification,
    aiProvider: advisory.provider,
    createdAt: meta?.createdAt ?? new Date(now()).toISOString(),
    pendingAt,
  };

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
  const errorReason = resolution.state === "expired" ? "timeout" : "payment-declined";
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
      await deps.redis.set(confirmGateKey(String(req.params.requestId)), "1");
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
    zadd: (key, score, member) => client.zadd(key, { score, member }).then(result => result ?? 0),
    zremrangebyscore: (key, min, max) => client.zremrangebyscore(key, min as number, max as number),
    zcard: key => client.zcard(key),
    subscribe: (channels: string[]): EventSubscription => {
      // Explicit <string> type param: every message this facilitator
      // publishes is JSON.stringify'd text (see ./ws.ts's publishEvent), so
      // TMessage is always string -- without this, the SDK's generic
      // defaults it to `unknown`.
      const subscriber = client.subscribe<string>(channels);
      return {
        on: (event: "message" | "error", listener: (...args: never[]) => void) => {
          if (event === "message") {
            subscriber.on("message", (data: { channel: string; message: string }) =>
              (listener as (message: string, channel: string) => void)(data.message, data.channel),
            );
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
