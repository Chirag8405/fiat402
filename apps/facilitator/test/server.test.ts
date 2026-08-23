import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import { deriveRequestId } from "../../../packages/scheme-upi/src/state-machine";
import { EVENTS_CHANNEL, type FiatEvent } from "../src/ws";
import type { FacilitatorRedisClient } from "../src/server";
import type { PgClient } from "../src/store/db";

const createUpiPaymentLinkMock = vi.fn();

vi.mock("../src/razorpay/payment-links", () => ({
  createUpiPaymentLink: createUpiPaymentLinkMock,
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

  async publish(channel: string, message: string): Promise<number> {
    const listeners = this.channelListeners.get(channel);
    if (!listeners) return 0;
    for (const listener of listeners) listener(message, channel);
    return listeners.size;
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

  async query(text: string, params?: unknown[]): Promise<unknown> {
    this.calls.push({ text, params });
    return undefined;
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

function geminiResponse(recommendation: "approve" | "hold" | "flag", justification = "test justification"): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ recommendation, justification }) }] } }],
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
    fetchImplMock.mockResolvedValue(geminiResponse("approve"));
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
  it("returns ai-hold-pending-review immediately when the confirm-gate is not set", async () => {
    fetchImplMock.mockResolvedValue(geminiResponse("hold"));
    await startServer();

    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "order-hold-1");

    const { status, body } = await postSettle(requirements, payload);

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: false, errorReason: "ai-hold-pending-review", transaction: "" });
    expect(createUpiPaymentLinkMock).not.toHaveBeenCalled();
  });

  it("proceeds to Payment Link creation once the confirm-gate is set", async () => {
    createUpiPaymentLinkMock.mockResolvedValue({ ok: true, paymentLinkId: "plink_gated", shortUrl: "https://rzp.io/i/gated" });
    fetchImplMock.mockResolvedValue(geminiResponse("hold"));
    await startServer();

    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "order-hold-2");
    const requestId = deriveRequestId(requirements, payload);

    const gateRes = await fetch(`${baseUrl}/internal/confirm-gate/${requestId}`, { method: "POST" });
    expect(gateRes.status).toBe(200);

    const settlePromise = postSettle(requirements, payload);

    await waitFor(() => createUpiPaymentLinkMock.mock.calls.length === 1);
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
});

describe("POST /settle — timeout", () => {
  it("resolves cleanly as a 402-equivalent SettlementResponse, not a hung connection, when awaitResolution times out", async () => {
    createUpiPaymentLinkMock.mockResolvedValue({ ok: true, paymentLinkId: "plink_timeout", shortUrl: "https://rzp.io/i/timeout" });
    fetchImplMock.mockResolvedValue(geminiResponse("approve"));
    await startServer();

    const requirements = buildRequirements({ maxTimeoutSeconds: 0.05 });
    const payload = buildPayload(requirements, "order-timeout-1");
    const requestId = deriveRequestId(requirements, payload);

    const { status, body } = await postSettle(requirements, payload);

    expect(status).toBe(200);
    expect(body).toEqual({ success: false, errorReason: "timeout", transaction: "", network: "upi:in" });
    expect(await redis.get(`req:${requestId}:state`)).toBe("failed");
    expect(pg.calls).toHaveLength(1);
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
    fetchImplMock.mockResolvedValue(geminiResponse("approve"));
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
