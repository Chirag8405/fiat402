/**
 * Shared confirm-gate primitives: the `confirm-gate:{requestId}` key and the
 * `fiat402:confirm-gate` pub/sub channel that satisfies a live
 * awaitConfirmGate call (./server.ts) the instant a human decides to let a
 * held request proceed.
 *
 * A human can express that decision in two different places:
 *   - POST /internal/confirm-gate/:requestId (./server.ts) -- an explicit
 *     confirmation action.
 *   - Paying the Payment Link directly, observed via the payment.captured/
 *     payment_link.paid webhook (./razorpay/webhook-handler.ts) -- paying is
 *     itself a valid form of "a human decided," even without an explicit
 *     confirm-gate call.
 *
 * Both call satisfyConfirmGate below rather than duplicating the set+publish
 * logic, so the two writers can never drift out of sync on the message
 * shape or channel name. This is a deliberate, narrow exception to
 * webhook-handler.ts's usual "inline my own copy, no dependency on sibling
 * modules" pattern (see that file's top-of-file comment): that pattern
 * exists to avoid coupling to modules with unrelated concerns, not to rule
 * out a fresh, single-purpose, dependency-free module shared by exactly the
 * two places that must stay in lockstep with each other.
 */

export const CONFIRM_GATE_CHANNEL = "fiat402:confirm-gate";

export interface ConfirmGateMessage {
  requestId: string;
}

/**
 * `confirm-gate:{requestId}` — the demo-hook confirmation flag from
 * CLAUDE.md's Redis key schema section.
 */
export function confirmGateKey(requestId: string): string {
  return `confirm-gate:${requestId}`;
}

/** Minimal Redis surface satisfyConfirmGate needs -- satisfied structurally by both FacilitatorRedisClient and WebhookRedisClient. */
export interface ConfirmGateRedisClient {
  set(key: string, value: string, mode?: "KEEPTTL"): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
}

/**
 * Flips confirm-gate:{requestId} to "1" and publishes on
 * CONFIRM_GATE_CHANNEL, satisfying it for any live awaitConfirmGate call.
 *
 * Naturally idempotent: setting "1" over an existing "1" is a no-op, and a
 * second publish is harmless -- a resolved awaitConfirmGate call ignores
 * further messages (its own `settled` guard), and if nothing is waiting
 * (e.g. this request was never a hold), publishing has no effect at all.
 */
export async function satisfyConfirmGate(redis: ConfirmGateRedisClient, requestId: string): Promise<void> {
  await redis.set(confirmGateKey(requestId), "1");
  await redis.publish(CONFIRM_GATE_CHANNEL, JSON.stringify({ requestId } satisfies ConfirmGateMessage));
}
