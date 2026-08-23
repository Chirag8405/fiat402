/**
 * Redis pub/sub layer for the `fiat402:events` channel.
 *
 * Channel name and event JSON shape are exactly CLAUDE.md's "Pub/sub event
 * schema" section, and match the `FiatEventsMessage` shape already published
 * by ./razorpay/webhook-handler.ts (that module inlines its own copy of this
 * shape because it has no dependency on state-machine.ts/ws.ts per its own
 * spec — see its top-of-file comment. Keep both in sync with CLAUDE.md).
 *
 * Design decision (CLAUDE.md leaves this open, "pick one and document it"):
 * we use the single shared channel `fiat402:events`, not a per-request
 * `fiat402:events:{requestId}` variant. Reason: webhook-handler.ts (Module 4,
 * already built) only ever publishes to the single shared channel — it has
 * no knowledge of a per-request channel naming scheme, and changing that
 * would mean re-opening an already-built, already-tested module. Consumers
 * that only care about one requestId (state-machine.ts's resolution
 * function) subscribe to the shared channel and filter by `event.requestId`
 * client-side instead.
 *
 * Exports two functions:
 *   - publishEvent: used by state-machine.ts's transition function.
 *   - subscribeToEvents: used by state-machine.ts's resolution function, and
 *     (Module 7) by the dashboard's SSE relay, which subscribes unfiltered
 *     and forwards every event to connected browsers.
 */

export type RequestState = "created" | "pending" | "approved" | "declined" | "expired" | "settled" | "failed";

/** Pub/sub event schema, verbatim from CLAUDE.md's "Pub/sub event schema" section. */
export interface FiatEvent {
  requestId: string;
  state: RequestState;
  previousState: string | null;
  timestamp: string;
  meta: {
    paymentLinkId: string | null;
    razorpayPaymentId: string | null;
    reason: string | null;
  };
}

export const EVENTS_CHANNEL = "fiat402:events";

/**
 * Minimal publish-side Redis surface. `PUBLISH` is a plain Redis command, so
 * this works identically whether `redis` is the real Upstash REST client or
 * a fake in tests.
 */
export interface PublishRedisClient {
  publish(channel: string, message: string): Promise<number>;
}

/**
 * A live subscription handle. `on("message", ...)` fires once per message
 * delivered on any of the subscribed channels; `unsubscribe()` tears the
 * subscription down. Modeled on @upstash/redis's `redis.subscribe(...)`
 * return value (an SSE-backed emitter), so the real Upstash client satisfies
 * this structurally without an adapter.
 */
export interface EventSubscription {
  on(event: "message", listener: (message: string, channel: string) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  unsubscribe(): void | Promise<void>;
}

/**
 * Minimal subscribe-side Redis surface.
 */
export interface SubscribeRedisClient {
  subscribe(channels: string[]): EventSubscription;
}

/**
 * Publishes a state-transition event to `fiat402:events`. `redis` is
 * caller-owned (see store/redis.ts) — never instantiated in this file.
 */
export async function publishEvent(redis: PublishRedisClient, event: FiatEvent): Promise<void> {
  await redis.publish(EVENTS_CHANNEL, JSON.stringify(event));
}

/**
 * Subscribes to `fiat402:events` and invokes `onEvent` for every
 * successfully-parsed message. Malformed (non-JSON, or JSON that doesn't
 * look like a FiatEvent) messages are dropped rather than crashing the
 * subscriber — a single bad message on a shared channel must not take down
 * every listener.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToEvents(redis: SubscribeRedisClient, onEvent: (event: FiatEvent) => void): () => void {
  const subscription = redis.subscribe([EVENTS_CHANNEL]);

  subscription.on("message", (message: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as FiatEvent).requestId === "string" &&
      typeof (parsed as FiatEvent).state === "string"
    ) {
      onEvent(parsed as FiatEvent);
    }
  });

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    void subscription.unsubscribe();
  };
}
