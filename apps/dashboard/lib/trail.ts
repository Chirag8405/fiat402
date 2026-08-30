/**
 * Pure trail-reconstruction logic for ../app/page.tsx's poll loop -- lives
 * here rather than in page.tsx itself because Next's App Router only allows
 * a fixed set of special named exports from a page file (`.next/types`
 * enforces this at build time); arbitrary exported helpers there fail to
 * typecheck. Same reasoning as ../components/StateMachineViz.tsx pulling its
 * queue algorithm into exported functions: testable without a
 * component/page-rendering harness this package doesn't have.
 */

import type { FiatEvent } from "./events";

export interface RequestTrail {
  requestId: string;
  events: FiatEvent[];
}

/**
 * Rebuilds a trail from the full (sorted-ascending) events list returned by
 * GET /api/events -- called fresh on every poll rather than accumulated
 * incrementally (see that route's top-of-file comment for why the old
 * cursor-based incremental version was unsafe). `events` interleaves
 * multiple past requests (the bounded list retains up to 200 entries across
 * demo runs); the last entry is the most recently published event
 * system-wide, so its requestId is "current" -- the same heuristic the old
 * incremental version implicitly used (whichever request's event was most
 * recently applied).
 *
 * Dedup key is (requestId, state): once filtered to one requestId, deduping
 * on `state` alone is equivalent. Keeps the first (earliest) occurrence --
 * a real edge case (the UPI retry: approved -> declined -> approved again)
 * would collapse to showing only the first "approved," not visualizing the
 * retry's second approval distinctly. Accepted tradeoff for keeping this
 * simple at demo scale, per the same reasoning that justified dropping the
 * cursor mechanism in favor of full-list refetching.
 */
export function reconstructTrail(events: FiatEvent[]): RequestTrail | null {
  if (events.length === 0) return null;

  const currentRequestId = events[events.length - 1]!.requestId;
  const seenStates = new Set<string>();
  const deduped: FiatEvent[] = [];
  for (const event of events) {
    if (event.requestId !== currentRequestId) continue;
    if (seenStates.has(event.state)) continue;
    seenStates.add(event.state);
    deduped.push(event);
  }

  return { requestId: currentRequestId, events: deduped };
}

/**
 * Whether two trails represent the same data -- used to keep a trail's
 * object reference stable across polls that reconstruct an identical trail
 * from scratch. Without this, rebuilding fresh every poll would produce a
 * brand-new object regardless of whether anything changed, which would
 * break anything downstream relying on reference stability (page.tsx's
 * Reset/Show-last `useEffect`, keyed on `[trail]`, would snap back to "live"
 * on every single poll tick instead of only when real new data arrives).
 */
export function trailsEqual(a: RequestTrail | null, b: RequestTrail | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.requestId !== b.requestId || a.events.length !== b.events.length) return false;
  return a.events.every((event, i) => event.state === b.events[i]?.state && event.timestamp === b.events[i]?.timestamp);
}
