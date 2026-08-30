/**
 * GET /api/events -- polling endpoint over the bounded `fiat402:events:recent`
 * Redis list (see ../../../lib/types.ts's EVENTS_RECENT_LIST and
 * apps/facilitator/src/ws.ts's publishEvent, which LPUSHes/LTRIMs it
 * alongside every `fiat402:events` pub/sub publish).
 *
 * Replaces the former SSE relay at app/api/stream/route.ts (deleted) -- a
 * held-open connection doesn't fit Vercel's serverless model reliably, so
 * the dashboard now polls this route instead of subscribing.
 *
 * No `since`/cursor parameter, deliberately -- this route always returns the
 * FULL current contents of the bounded list (sorted, deduped downstream in
 * app/page.tsx), not just events newer than some client-supplied watermark.
 *
 * An earlier cursor-based version filtered to `timestamp > since` and
 * advanced the cursor to the max timestamp seen each poll. That's unsafe:
 * two independent, unsynchronized publishers can append to this same list
 * concurrently (e.g. razorpay/webhook-handler.ts's "approved" transition and
 * server.ts's subsequent "settled" transition, triggered the instant
 * awaitResolution's pub/sub subscriber sees "approved" -- which can complete
 * its own LPUSH before the "approved" publisher's LPUSH, still in flight on
 * a separate REST call, actually lands). If a poll's LRANGE snapshot caught
 * "settled" but not yet "approved" (still landing), the cursor would advance
 * past "settled"'s timestamp -- and once "approved" (an earlier timestamp)
 * did land, `timestamp > cursor` would exclude it from every future poll,
 * permanently, not just delay it. Sorting the events within one snapshot
 * (still done below) can't fix data that simply wasn't in that snapshot yet.
 *
 * Fetching the full bounded list every poll removes that failure mode
 * entirely: nothing is ever permanently excluded by a watermark, only
 * re-sent until it ages out of the 200-entry LTRIM window. This trades a
 * small amount of extra payload per poll (a small, bounded list) for
 * correctness -- appropriate at this app's demo scale, not worth a more
 * complex ordering guarantee (e.g. sequence numbers).
 *
 * Uses this package's own self-contained Redis client (../../../lib/redis)
 * -- no import from apps/facilitator/, per that file's own top-of-file
 * comment on why (Vercel only installs this package's own node_modules).
 */

import { redisClient } from "../../../lib/redis";
import { EVENTS_RECENT_LIST, type FiatEvent } from "../../../lib/types";
import { isFiatEventShape } from "../../../lib/events";

export const runtime = "nodejs";

/**
 * Parses one Redis list entry into a FiatEvent. `@upstash/redis` tries to
 * JSON-deserialize list members automatically, so `item` is normally already
 * an object by the time it gets here -- but a raw JSON string is handled too
 * (e.g. if automatic deserialization is ever disabled), same defensive shape
 * as apps/facilitator/src/ws.ts's subscribeToEvents used for its own
 * pub/sub messages.
 */
function parseListItem(item: unknown): FiatEvent | null {
  let candidate: unknown = item;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return isFiatEventShape(candidate) ? candidate : null;
}

export async function GET(): Promise<Response> {
  // LPUSH order is NOT trustworthy as chronological order (see this file's
  // top comment) -- sort by each event's own `timestamp` regardless of the
  // order they came back from LRANGE.
  const raw = await redisClient.lrange<unknown>(EVENTS_RECENT_LIST, 0, 199);
  const events = raw
    .map(parseListItem)
    .filter((event): event is FiatEvent => event !== null)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  return Response.json({ events });
}
