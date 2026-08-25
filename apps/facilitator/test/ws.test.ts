import { describe, it, expect, vi, beforeEach } from "vitest";
import { subscribeToEvents, type EventSubscription, type SubscribeRedisClient, type FiatEvent } from "../src/ws";

/**
 * Fake SubscribeRedisClient that hands back a controllable EventSubscription
 * -- lets each test push whatever value it wants at the registered
 * "message" listener (a real JSON string, an already-parsed object -- as
 * @upstash/redis's real client delivers by default, see ../src/ws.ts's
 * EventSubscription doc comment -- or something malformed), the same shape
 * subscribeToEvents itself has to handle from adaptUpstashClient's bridge.
 */
function fakeSubscription(): { subscription: EventSubscription; emit: (message: unknown, channel: string) => void } {
  let messageListener: ((message: unknown, channel: string) => void) | null = null;
  const subscription: EventSubscription = {
    on: (event, listener) => {
      if (event === "message") messageListener = listener as (message: unknown, channel: string) => void;
    },
    unsubscribe: () => {},
  };
  return {
    subscription,
    emit: (message, channel) => messageListener?.(message, channel),
  };
}

function buildEvent(overrides: Partial<FiatEvent> = {}): FiatEvent {
  return {
    requestId: "req_1",
    state: "approved",
    previousState: "pending",
    timestamp: "2026-01-01T00:00:00.000Z",
    meta: { paymentLinkId: "plink_1", razorpayPaymentId: "pay_1", reason: null },
    ...overrides,
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("subscribeToEvents", () => {
  it("parses a JSON string message into a FiatEvent (the raw-string transport, e.g. these test fakes)", () => {
    const { subscription, emit } = fakeSubscription();
    const onEvent = vi.fn();
    const fakeRedis: SubscribeRedisClient = { subscribe: () => subscription };

    subscribeToEvents(fakeRedis, onEvent);
    const event = buildEvent();
    emit(JSON.stringify(event), "fiat402:events");

    expect(onEvent).toHaveBeenCalledWith(event);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("accepts an already-deserialized object without re-parsing it (the real @upstash/redis transport)", () => {
    const { subscription, emit } = fakeSubscription();
    const onEvent = vi.fn();
    const fakeRedis: SubscribeRedisClient = { subscribe: () => subscription };

    subscribeToEvents(fakeRedis, onEvent);
    const event = buildEvent();
    // No JSON.stringify here -- this is exactly what @upstash/redis's
    // Subscriber hands listeners by default (automaticDeserialization),
    // which previously broke subscribeToEvents' unconditional JSON.parse.
    emit(event, "fiat402:events");

    expect(onEvent).toHaveBeenCalledWith(event);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("drops and logs a string message that fails to parse as JSON, without calling onEvent", () => {
    const { subscription, emit } = fakeSubscription();
    const onEvent = vi.fn();
    const fakeRedis: SubscribeRedisClient = { subscribe: () => subscription };

    subscribeToEvents(fakeRedis, onEvent);
    emit("not valid json", "fiat402:events");

    expect(onEvent).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/JSON\.parse failed/);
  });

  it("drops and logs a parsed value that doesn't look like a FiatEvent (string path)", () => {
    const { subscription, emit } = fakeSubscription();
    const onEvent = vi.fn();
    const fakeRedis: SubscribeRedisClient = { subscribe: () => subscription };

    subscribeToEvents(fakeRedis, onEvent);
    emit(JSON.stringify({ notAFiatEvent: true }), "fiat402:events");

    expect(onEvent).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/did not look like a FiatEvent/);
  });

  it("drops and logs an already-object value that doesn't look like a FiatEvent (pass-through path)", () => {
    const { subscription, emit } = fakeSubscription();
    const onEvent = vi.fn();
    const fakeRedis: SubscribeRedisClient = { subscribe: () => subscription };

    subscribeToEvents(fakeRedis, onEvent);
    emit({ notAFiatEvent: true }, "fiat402:events");

    expect(onEvent).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/did not look like a FiatEvent/);
  });
});
