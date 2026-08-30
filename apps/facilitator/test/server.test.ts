import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import { deriveRequestId } from "../../../packages/scheme-upi/src/state-machine";
import { EVENTS_CHANNEL, type FiatEvent } from "../src/ws";
import type { FacilitatorRedisClient } from "../src/server";
import type { PgClient } from "../src/store/db";

const createUpiPaymentLinkMock = vi.fn();
const cancelUpiPaymentLinkMock = vi.fn();

vi.mock("../src/razorpay/payment-links", () => ({
  createUpiPaymentLink: createUpiPaymentLinkMock,
  cancelUpiPaymentLink: cancelUpiPaymentLinkMock,
}));

const { createServer } = await import("../src/server");

const MERCHANT = "merchant@ybl";

/**
 * In-memory fake covering the full FacilitatorRedisClient surface (state
 * machine keys + velocity sorted sets + pub/sub), so /settle and /verify
 * exercise the real checkDeterministicPolicy / state-machine.ts code paths
 * end-to-end, the same way packages/scheme-upi/test/state-machine.test.ts's
 * FakePubSubRedisClient does for state-machine.ts alone.
 */
class FakeRedis implements FacilitatorRedisClient {
  private store = new Map<string, string>();
  private hashes = new Map<string, Record<string, string>>();
  private sortedSets = new Map<string, Map<string, number>>();
  private lists = new Map<string, string[]>();
  private channelListeners = new Map<string, Set<(message: string, channel: string) => void>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return "OK";
  }

  async expire(): Promise<number> {
    return 1;
  }

  async hset(key: string, fields: Record<string, string>): Promise<number> {
    this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), ...fields });
    return Object.keys(fields).length;
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    return this.hashes.get(key) ?? null;
  }

  /** Every publish this fake has seen, in order -- lets tests assert on the full transition sequence, not just the final Redis state. */
  publishedMessages: Array<{ channel: string; message: string }> = [];

  async publish(channel: string, message: string): Promise<number> {
    this.publishedMessages.push({ channel, message });
    const listeners = this.channelListeners.get(channel);
    if (!listeners) return 0;
    for (const listener of listeners) listener(message, channel);
    return listeners.size;
  }

  /** Convenience for tests: every FiatEvent this fake has published on EVENTS_CHANNEL, in order. */
  publishedEvents(): FiatEvent[] {
    return this.publishedMessages.filter(p => p.channel === EVENTS_CHANNEL).map(p => JSON.parse(p.message) as FiatEvent);
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<string> {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(start, stop + 1));
    return "OK";
  }

  subscribe(channels: string[]) {
    const registered = new Set<(message: string, channel: string) => void>();
    return {
      on: (event: "message" | "error", listener: (...args: never[]) => void) => {
        if (event !== "message") return;
        const wrapped = (message: string, channel: string) => (listener as (m: string, c: string) => void)(message, channel);
        registered.add(wrapped);
        for (const channel of channels) {
          const set = this.channelListeners.get(channel) ?? new Set();
          set.add(wrapped);
          this.channelListeners.set(channel, set);
        }
      },
      unsubscribe: () => {
        for (const channel of channels) {
          const set = this.channelListeners.get(channel);
          if (!set) continue;
          for (const wrapped of registered) set.delete(wrapped);
        }
      },
    };
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    const isNew = !set.has(member);
    set.set(member, score);
    this.sortedSets.set(key, set);
    return isNew ? 1 : 0;
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const set = this.sortedSets.get(key);
    if (!set) return 0;
    const lo = Number(min);
    const hi = Number(max);
    let removed = 0;
    for (const [member, score] of set) {
      if (score >= lo && score <= hi) {
        set.delete(member);
        removed++;
      }
    }
    return removed;
  }

  async zcard(key: string): Promise<number> {
    return this.sortedSets.get(key)?.size ?? 0;
  }

  /** Test helper, not part of FacilitatorRedisClient: publishes a state-transition event exactly like state-machine.ts's transitionState would. */
  async publishFiatEvent(event: FiatEvent): Promise<void> {
    await this.publish(EVENTS_CHANNEL, JSON.stringify(event));
  }
}

