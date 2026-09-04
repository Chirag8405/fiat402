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
 *     previously by the dashboard's SSE relay (retired -- the dashboard now
 *     polls apps/dashboard/app/api/events/route.ts instead of holding an SSE
 *     connection open, since Vercel doesn't suit either a long-lived
 *     connection or the merchant's bounded wait reliably).
 *
 * `EVENTS_RECENT_LIST` is a second, additive persistence path alongside the
 * `fiat402:events` pub/sub channel above: not in CLAUDE.md's original
 * "Redis key schema" table (same situation as state-machine.ts's two
 * reverse-index keys documented in that file's top-of-file comment -- added
 * after the fact, treated as part of the authoritative schema, documented at
 * its point of origin). Pub/sub alone has no history -- a subscriber only
 * sees messages published while it's connected -- which is fine for a
 * held-open SSE relay but not for a polling reader that can miss whatever
 * was published between two polls. publishEvent LPUSHes the same event onto
 * this bounded list (newest-first) and LTRIMs it to the most recent 200
 * entries so apps/dashboard/app/api/events/route.ts can catch up. No TTL: it
 * is a rolling global buffer, not a per-request key, so it isn't part of the
 * `req:{requestId}:*` TTL scheme CLAUDE.md describes.
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
  /**
   * Optional decision-layer data, attached only to the "pending" transition
   * event (see packages/scheme-upi/src/state-machine.ts's transitionState
   * `extra` parameter and apps/facilitator/src/server.ts's settlePayment).
   * Not part of CLAUDE.md's original pub/sub event schema -- added so the
   * dashboard's DecisionPanel can render real deterministic/AI data instead
   * of always showing "not available on the live event stream".
   *
   * `aiRecommendation` intentionally keeps the "approve"/"hold" vocabulary
   * ("flag" removed -- apps/facilitator/src/policy/ai-advisory.ts's
   * AdvisoryRecommendation never produces it, it was already dead here) even
   * though ai-advisory.ts's own type is now "hold"|"proceed": server.ts
   * translates "proceed" -> "approve" when publishing. That translation is a
   * deliberate, permanent compatibility shim, not a stopgap -- the dashboard
   * (DecisionPanel.tsx, app/page.tsx) already keys its UI off "approve", and
   * widening this field to accept "proceed" directly would silently change
   * that UI's behavior without touching it. Retiring "approve" in favor of
   * "proceed" end-to-end is dashboard-UI work for a separate session.
   *
   * `aiJustification` is kept (not renamed) because those same dashboard
   * call sites read it; `aiHumanSummary` carries the same content under the
   * new, forward-facing name for code migrating off `aiJustification`.
   * `aiReasoning` is a separate field, not folded into either of the above:
   * it's the short technical string meant for logs, distinct audience from
   * the human-facing `aiHumanSummary`/`aiJustification`.
   */
  aiRecommendation?: "approve" | "hold";
  aiSemanticMatch?: boolean;
  aiJustification?: string;
  aiHumanSummary?: string;
  aiReasoning?: string;
  aiProvider?: string;
  deterministicDecision?: "allowed" | "rejected";
  deterministicReason?: string;
}

export const EVENTS_CHANNEL = "fiat402:events";

/** Bounded recent-events list for pollers; see this file's top-of-file comment. */
export const EVENTS_RECENT_LIST = "fiat402:events:recent";

/** How many events EVENTS_RECENT_LIST retains, via LTRIM, on every publish. */
const EVENTS_RECENT_LIST_MAX = 200;

/**
 * Minimal publish-side Redis surface. `PUBLISH`/`LPUSH`/`LTRIM` are plain
 * Redis commands, so this works identically whether `redis` is the real
 * Upstash REST client or a fake in tests.
 */
export interface PublishRedisClient {
  publish(channel: string, message: string): Promise<number>;
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
}

/**
 * A live subscription handle. `on("message", ...)` fires once per message
 * delivered on any of the subscribed channels; `unsubscribe()` tears the
 * subscription down. Modeled on @upstash/redis's `redis.subscribe(...)`
 * return value (an SSE-backed emitter), so the real Upstash client satisfies
 * this structurally without an adapter.
 *
 * `message` is `unknown`, not `string`: @upstash/redis's real client
 * auto-deserializes SSE message payloads by default (its `Subscriber`
 * applies `JSON.parse` internally unless `automaticDeserialization: false`
 * is set, which this codebase never does -- see
 * apps/facilitator/src/server.ts's adaptUpstashClient), so a listener here
 * normally receives an already-parsed value, not raw JSON text. Declaring
 * this as `string` previously let a real bug (subscribeToEvents redundantly
 * re-JSON.parse'ing an already-parsed object, which throws and was silently
 * swallowed) slip past the type checker -- see subscribeToEvents below.
 */
