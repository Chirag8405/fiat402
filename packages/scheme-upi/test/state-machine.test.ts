import { describe, it, expect } from "vitest";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import {
  deriveRequestId,
  transitionState,
  awaitResolution,
  type StateMachineRedisClient,
} from "../src/state-machine";
import { EVENTS_CHANNEL, type EventSubscription } from "../../../apps/facilitator/src/ws";

/**
 * In-memory fake implementing StateMachineRedisClient's full surface,
 * including a real (in-process) publish/subscribe simulation so tests can
 * exercise transitionState -> awaitResolution end-to-end without a real
 * Redis instance, the same way test/webhook-handler.test.ts's FakeRedisClient
 * fakes just enough of the real client's surface to exercise the module
 * under test.
 */
class FakePubSubRedisClient implements StateMachineRedisClient {
  private store = new Map<string, string>();
  private hashes = new Map<string, Record<string, string>>();
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

  subscribe(channels: string[]): EventSubscription {
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
}

function buildRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "upi",
    network: "upi:in",
    amount: "10000",
    asset: "INR",
    payTo: "merchant@ybl",
    maxTimeoutSeconds: 90,
    extra: { merchantName: "Acme Chai Stall", description: "One cup of chai" },
    ...overrides,
  } as PaymentRequirements;
}

function buildPayload(requirements: PaymentRequirements, txnRef?: string): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: txnRef === undefined ? {} : { txnRef },
  } as PaymentPayload;
}

describe("deriveRequestId", () => {
  it("is stable for identical inputs", () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "order-4471");

    expect(deriveRequestId(requirements, payload)).toBe(deriveRequestId(requirements, payload));
  });

  it("differs when txnRef differs", () => {
    const requirements = buildRequirements();

    const idA = deriveRequestId(requirements, buildPayload(requirements, "order-1"));
    const idB = deriveRequestId(requirements, buildPayload(requirements, "order-2"));

    expect(idA).not.toBe(idB);
  });

  it("differs when amount differs", () => {
    const requirementsA = buildRequirements({ amount: "10000" });
    const requirementsB = buildRequirements({ amount: "20000" });

    const idA = deriveRequestId(requirementsA, buildPayload(requirementsA, "order-1"));
    const idB = deriveRequestId(requirementsB, buildPayload(requirementsB, "order-1"));

    expect(idA).not.toBe(idB);
  });

  it("is not stable across calls when txnRef is absent (falls back to a fresh UUID each time)", () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);

    expect(deriveRequestId(requirements, payload)).not.toBe(deriveRequestId(requirements, payload));
  });
});

describe("transitionState", () => {
  it("publishes the correct event shape on fiat402:events", async () => {
    const redis = new FakePubSubRedisClient();
    const requestId = "req_shape_test";

    const received: string[] = [];
    redis.subscribe([EVENTS_CHANNEL]).on("message", message => {
      received.push(message);
    });

    const event = await transitionState(redis, requestId, "pending", { paymentLinkId: "plink_abc" });

    expect(event).toEqual({
      requestId,
      state: "pending",
      previousState: null,
      timestamp: event.timestamp,
      meta: { paymentLinkId: "plink_abc", razorpayPaymentId: null, reason: null },
    });
    expect(() => new Date(event.timestamp).toISOString()).not.toThrow();

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0])).toEqual(event);

    expect(await redis.get(`req:${requestId}:state`)).toBe("pending");
  });

  it("carries the prior state forward as previousState on the next transition", async () => {
    const redis = new FakePubSubRedisClient();
    const requestId = "req_prev_state_test";

    await transitionState(redis, requestId, "pending");
    const second = await transitionState(redis, requestId, "approved", { razorpayPaymentId: "pay_1" });

    expect(second.previousState).toBe("pending");
  });
});

describe("awaitResolution", () => {
  it("resolves 'approved' when a 'declined' event is followed by an 'approved' event for the same requestId (UPI retry edge case)", async () => {
    const redis = new FakePubSubRedisClient();
    const requestId = "req_retry_test";

    const resolution = awaitResolution(redis, requestId, 5);

    // Simulates webhook-handler.ts: payment.failed (-> declined) then, per
    // the UPI retry edge case, payment.captured for the same link (-> approved).
    await transitionState(redis, requestId, "declined", { reason: "payer declined in app" });
    await transitionState(redis, requestId, "approved", { razorpayPaymentId: "pay_retry_123" });

    const result = await resolution;

    expect(result.state).toBe("approved");
    expect(result.event?.requestId).toBe(requestId);
    expect(result.event?.meta.razorpayPaymentId).toBe("pay_retry_123");
  });

  it("ignores events for a different requestId", async () => {
    const redis = new FakePubSubRedisClient();

    const resolution = awaitResolution(redis, "req_target", 0.1);
    await transitionState(redis, "req_other", "approved");

    const result = await resolution;
    expect(result).toEqual({ state: "expired", event: null });
  });

  it("times out cleanly at maxTimeoutSeconds when no terminal event ever arrives", async () => {
    const redis = new FakePubSubRedisClient();

    const result = await awaitResolution(redis, "req_no_events", 0.05);

    expect(result).toEqual({ state: "expired", event: null });
  });
});
