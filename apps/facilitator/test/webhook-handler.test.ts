import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { razorpayWebhookHandler, type WebhookRedisClient } from "../src/razorpay/webhook-handler";

const SECRET = "test-webhook-secret";
const REQUEST_ID = "req_abc123";
const PAYMENT_LINK_ID = "plink_QflcnnZqCekuvL";
const PAYMENT_ID = "pay_Qfldmt5StKZFCB";

class FakeRedisClient implements WebhookRedisClient {
  store = new Map<string, string>();
  published: Array<{ channel: string; message: string }> = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return "OK";
  }

  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    return 1;
  }
}

function sign(body: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function paymentCapturedBody(): Buffer {
  return Buffer.from(
    JSON.stringify({
      event: "payment.captured",
      payload: {
        payment_link: { entity: { id: PAYMENT_LINK_ID } },
        payment: { entity: { id: PAYMENT_ID } },
      },
    }),
  );
}

/** Minimal fake Request/Response — just enough surface for this handler. */
function buildReqRes(body: Buffer, signature: string | undefined) {
  const req = {
    body,
    header: (name: string) => (name === "X-Razorpay-Signature" ? signature : undefined),
  } as unknown as Request;

  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  });
  res.send = vi.fn((payload: unknown) => {
    res.body = payload;
    return res as Response;
  });

  return { req, res: res as Response & { statusCode?: number; body?: unknown } };
}

async function waitForHandler(): Promise<void> {
  // The handler's body runs in a fire-and-forget async IIFE (Express
  // middleware signatures are synchronous-void); flush microtasks so
  // assertions run after it settles.
  await new Promise(resolve => setImmediate(resolve));
}

describe("razorpayWebhookHandler — signature verification", () => {
  it("rejects a request with a tampered body (valid signature for a different body)", async () => {
    const redis = new FakeRedisClient();
    const originalBody = paymentCapturedBody();
    const signature = sign(originalBody, SECRET);
    const tamperedBody = Buffer.from(originalBody.toString("utf8").replace(PAYMENT_ID, "pay_tampered0000"));

    const handler = razorpayWebhookHandler(redis, SECRET);
    const { req, res } = buildReqRes(tamperedBody, signature);
    handler(req, res, () => {});
    await waitForHandler();

    expect(res.statusCode).toBe(400);
  });

  it("accepts a request with the correct body and correct secret", async () => {
    const redis = new FakeRedisClient();
    await redis.set(`paymentLinkId:${PAYMENT_LINK_ID}:requestId`, REQUEST_ID);
    await redis.set(`req:${REQUEST_ID}:state`, "pending");

    const body = paymentCapturedBody();
    const signature = sign(body, SECRET);

    const handler = razorpayWebhookHandler(redis, SECRET);
    const { req, res } = buildReqRes(body, signature);
    handler(req, res, () => {});
    await waitForHandler();

    expect(res.statusCode).toBe(200);
  });

  it("rejects a request signed with the wrong secret", async () => {
    const redis = new FakeRedisClient();
    const body = paymentCapturedBody();
    const signature = sign(body, "a-completely-different-secret");

    const handler = razorpayWebhookHandler(redis, SECRET);
    const { req, res } = buildReqRes(body, signature);
    handler(req, res, () => {});
    await waitForHandler();

    expect(res.statusCode).toBe(400);
  });

  it("rejects a request with no signature header", async () => {
    const redis = new FakeRedisClient();
    const body = paymentCapturedBody();

    const handler = razorpayWebhookHandler(redis, SECRET);
    const { req, res } = buildReqRes(body, undefined);
    handler(req, res, () => {});
    await waitForHandler();

    expect(res.statusCode).toBe(400);
  });
});

