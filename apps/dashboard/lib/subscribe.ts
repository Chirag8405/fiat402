/**
 * Redis pub/sub subscription for the `fiat402:events` channel.
 *
 * Inlined equivalent of apps/facilitator/src/ws.ts's subscribeToEvents +
 * its adaptUpstashClient-derived subscribe adapter (from
 * apps/facilitator/src/server.ts), reimplemented against this package's own
 * Redis client (./redis.ts) and event types (./types.ts). This package must
 * not import anything from apps/facilitator/ -- see ./redis.ts.
 */

import type { Redis } from "@upstash/redis";
import { EVENTS_CHANNEL, type FiatEvent } from "./types";

/**
 * Subscribes to `fiat402:events` and invokes `onEvent` for every
 * successfully-parsed message. Malformed (non-JSON, or JSON that doesn't
 * look like a FiatEvent) messages are dropped rather than crashing the
 * subscriber -- a single bad message on a shared channel must not take down
 * every listener.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToEvents(redis: Redis, onEvent: (event: FiatEvent) => void): () => void {
  // Explicit <string> type param: every message the facilitator publishes
  // is JSON.stringify'd text, so TMessage is always string -- without this
  // the SDK's generic defaults it to `unknown`.
  const subscriber = redis.subscribe<string>([EVENTS_CHANNEL]);

  subscriber.on("message", (data: { channel: string; message: string }) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.message);
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
    void subscriber.unsubscribe();
  };
}
