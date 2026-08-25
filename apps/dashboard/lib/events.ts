/**
 * Client-safe re-exports and guards for the `fiat402:events` pub/sub schema.
 *
 * Types come from ./types.ts, a copy of apps/facilitator/src/ws.ts's shapes
 * (see that file's top-of-file comment and CLAUDE.md's "Pub/sub event
 * schema" section) kept in this package rather than imported across
 * packages -- apps/dashboard/ must have zero imports into apps/facilitator/
 * so Vercel's dashboard-only install doesn't miss a dependency.
 */
import type { FiatEvent, RequestState } from "./types";

export type { FiatEvent, RequestState };

/** Every state the schema defines, per CLAUDE.md's "State machine" section. */
export const KNOWN_STATES: readonly RequestState[] = [
  "created",
  "pending",
  "approved",
  "declined",
  "expired",
  "settled",
  "failed",
];

export function isKnownState(state: string): state is RequestState {
  return (KNOWN_STATES as readonly string[]).includes(state);
}

/**
 * Structural check that `value` looks like a `FiatEvent` -- mirrors
 * ws.ts's subscribeToEvents' own runtime check (requestId/state are
 * strings), so a malformed SSE payload is dropped client-side the same way
 * a malformed pub/sub message is dropped server-side, rather than crashing
 * the page.
 */
export function isFiatEventShape(value: unknown): value is FiatEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FiatEvent>;
  return (
    typeof candidate.requestId === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.timestamp === "string" &&
    (candidate.previousState === null || typeof candidate.previousState === "string") &&
    typeof candidate.meta === "object" &&
    candidate.meta !== null
  );
}