export interface EventSubscription {
  on(event: "message", listener: (message: unknown, channel: string) => void): void;
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
  const message = JSON.stringify(event);
  await redis.publish(EVENTS_CHANNEL, message);
  await redis.lpush(EVENTS_RECENT_LIST, message);
  await redis.ltrim(EVENTS_RECENT_LIST, 0, EVENTS_RECENT_LIST_MAX - 1);
}

/**
 * Structural check that `value` looks like a FiatEvent (requestId/state are
 * both present and strings). The real safety net regardless of how `value`
 * got here -- freshly JSON.parse'd from a string, or passed through as
 * already-deserialized -- so an unexpected shape is caught identically on
 * either path.
 */
function isFiatEventLike(value: unknown): value is FiatEvent {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as FiatEvent).requestId === "string" &&
    typeof (value as FiatEvent).state === "string"
  );
}

/**
 * Subscribes to `fiat402:events` and invokes `onEvent` for every message
 * that parses/resolves to something FiatEvent-shaped. Malformed (non-JSON
 * text, or a value -- parsed or not -- that doesn't look like a FiatEvent)
 * messages are dropped rather than crashing the subscriber — a single bad
 * message on a shared channel must not take down every listener. Both drop
 * paths log why, so a dropped message is never a silent, unexplained miss.
 *
 * The `"error"` listener below matters for the same reason. @upstash/redis's
 * real Subscriber backs each channel with its own SSE HTTP stream and an
 * AbortController; if that stream drops for any reason other than an
 * intentional abort (network blip, connection reset, anything short of this
 * function's own unsubscribe), it dispatches an `"error"` event. Without a
 * listener for it, that event is swallowed, the stream is dead with no
 * further messages ever arriving, and the caller's own bounded timeout
 * (awaitResolution's maxTimeoutSeconds) fires as an ordinary "expired"
 * regardless of whether the publish it was waiting for actually happened --
 * indistinguishable from a genuine timeout unless the drop itself is logged.
 * Registering the handler below closes that gap, matching this function's
 * own message-side drop-and-log pattern.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToEvents(redis: SubscribeRedisClient, onEvent: (event: FiatEvent) => void): () => void {
  const subscription = redis.subscribe([EVENTS_CHANNEL]);

  subscription.on("message", (message: unknown) => {
    // @upstash/redis's real client auto-deserializes SSE message payloads by
    // default (see EventSubscription's doc comment above), so `message`
    // normally arrives here already parsed -- only JSON.parse when it's
    // actually still a string (e.g. this file's own test fakes, or a client
    // with automaticDeserialization disabled). Calling JSON.parse on a
    // non-string value coerces it via String() first, which for an object
    // produces the literal text "[object Object]" -- not valid JSON, so it
    // throws. That's the exact bug this branch fixes.
    let parsed: unknown;
    if (typeof message === "string") {
      try {
        parsed = JSON.parse(message);
      } catch (err) {
        console.error(
          `[subscribeToEvents] JSON.parse failed for message on channel "${EVENTS_CHANNEL}": ${err instanceof Error ? err.message : String(err)}; raw=${JSON.stringify(message)}`,
        );
        return;
      }
    } else {
      parsed = message;
    }

    if (!isFiatEventLike(parsed)) {
      console.error(
        `[subscribeToEvents] message on channel "${EVENTS_CHANNEL}" did not look like a FiatEvent (typeof original message=${typeof message}): ${JSON.stringify(parsed)}`,
      );
      return;
    }

    onEvent(parsed);
  });

  // Without this, a dropped SSE stream (network blip, connection reset --
  // anything short of this function's own unsubscribe) fails silently: the
  // subscription is dead, no further messages ever arrive, and the caller's
  // own bounded wait just rides out its timeout with no visibility into why.
  // See this function's doc comment above for the full mechanism.
  subscription.on("error", (err: unknown) => {
    console.error(
      `[subscribeToEvents] subscription error on channel "${EVENTS_CHANNEL}": ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    void subscription.unsubscribe();
  };
}
