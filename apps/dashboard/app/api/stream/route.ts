/**
 * SSE relay: forwards every event on the `fiat402:events` Redis channel to
 * connected browsers, unfiltered, via ../../../lib/subscribe.ts's
 * subscribeToEvents (an inlined equivalent of apps/facilitator/src/ws.ts's
 * subscribeToEvents -- the consumer that file's own top-of-file comment
 * names: "(Module 7) by the dashboard's SSE relay, which subscribes
 * unfiltered and forwards every event to connected browsers.")
 *
 * Uses the ReadableStream + `new Response(stream, { headers: {...} })`
 * pattern, which is the correct Next.js App Router SSE approach -- NOT
 * `res.write`/`res.flush`/any Node `http.ServerResponse` API, which does not
 * work in App Router route handlers (there is no `res` object here).
 *
 * This route (and everything it imports) is entirely self-contained within
 * apps/dashboard/ -- no imports from apps/facilitator/ anywhere. Vercel only
 * installs this package's own node_modules, so a cross-package import that
 * reached into the facilitator app would drag in dependencies (express,
 * cors, razorpay, pg, dotenv) this package doesn't declare and can't build
 * with.
 */

import { redisClient } from "../../../lib/redis";
import { subscribeToEvents } from "../../../lib/subscribe";
import type { FiatEvent } from "../../../lib/types";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: FiatEvent): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      unsubscribe = subscribeToEvents(redisClient, send);

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