class FakePg implements PgClient {
  calls: Array<{ text: string; params?: unknown[] }> = [];
  /** Rows returned by the next (and every subsequent) query -- set by tests exercising readReconciliationRecord's SELECT. Ignored by writeReconciliationRecord, which never reads a query's return value. */
  rowsToReturn: unknown[] = [];

  async query(text: string, params?: unknown[]): Promise<unknown> {
    this.calls.push({ text, params });
    return { rows: this.rowsToReturn };
  }
}

function buildRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "upi",
    network: "upi:in",
    amount: "10000",
    asset: "INR",
    payTo: MERCHANT,
    maxTimeoutSeconds: 90,
    extra: { merchantName: "Acme Chai Stall", description: "One cup of chai" },
    ...overrides,
  } as PaymentRequirements;
}

function buildPayload(requirements: PaymentRequirements, txnRef: string): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { txnRef },
  } as PaymentPayload;
}

function geminiResponse(
  recommendation: "hold" | "proceed",
  humanSummary = "test human summary",
  semanticMatch = true,
  reasoning = "test reasoning",
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        { content: { parts: [{ text: JSON.stringify({ recommendation, semanticMatch, reasoning, humanSummary }) }] } },
      ],
    }),
  } as Response;
}

const ORIGINAL_ENV = { ...process.env };

let redis: FakeRedis;
let pg: FakePg;
let fetchImplMock: ReturnType<typeof vi.fn>;
let server: Server;
let baseUrl: string;

async function startServer(): Promise<void> {
  const app = createServer({ redis, pg, fetchImpl: fetchImplMock as unknown as typeof fetch });
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
}

async function postSettle(requirements: PaymentRequirements, payload: PaymentPayload): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  process.env.MAX_AMOUNT_PAISE = "100000";
  process.env.ALLOWED_MERCHANTS = MERCHANT;
  process.env.MAX_REQUESTS_PER_MINUTE = "1000";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  delete process.env.GROQ_API_KEY;

  redis = new FakeRedis();
  pg = new FakePg();
  createUpiPaymentLinkMock.mockReset();
  cancelUpiPaymentLinkMock.mockReset();
  cancelUpiPaymentLinkMock.mockResolvedValue({ ok: true });
  fetchImplMock = vi.fn();
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  if (server) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe("POST /settle — happy path", () => {
  it("creates a Payment Link and returns success once the resolution resolves approved", async () => {
    createUpiPaymentLinkMock.mockResolvedValue({ ok: true, paymentLinkId: "plink_happy", shortUrl: "https://rzp.io/i/happy" });
    fetchImplMock.mockResolvedValue(geminiResponse("proceed"));
    await startServer();

    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "order-happy-1");
    const requestId = deriveRequestId(requirements, payload);

    const settlePromise = postSettle(requirements, payload);

    await waitFor(() => createUpiPaymentLinkMock.mock.calls.length === 1);
    await redis.publishFiatEvent({
      requestId,
      state: "approved",
      previousState: "pending",
      timestamp: new Date().toISOString(),
      meta: { paymentLinkId: "plink_happy", razorpayPaymentId: "pay_happy123", reason: null },
    });

    const { status, body } = await settlePromise;

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, transaction: "pay_happy123", network: "upi:in" });
    expect(createUpiPaymentLinkMock).toHaveBeenCalledTimes(1);
    expect(pg.calls).toHaveLength(1);
    expect(await redis.get(`req:${requestId}:state`)).toBe("settled");
  });
});

describe("POST /settle — deterministic rejection", () => {
  it("short-circuits before calling the AI layer when the deterministic policy rejects", async () => {
    process.env.ALLOWED_MERCHANTS = "someone-else@ybl";
    await startServer();

    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "order-reject-1");

    const { status, body } = await postSettle(requirements, payload);

    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.transaction).toBe("");
    expect(typeof body.errorReason).toBe("string");
    expect(String(body.errorReason)).toContain("ALLOWED_MERCHANTS");
    expect(fetchImplMock).not.toHaveBeenCalled();
    expect(createUpiPaymentLinkMock).not.toHaveBeenCalled();
  });
});

