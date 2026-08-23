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
 * Redis access reuses apps/facilitator's own real-deployment wiring
 * (adaptUpstashClient + redisClient), the same in-process reuse pattern
 * Module 6's merchant middleware uses for verifyPayment/settlePayment --
 * this relay shares the facilitator's Redis credentials/env, it does not
 * stand up a second client configuration.
 */

import { subscribeToEvents, type FiatEvent } from "../../../../facilitator/src/ws";
import { adaptUpstashClient } from "../../../../facilitator/src/server";
import { redisClient } from "../../../../facilitator/src/store/redis";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  const redis = adaptUpstashClient(redisClient);

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
