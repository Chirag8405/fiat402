/**
 * Shared key-naming/TTL for PAYMENT-RESPONSE capture, split out so the
 * writer (app/api/simulate/route.ts, inside its deferred `after()` call)
 * and the reader (app/api/simulate/payment-response/[razorpayPaymentId]/
 * route.ts) can't drift on the key format -- same reasoning as
 * apps/facilitator/src/ws.ts's EVENTS_RECENT_LIST being defined once and
 * imported everywhere.
 *
 * WHY THIS IS KEYED BY razorpayPaymentId, NOT requestId: `after()` runs
 * server-side, after the simulate route's own HTTP response has already
 * closed -- there's no browser context to write into (that's why this can't
 * reuse Part A's sessionStorage mechanism), and it needs genuine
 * server-side persistence. But the requestId a simulate run will produce is
 * never knowable to this app at all (the facilitator mixes in a random UUID
 * we never see -- see app/api/simulate/route.ts's top comment), including
 * inside `after()` itself. `razorpayPaymentId` (the decoded
 * PAYMENT-RESPONSE body's `transaction` field on success) is the one piece
 * of identifying data both this write path AND the live FiatEvent stream
 * (meta.razorpayPaymentId, already read by app/page.tsx as
 * `liveRazorpayPaymentId`) independently observe -- it's the natural join
 * key. On a FAILED settlement the merchant never stamps PAYMENT-RESPONSE at
 * all (confirmed by reading apps/merchant/lib/x402-middleware.ts -- that
 * header is only set on the success branch), so there's nothing to write in
 * that case, not a gap in this design.
 *
 * Not reused from Postgres/the facilitator's reconciliation_records table:
 * the facilitator itself never sees PAYMENT-RESPONSE at all -- it's stamped
 * by the merchant on its response to the agent, a hop the facilitator has
 * no visibility into. There's nothing to "reuse" there.
 */

export const PAYMENT_RESPONSE_TTL_SECONDS = 600;

export function paymentResponseKey(razorpayPaymentId: string): string {
  return `fiat402:simulate:payment-response:${razorpayPaymentId}`;
}