describe("POST /settle — AI hold / confirm-gate", () => {
  it("still creates the Payment Link on a hold, then returns ai-hold-timed-out if the gate is never confirmed", async () => {
    // A hold must only add friction, never block the request from reaching
    // a payable state -- the Payment Link has to exist regardless, so a
    // human actually has something to confirm.
    createUpiPaymentLinkMock.mockResolvedValue({ ok: true, paymentLinkId: "plink_hold_timeout", shortUrl: "https://rzp.io/i/hold-timeout" });
    fetchImplMock.mockResolvedValue(geminiResponse("hold"));
    await startServer();

    const requirements = buildRequirements({ maxTimeoutSeconds: 0.05 });
    const payload = buildPayload(requirements, "order-hold-1");
    const requestId = deriveRequestId(requirements, payload);

    const { status, body } = await postSettle(requirements, payload);

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: false, errorReason: "ai-hold-timed-out", transaction: "" });
    expect(createUpiPaymentLinkMock).toHaveBeenCalledTimes(1);
    expect(await redis.get(`confirm-gate:${requestId}`)).toBe("0");

    // Regression: previously this returned without ever transitioning
    // state or writing a reconciliation record -- the request was left
    // stuck in "pending" indefinitely with a live Payment Link.
    expect(await redis.get(`req:${requestId}:state`)).toBe("failed");
    expect(pg.calls).toHaveLength(1);

    // Regression: the rail must show a payer-outcome step ("expired") before
    // the terminal "failed" -- previously this jumped straight pending -> failed.
    const states = redis.publishedEvents().filter(e => e.requestId === requestId).map(e => e.state);
    expect(states).toEqual(["pending", "expired", "failed"]);

    // Regression: the Payment Link must be actively cancelled, not left to
    // expire on its own -- expire_by alone leaves it payable for up to ~14
    // more minutes (Razorpay's 15-minute floor) after this request is
    // already marked "failed".
    expect(cancelUpiPaymentLinkMock).toHaveBeenCalledWith("plink_hold_timeout");
  }, 10000);

  it("logs but does not fail the response when cancelling the Payment Link errors after ai-hold-timed-out", async () => {
    createUpiPaymentLinkMock.mockResolvedValue({ ok: true, paymentLinkId: "plink_cancel_fails", shortUrl: "https://rzp.io/i/cancel-fails" });
    cancelUpiPaymentLinkMock.mockResolvedValue({ ok: false, errorCode: "BAD_REQUEST_ERROR", errorDescription: "This link has already been paid" });
    fetchImplMock.mockResolvedValue(geminiResponse("hold"));
    await startServer();

    const requirements = buildRequirements({ maxTimeoutSeconds: 0.05 });
    const payload = buildPayload(requirements, "order-hold-cancel-fails");

    const { status, body } = await postSettle(requirements, payload);

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: false, errorReason: "ai-hold-timed-out", transaction: "" });
    expect(cancelUpiPaymentLinkMock).toHaveBeenCalledTimes(1);
  }, 10000);

  it("blocks the in-flight /settle call, then proceeds to settlement once a concurrent confirm-gate call flips the gate", async () => {
    createUpiPaymentLinkMock.mockResolvedValue({ ok: true, paymentLinkId: "plink_gated", shortUrl: "https://rzp.io/i/gated" });
    fetchImplMock.mockResolvedValue(geminiResponse("hold"));
    await startServer();

    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "order-hold-2");
    const requestId = deriveRequestId(requirements, payload);

    const settlePromise = postSettle(requirements, payload);

    // The Payment Link already exists while /settle is still blocked on the
    // confirm-gate wait -- this is exactly the gap the old
    // reject-before-any-Payment-Link-exists behavior left open.
    await waitFor(() => createUpiPaymentLinkMock.mock.calls.length === 1);
    expect(await redis.get(`confirm-gate:${requestId}`)).toBe("0");

    const gateRes = await fetch(`${baseUrl}/internal/confirm-gate/${requestId}`, { method: "POST" });
    expect(gateRes.status).toBe(200);

    // The confirm endpoint's publish resolves the still-in-flight
    // awaitConfirmGate call; /settle then proceeds into its normal
    // awaitResolution wait for the actual payment, exactly as the non-hold
    // path does.
    await redis.publishFiatEvent({
      requestId,
      state: "approved",
      previousState: "pending",
      timestamp: new Date().toISOString(),
      meta: { paymentLinkId: "plink_gated", razorpayPaymentId: "pay_gated123", reason: null },
    });

    const { body } = await settlePromise;
    expect(body).toMatchObject({ success: true, transaction: "pay_gated123" });
  });

  it("resolves successfully when the Payment Link is paid directly during the confirm-gate wait, without ever calling /internal/confirm-gate", async () => {
    // Regression test for the bug where awaitConfirmGate ran (and finished)
    // strictly BEFORE awaitResolution even subscribed: webhook-handler.ts
    // publishes "approved" to fiat402:events BEFORE it satisfies the
    // confirm-gate, so a direct payment's "approved" event was published to
    // nobody and awaitResolution then subscribed too late to ever see it,
    // timing out on every real payment. Driven through the real
    // /webhooks/razorpay route (signed HMAC payload) rather than a
    // hand-simulated pub/sub publish, so this exercises the actual
    // publishTransition-then-satisfyConfirmGate ordering in production code.
    const PAYMENT_LINK_ID = "plink_direct_pay";
    const PAYMENT_ID = "pay_direct_pay_123";
    const WEBHOOK_SECRET = "test-webhook-secret";
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

    createUpiPaymentLinkMock.mockResolvedValue({ ok: true, paymentLinkId: PAYMENT_LINK_ID, shortUrl: "https://rzp.io/i/direct" });
    fetchImplMock.mockResolvedValue(geminiResponse("hold"));
    await startServer();

    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "order-hold-direct-pay");

    const settlePromise = postSettle(requirements, payload);

    // The Payment Link exists -- exactly the point at which a real payer
    // could pay it directly, without any confirm-gate call ever happening.
    await waitFor(() => createUpiPaymentLinkMock.mock.calls.length === 1);

    const webhookBody = Buffer.from(
      JSON.stringify({
        event: "payment.captured",
        payload: {
          payment_link: { entity: { id: PAYMENT_LINK_ID } },
          payment: { entity: { id: PAYMENT_ID } },
        },
      }),
    );
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(webhookBody).digest("hex");

    const webhookRes = await fetch(`${baseUrl}/webhooks/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Razorpay-Signature": signature },
      body: webhookBody,
    });
    expect(webhookRes.status).toBe(200);

    // Never call /internal/confirm-gate -- the whole point is that paying
    // directly is sufficient on its own.
    const { body } = await settlePromise;
    expect(body).toMatchObject({ success: true, transaction: PAYMENT_ID });
  });
});

describe("POST /settle — human decline", () => {
  it("unblocks a still-unconfirmed hold immediately via /internal/decline, without waiting for its timeout", async () => {
    // Regression target: a naive decline (just publishing a "declined"
    // FiatEvent the way the webhook handler does) would be silently ignored
    // by awaitResolution (intentional, for the UPI-retry case) and would
    // never even reach awaitConfirmGate at all -- the in-flight /settle call
    // would ride out its full maxTimeoutSeconds regardless. This exercises
    // the real declineConfirmGate -> awaitConfirmGate signal path instead.
    createUpiPaymentLinkMock.mockResolvedValue({ ok: true, paymentLinkId: "plink_decline_hold", shortUrl: "https://rzp.io/i/decline-hold" });
    fetchImplMock.mockResolvedValue(geminiResponse("hold"));
    await startServer();

    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "order-decline-hold-1");
    const requestId = deriveRequestId(requirements, payload);

    const settlePromise = postSettle(requirements, payload);

    await waitFor(() => createUpiPaymentLinkMock.mock.calls.length === 1);
    expect(await redis.get(`confirm-gate:${requestId}`)).toBe("0");

    const declineRes = await fetch(`${baseUrl}/internal/decline/${requestId}`, { method: "POST" });
    expect(declineRes.status).toBe(200);

    const { status, body } = await settlePromise;

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: false, errorReason: "human-declined", transaction: "" });
    expect(await redis.get(`req:${requestId}:state`)).toBe("failed");
    expect(pg.calls).toHaveLength(1);
    expect(cancelUpiPaymentLinkMock).toHaveBeenCalledWith("plink_decline_hold");

    // Regression: the rail must show "declined" before "failed", not jump
    // straight from pending.
    const states = redis.publishedEvents().filter(e => e.requestId === requestId).map(e => e.state);
    expect(states).toEqual(["pending", "declined", "failed"]);
  });

  it("unblocks a plain payer-approval wait via /internal/decline, for a request that was never a hold", async () => {
    // Decline must work on ANY pending request, not just holds -- this one
    // never goes through awaitConfirmGate at all (recommendation is
    // "proceed"), so the signal has to reach the resolutionPromise/
    // declineWaitPromise race directly.
    createUpiPaymentLinkMock.mockResolvedValue({ ok: true, paymentLinkId: "plink_decline_approve", shortUrl: "https://rzp.io/i/decline-approve" });
    fetchImplMock.mockResolvedValue(geminiResponse("proceed"));
    await startServer();

    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "order-decline-approve-1");
    const requestId = deriveRequestId(requirements, payload);

    const settlePromise = postSettle(requirements, payload);

    await waitFor(() => createUpiPaymentLinkMock.mock.calls.length === 1);

    const declineRes = await fetch(`${baseUrl}/internal/decline/${requestId}`, { method: "POST" });
    expect(declineRes.status).toBe(200);

    const { status, body } = await settlePromise;

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: false, errorReason: "human-declined", transaction: "" });
    expect(await redis.get(`req:${requestId}:state`)).toBe("failed");
    expect(cancelUpiPaymentLinkMock).toHaveBeenCalledWith("plink_decline_approve");

    // Regression: same payer-outcome-before-terminal requirement as the hold case.
    const states = redis.publishedEvents().filter(e => e.requestId === requestId).map(e => e.state);
    expect(states).toEqual(["pending", "declined", "failed"]);
  });
});

describe("POST /settle — timeout", () => {
  it("resolves cleanly as a 402-equivalent SettlementResponse, not a hung connection, when awaitResolution times out", async () => {
    createUpiPaymentLinkMock.mockResolvedValue({ ok: true, paymentLinkId: "plink_timeout", shortUrl: "https://rzp.io/i/timeout" });
    fetchImplMock.mockResolvedValue(geminiResponse("proceed"));
    await startServer();

    const requirements = buildRequirements({ maxTimeoutSeconds: 0.05 });
    const payload = buildPayload(requirements, "order-timeout-1");
    const requestId = deriveRequestId(requirements, payload);

    const { status, body } = await postSettle(requirements, payload);

    expect(status).toBe(200);
    expect(body).toEqual({ success: false, errorReason: "timeout", transaction: "", network: "upi:in" });
    expect(await redis.get(`req:${requestId}:state`)).toBe("failed");
    expect(pg.calls).toHaveLength(1);

    // Regression: a plain payer timeout (nobody ever paid) must show
    // "expired" before "failed" -- awaitResolution's own "expired" outcome
    // is never itself published, so without this the rail jumped straight
    // pending -> failed.
    const states = redis.publishedEvents().filter(e => e.requestId === requestId).map(e => e.state);
    expect(states).toEqual(["pending", "expired", "failed"]);
  }, 10000);
});

describe("x402Version validation", () => {
  it("POST /verify rejects a paymentPayload with an unsupported x402Version", async () => {
    await startServer();

    const requirements = buildRequirements();
    const payload = { ...buildPayload(requirements, "order-badversion-verify"), x402Version: 1 };

    const res = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x402Version: 1, paymentPayload: payload, paymentRequirements: requirements }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({ isValid: false, invalidReason: "unsupported x402Version" });
    expect(fetchImplMock).not.toHaveBeenCalled();
  });

  it("POST /settle rejects a paymentPayload with an unsupported x402Version", async () => {
    await startServer();

    const requirements = buildRequirements();
    const payload = { ...buildPayload(requirements, "order-badversion-settle"), x402Version: 1 };

    const { status, body } = await postSettle(requirements, payload);

    expect(status).toBe(200);
    expect(body).toEqual({ success: false, errorReason: "unsupported x402Version", transaction: "", network: "upi:in" });
    expect(fetchImplMock).not.toHaveBeenCalled();
    expect(createUpiPaymentLinkMock).not.toHaveBeenCalled();
  });
});

describe("POST /settle — concurrent requests for the same logical request", () => {
  it("only creates one Payment Link; the second call joins the existing resolution", async () => {
    createUpiPaymentLinkMock.mockResolvedValue({ ok: true, paymentLinkId: "plink_concurrent", shortUrl: "https://rzp.io/i/concurrent" });
    fetchImplMock.mockResolvedValue(geminiResponse("proceed"));
    await startServer();

    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "order-concurrent-1");
    const requestId = deriveRequestId(requirements, payload);

    const settlePromise1 = postSettle(requirements, payload);
    await waitFor(() => createUpiPaymentLinkMock.mock.calls.length === 1);

    const settlePromise2 = postSettle(requirements, payload);
    // Give the second call's event loop turn a chance to reach its
    // existing-paymentLinkId check (which is already true by now, since the
    // first call wrote it before entering awaitResolution).
    await new Promise(resolve => setTimeout(resolve, 20));

    await redis.publishFiatEvent({
      requestId,
      state: "approved",
      previousState: "pending",
      timestamp: new Date().toISOString(),
      meta: { paymentLinkId: "plink_concurrent", razorpayPaymentId: "pay_concurrent123", reason: null },
    });

    const [result1, result2] = await Promise.all([settlePromise1, settlePromise2]);

    expect(createUpiPaymentLinkMock).toHaveBeenCalledTimes(1);
    expect(result1.body).toMatchObject({ success: true, transaction: "pay_concurrent123" });
    expect(result2.body).toMatchObject({ success: true, transaction: "pay_concurrent123" });
  });
});

describe("GET /reconciliation/:requestId", () => {
  it("returns 404 when no reconciliation record exists for the requestId", async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/reconciliation/req_unknown`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });

  it("returns the reconciliation record as JSON when one exists", async () => {
    await startServer();

    pg.rowsToReturn = [
      {
        request_id: "req_abc123",
        txn_ref: "txn_1",
        razorpay_payment_id: "pay_xyz",
        payment_link_id: "plink_xyz",
        amount_paise: "10000",
        pay_to: MERCHANT,
        deterministic_decision: true,
        deterministic_reason: null,
        ai_recommendation: "proceed",
        ai_justification: "Looks routine.",
        ai_provider: "gemini",
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        pending_at: new Date("2026-01-01T00:00:01.000Z"),
        resolved_at: new Date("2026-01-01T00:00:05.000Z"),
        settled_at: new Date("2026-01-01T00:00:06.000Z"),
        failed_at: null,
        final_outcome: "settled",
      },
    ];

    const res = await fetch(`${baseUrl}/reconciliation/req_abc123`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      requestId: "req_abc123",
      txnRef: "txn_1",
      razorpayPaymentId: "pay_xyz",
      paymentLinkId: "plink_xyz",
      amountPaise: "10000",
      payTo: MERCHANT,
      aiRecommendation: "proceed",
      finalOutcome: "settled",
    });
  });
});
