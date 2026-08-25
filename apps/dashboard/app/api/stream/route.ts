/**
 * SSE relay: forwards every event on the `fiat402:events` Redis channel to
 * connected browsers, unfiltered, via apps/facilitator/src/ws.ts's
 * subscribeToEvents -- exactly the consumer that file's own top-of-file
 * comment names: "(Module 7) by the dashboard's SSE relay, which subscribes
 * unfiltered and forwards every event to connected browsers."
 *
 * Uses the ReadableStream + `new Response(stream, { headers: {...} })`
 * pattern, which is the correct Next.js App Router SSE approach -- NOT
 * `res.write`/`res.flush`/any Node `http.ServerResponse` API, which does not
 * work in App Router route handlers (there is no `res` object here).
 *
 * Redis access reuses apps/facilitator's own real-deployment client
 * (redisClient from store/redis.ts) so this relay shares the facilitator's
 * Redis credentials/env instead of standing up a second configuration.
 * It does NOT import apps/facilitator/src/server.ts -- that module
 * transitively pulls in express, cors, razorpay, pg, and dotenv, none of
 * which are dependencies of this package. Only the tiny subscribe-side
 * adapter it would have provided (the @upstash/redis -> ws.ts
 * SubscribeRedisClient shape) is reimplemented locally below.
 */

import { subscribeToEvents, type EventSubscription, type FiatEvent, type SubscribeRedisClient } from "../../../../facilitator/src/ws";
import { redisClient } from "../../../../facilitator/src/store/redis";

export const runtime = "nodejs";

/**
 * Adapts the real @upstash/redis client to ws.ts's SubscribeRedisClient
 * shape: the SDK's "message" event delivers a single { channel, message }
 * object, while SubscribeRedisClient expects the two-argument
 * (message, channel) form. Mirrors the subscribe-side of
 * apps/facilitator/src/server.ts's adaptUpstashClient, reimplemented here
 * rather than imported so this route never pulls in server.ts's dependencies.
 */
function adaptSubscribeClient(client: typeof redisClient): SubscribeRedisClient {
  return {
    subscribe: (channels: string[]): EventSubscription => {
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

export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  const redis = adaptSubscribeClient(redisClient);

  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: FiatEvent): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      unsubscribe = subscribeToEvents(redis, send);

      // Client disconnect (browser closed tab, EventSource torn down, etc.)
      // surfaces as an abort on the request's signal in App Router route
      // handlers -- this is what tears the Redis subscription down again so
      // it doesn't leak past the SSE connection's lifetime.
      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        unsubscribe = null;
        try {
          controller.close();
        } catch {
          // Already closed -- nothing to do.
        }
      });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
