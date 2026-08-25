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
 * Query param `since`: an ISO 8601 timestamp (a FiatEvent's own `timestamp`
 * field -- chosen over a synthetic index because it's already on the wire
 * and needs no extra bookkeeping). Missing or unparseable `since` is treated
 * as "no cursor yet": every event currently in the bounded list is returned
 * rather than erroring, so an absent/malformed query param degrades
 * gracefully instead of breaking the client's poll loop.
 *
 * Uses this package's own self-contained Redis client (../../../lib/redis)
 * -- no import from apps/facilitator/, per that file's own top-of-file
 * comment on why (Vercel only installs this package's own node_modules).
 *
 * Returns `{ events, cursor }`: `events` is only those newer than `since`
 * (or the full ~200-event buffer on the no-cursor/malformed path), oldest
 * first. `cursor` is the newest returned event's timestamp, or -- when
 * nothing new was found -- the original `since` (falling back to the epoch
 * when there was no `since` at all), so a client with no events yet still
 * gets a cursor to poll forward from next time.
 */

import { redisClient } from "../../../lib/redis";
import { EVENTS_RECENT_LIST, type FiatEvent } from "../../../lib/types";
import { isFiatEventShape } from "../../../lib/events";

export const runtime = "nodejs";

const EPOCH = new Date(0).toISOString();

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

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");
  const sinceMs = sinceParam ? Date.parse(sinceParam) : NaN;
  const hasValidSince = sinceParam !== null && !Number.isNaN(sinceMs);

  // LPUSH means the list is newest-first; reverse to chronological order.
  const raw = await redisClient.lrange<unknown>(EVENTS_RECENT_LIST, 0, 199);
  const events = raw
    .map(parseListItem)
    .filter((event): event is FiatEvent => event !== null)
    .reverse();

  const filtered = hasValidSince ? events.filter(event => Date.parse(event.timestamp) > sinceMs) : events;

  const cursor = filtered.length > 0 ? filtered[filtered.length - 1]!.timestamp : (sinceParam ?? EPOCH);

  return Response.json({ events: filtered, cursor });
}