describe("razorpayWebhookHandler — state transitions", () => {
  let redis: FakeRedisClient;

  beforeEach(() => {
    redis = new FakeRedisClient();
  });

  it("transitions to approved and publishes on payment.captured", async () => {
    await redis.set(`paymentLinkId:${PAYMENT_LINK_ID}:requestId`, REQUEST_ID);
    await redis.set(`req:${REQUEST_ID}:state`, "pending");

    const body = paymentCapturedBody();
    const signature = sign(body, SECRET);
    const handler = razorpayWebhookHandler(redis, SECRET);
    const { req, res } = buildReqRes(body, signature);
    handler(req, res, () => {});
    await waitForHandler();

    expect(res.statusCode).toBe(200);
    expect(redis.store.get(`req:${REQUEST_ID}:state`)).toBe("approved");
    expect(redis.published).toHaveLength(1);
    const published = JSON.parse(redis.published[0].message);
    expect(published).toMatchObject({
      requestId: REQUEST_ID,
      state: "approved",
      previousState: "pending",
      meta: { paymentLinkId: PAYMENT_LINK_ID, razorpayPaymentId: PAYMENT_ID },
    });
  });

  it("transitions to declined on payment.failed", async () => {
    await redis.set(`paymentLinkId:${PAYMENT_LINK_ID}:requestId`, REQUEST_ID);
    await redis.set(`req:${REQUEST_ID}:state`, "pending");

    const body = Buffer.from(
      JSON.stringify({
        event: "payment.failed",
        payload: {
          payment_link: { entity: { id: PAYMENT_LINK_ID } },
          payment: { entity: { id: PAYMENT_ID, error_description: "Payment declined by bank" } },
        },
      }),
    );
    const signature = sign(body, SECRET);
    const handler = razorpayWebhookHandler(redis, SECRET);
    const { req, res } = buildReqRes(body, signature);
    handler(req, res, () => {});
    await waitForHandler();

    expect(redis.store.get(`req:${REQUEST_ID}:state`)).toBe("declined");
    const published = JSON.parse(redis.published[0].message);
    expect(published.meta.reason).toBe("Payment declined by bank");
  });

  it("publishes a fresh event when payment.captured arrives after a prior decline (UPI retry)", async () => {
    await redis.set(`paymentLinkId:${PAYMENT_LINK_ID}:requestId`, REQUEST_ID);
    await redis.set(`req:${REQUEST_ID}:state`, "declined");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const body = paymentCapturedBody();
    const signature = sign(body, SECRET);
    const handler = razorpayWebhookHandler(redis, SECRET);
    const { req, res } = buildReqRes(body, signature);
    handler(req, res, () => {});
    await waitForHandler();

    expect(res.statusCode).toBe(200);
    expect(redis.store.get(`req:${REQUEST_ID}:state`)).toBe("approved");
    expect(redis.published).toHaveLength(1);
    const published = JSON.parse(redis.published[0].message);
    expect(published).toMatchObject({
      requestId: REQUEST_ID,
      state: "approved",
      previousState: "declined",
    });
    expect(consoleSpy.mock.calls.some(call => String(call[0]).includes("UPI retry detected"))).toBe(true);

    consoleSpy.mockRestore();
  });

  it("does not regress a terminal state back to approved on a duplicate/late webhook", async () => {
    await redis.set(`paymentLinkId:${PAYMENT_LINK_ID}:requestId`, REQUEST_ID);
    await redis.set(`req:${REQUEST_ID}:state`, "settled");

    const body = paymentCapturedBody();
    const signature = sign(body, SECRET);
    const handler = razorpayWebhookHandler(redis, SECRET);
    const { req, res } = buildReqRes(body, signature);
    handler(req, res, () => {});
    await waitForHandler();

    expect(res.statusCode).toBe(200);
    expect(redis.store.get(`req:${REQUEST_ID}:state`)).toBe("settled");
    expect(redis.published).toHaveLength(0);
  });

  it("returns 200 without erroring for a webhook with no matching in-flight request", async () => {
    const body = paymentCapturedBody(); // payment_link_id never registered in redis
    const signature = sign(body, SECRET);
    const handler = razorpayWebhookHandler(redis, SECRET);
    const { req, res } = buildReqRes(body, signature);
    handler(req, res, () => {});
    await waitForHandler();

    expect(res.statusCode).toBe(200);
    expect(redis.published).toHaveLength(0);
  });

  it("rejects a malformed (non-JSON) body gracefully instead of crashing", async () => {
    const body = Buffer.from("not json at all {{{");
    const signature = sign(body, SECRET);
    const handler = razorpayWebhookHandler(redis, SECRET);
    const { req, res } = buildReqRes(body, signature);

    expect(() => handler(req, res, () => {})).not.toThrow();
    await waitForHandler();

    expect(res.statusCode).toBe(400);
  });

  it("resolves payment.failed via the cached payment_id index when no payment_link is present on the event", async () => {
    // Seed the payment_id cache the way handleCapturedOrPaid would have
    // after an earlier payment_link.paid/payment.captured event.
    await redis.set(`razorpayPaymentId:${PAYMENT_ID}:requestId`, REQUEST_ID);
    await redis.set(`req:${REQUEST_ID}:state`, "pending");

    const body = Buffer.from(
      JSON.stringify({
        event: "payment.failed",
        payload: {
          payment: { entity: { id: PAYMENT_ID, error_description: "Insufficient funds" } },
        },
      }),
    );
    const signature = sign(body, SECRET);
    const handler = razorpayWebhookHandler(redis, SECRET);
    const { req, res } = buildReqRes(body, signature);
    handler(req, res, () => {});
    await waitForHandler();

    expect(res.statusCode).toBe(200);
    expect(redis.store.get(`req:${REQUEST_ID}:state`)).toBe("declined");
  });
});
