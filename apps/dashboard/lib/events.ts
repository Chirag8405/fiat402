/**
 * Client-safe re-exports and guards for the `fiat402:events` pub/sub schema.
 *
 * Type-only import from apps/facilitator/src/ws.ts, which is the single
 * authoritative source for this shape (see that file's top-of-file comment
 * and CLAUDE.md's "Pub/sub event schema" section). Only the *type* is
 * imported here (erased at build time) -- app/page.tsx is a client
 * component and must not pull in ws.ts's runtime code (it's fine either
 * way, ws.ts has no Node-only imports, but keeping this a type-only import
 * documents that the browser bundle has no server dependency).
 */
import type { FiatEvent, RequestState } from "../../facilitator/src/ws";

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
